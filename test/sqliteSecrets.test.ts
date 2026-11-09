import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqliteSecretStorage } from "../src/storage/sqliteSecrets";
import { SqliteStateStore } from "../src/storage/sqliteState";
import { removeTestDirectory } from "./testFilesystem";

let root: string, store: SqliteStateStore, subscriptions: vscode.Disposable[];
const legacy = (values = new Map<string, string>()) => ({
  keys: vi.fn(async () => [...values.keys()]), get: vi.fn(async (key: string) => values.get(key)),
  store: vi.fn(), delete: vi.fn()
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "manager-shared-secrets-"));
  store = await SqliteStateStore.open(join(root, "manager.sqlite"));
  subscriptions = [];
});
afterEach(async () => {
  subscriptions.forEach(item => item.dispose()); store.close();
  Reflect.deleteProperty(vscode.env, "appHost"); vi.restoreAllMocks(); await removeTestDirectory(root);
});

it("copies every old login once, preserves its source, and writes only to SQLite", async () => {
  const values = new Map(Array.from({ length: 14 }, (_, index) => [`codex.account.${index}`, `credentials-${index}`]));
  const source = legacy(values);
  const secrets = await createSqliteSecretStorage(store, source as never, subscriptions);
  expect(await secrets.keys()).toHaveLength(14);
  expect(store.get("migrations", "vscode-secrets-v1")).toBe(true);
  await secrets.store("codex.account.0", "new-login");
  await secrets.delete("codex.account.1");
  const reopened = await createSqliteSecretStorage(store, source as never, subscriptions);
  expect(await reopened.get("codex.account.0")).toBe("new-login");
  expect(await reopened.get("codex.account.1")).toBeUndefined();
  expect(values.size).toBe(14);
  expect(source.keys).toHaveBeenCalledOnce();
  expect(source.store).not.toHaveBeenCalled(); expect(source.delete).not.toHaveBeenCalled();
});

it("retries a partial migration while preserving already copied and newer credentials", async () => {
  const source = legacy(new Map([["one", "old-one"], ["two", "old-two"]]));
  source.get.mockRejectedValueOnce(new Error("Storage unavailable"));
  const secrets = await createSqliteSecretStorage(store, source as never, subscriptions);
  expect(store.get("migrations", "vscode-secrets-v1")).toBeUndefined();
  expect(await secrets.get("two")).toBe("old-two");
  await secrets.store("two", "new-two");
  const retried = await createSqliteSecretStorage(store, source as never, subscriptions);
  expect(await retried.get("one")).toBe("old-one");
  expect(await retried.get("two")).toBe("new-two");
  expect(store.get("migrations", "vscode-secrets-v1")).toBe(true);
});

it.each([false, true])("keeps a concurrent %s write ahead of a delayed legacy read", async deleted => {
  let resolve!: (value: string) => void;
  const source = { get: vi.fn(() => new Promise<string>(done => { resolve = done; })) };
  const secrets = await createSqliteSecretStorage(store, source as never, subscriptions);
  const read = secrets.get("login");
  if (deleted) await secrets.delete("login"); else await secrets.store("login", "current");
  resolve("stale");
  expect(await read).toBe(deleted ? undefined : "current");
});

it("migrates earlier Node records without completing the VS Code migration", async () => {
  Object.defineProperty(vscode.env, "appHost", { configurable: true, value: "node" });
  store.set("node-secrets", "login", "node-login");
  store.set("node-secrets", "removed", "old-login");
  store.set("secrets", "removed", null);
  const source = legacy(new Map([["vscode-login", "editor-only"]]));
  const secrets = await createSqliteSecretStorage(store, source as never, subscriptions);
  expect(await secrets.get("login")).toBe("node-login");
  expect(await secrets.get("removed")).toBeUndefined();
  expect(store.get("migrations", "vscode-secrets-v1")).toBeUndefined();
  expect(source.keys).not.toHaveBeenCalled();
});

it("notifies readers when another host rotates credentials", async () => {
  const secrets = await createSqliteSecretStorage(store, legacy() as never, subscriptions);
  const changed = vi.fn(); subscriptions.push(secrets.onDidChange(changed));
  const other = await SqliteStateStore.open(store.file);
  try {
    other.set("secrets", "login", "rotated");
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith({ key: "login" }), { timeout: 2000 });
    expect(await secrets.get("login")).toBe("rotated");
  } finally { other.close(); }
});

it("does not claim success or fall back to an old credential after a storage failure", async () => {
  const source = legacy(new Map([["login", "old"]]));
  const secrets = await createSqliteSecretStorage(store, source as never, subscriptions);
  vi.spyOn(store, "set").mockImplementationOnce(() => { throw new Error("SQLITE_FULL"); });
  await expect(secrets.store("login", "new")).rejects.toThrow("SQLITE_FULL");
  expect(await secrets.get("login")).toBe("old");
  expect(source.store).not.toHaveBeenCalled();
});
