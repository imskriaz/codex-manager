import * as path from "path";
import { createHash, randomUUID } from "crypto";
import * as vscode from "vscode";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";
import { configureSqliteStateStore, createSqliteMemento, SqliteStateStore } from "./sqliteState";

const WORKSPACE_ID_KEY = "codexManager.sqliteWorkspaceId";
let configurationNamespace: string | undefined;
let configurationStore: SqliteStateStore | undefined;
let configurationKeys: string[] = [];

export async function initializeSqliteContext(context: vscode.ExtensionContext): Promise<vscode.ExtensionContext> {
  const store = await SqliteStateStore.open(path.join(getCodexManagerStorageRoot(), "codex-manager.sqlite"));
  try {
    let workspaceId = context.storageUri?.fsPath ?? context.workspaceState.get<string>(WORKSPACE_ID_KEY);
    if (!workspaceId) {
      workspaceId = randomUUID();
      await context.workspaceState.update(WORKSPACE_ID_KEY, workspaceId);
    }
    const scope = createHash("sha256").update(workspaceId).digest("hex");
    const globalState = createSqliteMemento(store, "global", context.globalState);
    const workspaceState = createSqliteMemento(store, `workspace:${scope}`, context.workspaceState);
    configurationNamespace = `settings:${scope}`;
    configurationStore = store;
    const manifest = context.extension.packageJSON as { contributes: { configuration: { properties: Record<string, unknown> } } };
    configurationKeys = Object.keys(manifest.contributes.configuration.properties).map(key => key.slice("codexManager.".length));
    synchronizeSqliteConfiguration();
    configureSqliteStateStore(store);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration("codexManager")) return;
      try { synchronizeSqliteConfiguration(); } catch (error) {
        console.error("[codexManager] settings could not be saved to SQLite", error);
        void vscode.window.showWarningMessage(`Settings could not be saved to SQLite. Retry the setting change: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    return Object.create(context, { globalState: { value: globalState }, workspaceState: { value: workspaceState } }) as vscode.ExtensionContext;
  } catch (error) {
    configurationNamespace = undefined;
    configurationStore = undefined;
    store.close();
    throw error;
  }
}

function synchronizeSqliteConfiguration(): void {
  const store = configurationStore;
  const namespace = configurationNamespace;
  if (!store || !namespace) return;
  const config = vscode.workspace.getConfiguration("codexManager");
  store.transaction(() => {
    for (const key of configurationKeys) {
      const value = config.get(key);
      if (JSON.stringify(store.get(namespace, key)) !== JSON.stringify(value)) store.set(namespace, key, value);
    }
  });
}

export function sqliteConfiguration(config: vscode.WorkspaceConfiguration): vscode.WorkspaceConfiguration {
  const store = configurationStore;
  const namespace = configurationNamespace;
  if (!store || !namespace) return config;
  return new Proxy(config, {
    get: (target, property) => {
      if (property === "get") return <T>(key: string, fallback?: T): T | undefined => {
        const value = store.get<T>(namespace, key);
        return value === undefined ? target.get<T>(key, fallback as T) : value;
      };
      if (property === "update") return async (...args: Parameters<vscode.WorkspaceConfiguration["update"]>) => {
        await target.update(...args);
        synchronizeSqliteConfiguration();
      };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) as unknown : value;
    }
  });
}

export function disposeSqliteContext(): void {
  configurationStore?.close();
  configurationStore = undefined;
  configurationNamespace = undefined;
  configurationKeys = [];
}
