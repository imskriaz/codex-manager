import * as vscode from "vscode";
import type { SqliteStateStore } from "./sqliteState";
import { waitWithin } from "../utils/concurrency";

const NAMESPACE = "secrets";
const MIGRATION = "vscode-secrets-v1";

/** SQLite is authoritative in both hosts; legacy stores are read only during migration. */
export async function createSqliteSecretStorage(store: SqliteStateStore, legacy: vscode.SecretStorage | undefined, subscriptions: vscode.Disposable[]): Promise<vscode.SecretStorage> {
  const listeners = new Set<(event: vscode.SecretStorageChangeEvent) => unknown>();
  const snapshot = () => new Map(store.keys(NAMESPACE).map(key => [key, store.get<string | null>(NAMESPACE, key)]));
  store.transaction(() => {
    for (const key of store.keys("node-secrets")) {
      if (store.get(NAMESPACE, key) === undefined) store.set(NAMESPACE, key, store.get("node-secrets", key));
    }
  });
  let known = snapshot();
  const notify = () => {
    const next = snapshot();
    const changed = [...new Set([...known.keys(), ...next.keys()])].filter(key => known.get(key) !== next.get(key));
    known = next;
    for (const key of changed) for (const listener of listeners) {
      try { listener({ key }); } catch { /* A listener cannot invalidate a committed credential. */ }
    }
  };
  const readLegacy = async (key: string): Promise<string | undefined> => {
    const current = store.get<string | null>(NAMESPACE, key);
    if (current !== undefined) return current ?? undefined;
    if (!legacy || vscode.env.appHost === "node" || store.get<boolean>("migrations", MIGRATION)) return undefined;
    const value = await waitWithin(Promise.resolve(legacy.get(key)), 2_000, "Legacy credential storage did not respond. Reload VS Code to retry migration.");
    // A new login or deletion committed while the old store was loading wins.
    store.transaction(() => { if (store.get(NAMESPACE, key) === undefined) store.set(NAMESPACE, key, value ?? null); });
    notify();
    return store.get<string | null>(NAMESPACE, key) ?? undefined;
  };
  subscriptions.push({ dispose: () => listeners.clear() }, { dispose: store.subscribe(["secrets"], notify) });
  if (vscode.env.appHost !== "node" && !store.get<boolean>("migrations", MIGRATION) && typeof legacy?.keys === "function") {
    try {
      const keys = await waitWithin(Promise.resolve(legacy.keys()), 2_000, "Legacy credential keys did not load.");
      const migrated = await Promise.allSettled(keys.map(readLegacy));
      if (migrated.every(result => result.status === "fulfilled")) store.set("migrations", MIGRATION, true);
      else throw new Error("Some credentials could not be copied.");
    } catch {
      void vscode.window.showWarningMessage("Credential migration is incomplete. Existing accounts were kept. Reload VS Code to retry before closing it for standalone use.");
    }
  }
  return {
    keys: () => Promise.resolve(store.keys(NAMESPACE).filter(key => store.get(NAMESPACE, key) !== null)),
    get: readLegacy,
    store: (key, value) => Promise.resolve().then(() => { store.set(NAMESPACE, key, value); notify(); }),
    // A tombstone prevents an older retained secret from reviving a removed login.
    delete: key => Promise.resolve().then(() => { store.set(NAMESPACE, key, null); notify(); }),
    onDidChange: (listener, thisArgs, disposables) => {
      const bound = listener.bind(thisArgs);
      listeners.add(bound);
      const disposable = { dispose: () => { listeners.delete(bound); } };
      disposables?.push(disposable);
      return disposable;
    }
  };
}
