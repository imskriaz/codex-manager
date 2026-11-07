import * as path from "path";
import * as vscode from "vscode";
import { initializeSqliteContextWithRetry } from "./storage/sqliteContext";
import { getSqliteStateStore } from "./storage/sqliteState";
import { AccountsRepository } from "./storage";
import { WebDashboardServer } from "./services/webDashboardServer";

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
  const packageJSON = require(path.join(extensionRoot, "package.json")) as Record<string, unknown>;
  return {
    extensionUri: uri,
    extension: { packageJSON, extensionUri: uri },
    extensionPath: extensionRoot,
    storageUri: vscode.Uri.file(process.env["CODEX_MANAGER_STORAGE_ROOT"] ?? extensionRoot),
    globalStorageUri: uri,
    globalState: createMemento(),
    workspaceState: createMemento(),
    secrets: createNodeSecretStorage(),
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

export async function startNodeHost(): Promise<void> {
  const context = await initializeSqliteContextWithRetry(createContext());
  const repo = new AccountsRepository(context);
  await repo.init();
  const dashboard = new WebDashboardServer(context, repo);
  await dashboard.start();
  const shutdown = async (): Promise<void> => {
    dashboard.dispose();
    repo.dispose();
    const store = getSqliteStateStore();
    store?.close();
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
  console.log(`Codex Manager Node host listening at ${dashboard.getUrl()}`);
}

if (require.main === module) {
  startNodeHost().catch((error) => {
    console.error(`[codexManager] Node host failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
