/* eslint-disable @typescript-eslint/require-await -- Host adapters expose promise APIs over synchronous storage and cleanup. */
import { readFileSync } from "node:fs";
import * as path from "path";
import * as vscode from "vscode";
import { initializeSqliteContextWithRetry } from "./storage/sqliteContext";
import { deleteSqliteStateFile, getSqliteStateStore, readSqliteStateFile, writeSqliteStateFile } from "./storage/sqliteState";
import { AccountsRepository } from "./storage";
import { WebDashboardServer } from "./services/webDashboardServer";
import { configureCrossWindowOperationCoordinator } from "./utils/crossWindowOperations";
import { getCodexManagerStorageRoot } from "./utils/storageRoot";

type NodeSecretStorage = vscode.SecretStorage;

function createNodeSecretStorage(): NodeSecretStorage {
  const listeners = new Set<(event: { key: string }) => void>();
  const getStore = () => {
    const store = getSqliteStateStore();
    if (!store) throw new Error("Manager SQLite is not initialized.");
    return store;
  };
  return {
    keys: async () => getStore().keys("node-secrets"),
    get: async (key) => getStore().get<string>("node-secrets", key),
    store: async (key, value) => {
      getStore().set("node-secrets", key, value);
      for (const listener of listeners) listener({ key });
    },
    delete: async (key) => {
      getStore().set("node-secrets", key, undefined);
      for (const listener of listeners) listener({ key });
    },
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }
  } as NodeSecretStorage;
}

function createMemento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, value); }
  };
}

function createContext(): vscode.ExtensionContext {
  const extensionRoot = path.resolve(__dirname, "..");
  const uri = vscode.Uri.file(extensionRoot);
  const packageJSON = JSON.parse(readFileSync(path.join(extensionRoot, "package.json"), "utf8")) as Record<string, unknown>;
  return {
    extensionUri: uri,
    extension: { packageJSON, extensionUri: uri },
    extensionPath: extensionRoot,
    storageUri: vscode.Uri.file(process.env["CODEX_MANAGER_WORKSPACE_STORAGE"] ?? process.env["CODEX_MANAGER_STORAGE_ROOT"] ?? extensionRoot),
    globalState: createMemento(),
    workspaceState: createMemento(),
    secrets: createNodeSecretStorage(),
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

export async function startNodeHost(): Promise<void> {
  const context = await initializeSqliteContextWithRetry(createContext());
  const repo = new AccountsRepository(context);
  const dashboard = new WebDashboardServer(context, repo, undefined, { failOnAddressInUse: true });
  const pidFile = process.env["CODEX_MANAGER_PID_FILE"];
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => closing ??= (async () => {
    await dashboard.stop();
    dashboard.dispose();
    repo.dispose();
    if (pidFile) {
      try { if (readSqliteStateFile(pidFile) === String(process.pid)) deleteSqliteStateFile(pidFile); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const subscription of context.subscriptions) subscription.dispose();
    getSqliteStateStore()?.close();
  })();
  const exit = (): void => { void shutdown().then(() => process.exit(0), error => { console.error("[codexManager] Node shutdown failed", error); process.exit(1); }); };
  process.once("SIGINT", exit);
  process.once("SIGTERM", exit);
  try {
    await configureCrossWindowOperationCoordinator(getCodexManagerStorageRoot());
    await repo.init();
    const deadline = Date.now() + (process.env["CODEX_MANAGER_HANDOFF"] === "1" ? 8_000 : 0);
    for (;;) {
      try { await dashboard.start(); break; }
      catch (error) {
        if (closing || Date.now() >= deadline || !(error instanceof Error) || !error.message.includes("already owned by another host")) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    if (pidFile) writeSqliteStateFile(pidFile, String(process.pid));
  } catch (error) {
    await shutdown();
    process.removeListener("SIGINT", exit);
    process.removeListener("SIGTERM", exit);
    throw error;
  }
  console.log(`Codex Manager Node host listening at ${dashboard.getUrl()}`);
  if (process.send) process.send({ type: "codex-manager-ready", url: dashboard.getUrl() });
}

if (require.main === module) {
  startNodeHost().catch((error) => {
    console.error(`[codexManager] Node host failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
