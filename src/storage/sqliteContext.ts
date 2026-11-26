import * as path from "path";
import { createHash } from "crypto";
import * as vscode from "vscode";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";
import { configureSqliteStateStore, createSqliteMemento, SqliteStateStore } from "./sqliteState";
import { migrateManagerStorage } from "./storageMigration";
import { fireSqliteConfigurationChanges } from "./configurationEvents";
import { migrateRelayStartup } from "../utils/relayStartup";
import { createSqliteSecretStorage } from "./sqliteSecrets";
import { configureOfficeStorage } from './officeStorageMigration';

const WORKSPACE_ID_KEY = "codexManager.sqliteWorkspaceId";
let configurationNamespace: string | undefined;
let configurationStore: SqliteStateStore | undefined;
let officeStorage: ReturnType<typeof configureOfficeStorage> | undefined;
let configurationKeys: string[] = [];
type SettingSchema = { type: string; enum?: unknown[]; minimum?: number; maximum?: number; multipleOf?: number };
let configurationSchema: Record<string, SettingSchema> = {};
let configurationSnapshot = new Map<string, string | undefined>();
const configurationBatches=new WeakMap<vscode.WorkspaceConfiguration,(updates:ReadonlyArray<readonly [string,unknown]>)=>void>();

/** Dashboard forms commit all SQLite settings together, before change listeners run. */
export async function updateConfigurationBatch(config:vscode.WorkspaceConfiguration,updates:ReadonlyArray<readonly [string,unknown]>):Promise<void>{
  const write=configurationBatches.get(config);if(write){write(updates);return;}
  const saved=updates.map(([key])=>[key,config.inspect?config.inspect(key)?.globalValue:config.get(key)] as const),written:string[]=[];
  try{for(const [key,value] of updates){written.push(key);await config.update(key,value,vscode.ConfigurationTarget.Global);}}
  catch(error){let incomplete=false;for(const [key,value] of saved.reverse())if(written.includes(key))try{await config.update(key,value,vscode.ConfigurationTarget.Global);}catch{incomplete=true;}
    if(incomplete)throw new Error(`${error instanceof Error?error.message:'Settings could not be saved.'} Settings could not be rolled back completely; reload settings and review the saved values.`);throw error;}
}

export async function initializeSqliteContextWithRetry(context: vscode.ExtensionContext): Promise<vscode.ExtensionContext> {
  for (let attempt = 0; ; attempt++) {
    try { return await initializeSqliteContext(context); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (attempt >= 2 || !/SQLITE_BUSY|SQLITE_LOCKED|EAGAIN|EACCES|EPERM|EIO|database is locked|storage migration.*(?:running|progress)|unable to open database|cannot open database/i.test(`${code ?? ""} ${message}`)) throw error;
      console.warn("[codexManager] storage startup delayed; retrying", { attempt: attempt + 1, code });
      await new Promise<void>(resolve => setTimeout(resolve, attempt ? 1_000 : 250));
    }
  }
}

export async function initializeSqliteContext(context: vscode.ExtensionContext): Promise<vscode.ExtensionContext> {
  const root = getCodexManagerStorageRoot();
  await migrateManagerStorage(root, context.extensionUri ? () => migrateRelayStartup(root, context.extensionUri.fsPath) : undefined);
  const store = await SqliteStateStore.open(path.join(getCodexManagerStorageRoot(), "manager.sqlite"));
  try {
    const workspaceId = context.storageUri?.fsPath ?? context.workspaceState.get<string>(WORKSPACE_ID_KEY) ?? vscode.env.sessionId;
    if (!workspaceId) throw new Error("VS Code did not provide a stable window identity. Reload the window to retry.");
    const scope = createHash("sha256").update(workspaceId).digest("hex");
    const globalState = createSqliteMemento(store, "global", context.globalState);
    const workspaceState = createSqliteMemento(store, `workspace:${scope}`, context.workspaceState);
    configurationNamespace = `settings:${scope}`;
    configurationStore = store;
    const manifest = context.extension.packageJSON as { contributes: { configuration: { properties: Record<string, SettingSchema> } } };
    configurationSchema = manifest.contributes.configuration.properties;
    configurationKeys = Object.keys(manifest.contributes.configuration.properties).map(key => key.slice("codexManager.".length));
    const legacyModules: Array<'codex' | 'claude'> = [];
    if (!store.get('migrations', `${scope}:runtime-modules`)) {
      const legacyWorkspace = readConfigurationValue<boolean>(store, configurationNamespace, 'cliIntegrationEnabled') ?? vscode.workspace.getConfiguration('codexManager').get<boolean>('cliIntegrationEnabled', false);
      if (legacyWorkspace) for (const provider of ['codex', 'claude'] as const) {
        const explicit = vscode.workspace.getConfiguration('codexManager').inspect(`${provider}ModuleEnabled`);
        if (readConfigurationValue(store, configurationNamespace, `${provider}ModuleEnabled`) === undefined && explicit?.globalValue === undefined && explicit?.workspaceValue === undefined && explicit?.workspaceFolderValue === undefined) legacyModules.push(provider);
      }
      store.set('migrations', `${scope}:runtime-modules`, true);
    }
    synchronizeSqliteConfiguration();
    configurationSnapshot = currentConfigurationSnapshot();
    configureSqliteStateStore(store);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration("codexManager")) return;
      try { synchronizeSqliteConfiguration(event); configurationSnapshot = currentConfigurationSnapshot(); } catch (error) {
        console.error("[codexManager] settings could not be saved to SQLite", error);
        void vscode.window.showWarningMessage(`Settings could not be saved to SQLite. Retry the setting change: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    context.subscriptions.push({ dispose: store.subscribe(["settings"], publishConfigurationChanges) });
    const secrets = await createSqliteSecretStorage(store, context.secrets, context.subscriptions);
    officeStorage = configureOfficeStorage(store, () => {
      const config = sqliteConfiguration(vscode.workspace.getConfiguration('codexManager'));
      return {provider: config.get<string>('officeDatabaseProvider', 'sqlite'), url: config.get<string>('officePostgresUrl', '').trim()};
    });
    void officeStorage.ready().catch(error => console.warn('[codexManager] Workspace storage initialization deferred', error));
    if (legacyModules.length) void import('../services/workspaceRuntimes').then(module => module.migrateWorkspaceRuntimeModules(legacyModules)).catch(error => console.warn('[codexManager] Provider module migration deferred; open Settings to set up providers', error));
    return Object.create(context, { globalState: { value: globalState }, workspaceState: { value: workspaceState }, secrets: { value: secrets } }) as vscode.ExtensionContext;
  } catch (error) {
    configurationNamespace = undefined;
    configurationStore = undefined;
    store.close();
    throw error;
  }
}

function synchronizeSqliteConfiguration(event?: vscode.ConfigurationChangeEvent): void {
  const store = configurationStore;
  const namespace = configurationNamespace;
  if (!store || !namespace) return;
  const config = vscode.workspace.getConfiguration("codexManager");
  store.transaction(() => {
    for (const retired of ["codexSessionTransport", "webDashboardAlwaysOnlineEnabled", "autoResumeOpenVsCode"]) {
      for (const scope of [namespace, `settings-native:${namespace}`, "settings-overrides:global", `settings-overrides:${namespace}`])
        store.set(scope, retired, undefined);
    }
    for (const key of configurationKeys) {
      if (event && !event.affectsConfiguration(`codexManager.${key}`)) continue;
      const value = config.get(key);
      if (!event && key === "dailyTokenUsageEnabled" && !store.get("migrations", `${namespace}:token-history-default-on`)) {
        const inspected = config.inspect(key);
        const explicit = inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined ||
          store.get("settings-overrides:global", key) !== undefined || store.get(`settings-overrides:${namespace}`, key) !== undefined || store.get(`settings-native:${namespace}`, key) !== undefined;
        if (!explicit) store.set(namespace, key, value);
        store.set("migrations", `${namespace}:token-history-default-on`, true);
      }
      if (event || store.get(namespace, key) === undefined) store.set(namespace, key, value);
      const inspected = config.inspect(key);
      if (event || !store.get("migrations", `${namespace}:native-workspace`))
        store.set(`settings-native:${namespace}`, key, inspected?.workspaceFolderValue ?? inspected?.workspaceValue);
      if (event) {
        store.set("settings-overrides:global", key, undefined);
        store.set(`settings-overrides:${namespace}`, key, undefined);
      }
    }
    store.set("migrations", `${namespace}:native-workspace`, true);
  });
}

function readConfigurationValue<T>(store: SqliteStateStore, namespace: string, key: string): T | undefined {
  return store.get<T>(`settings-overrides:${namespace}`, key) ?? store.get<T>(`settings-native:${namespace}`, key) ?? store.get<T>("settings-overrides:global", key) ?? store.get<T>(namespace, key);
}

function currentConfigurationSnapshot(): Map<string, string | undefined> {
  if (!configurationStore || !configurationNamespace) return new Map();
  return new Map(configurationKeys.map(key => [key, JSON.stringify(readConfigurationValue(configurationStore!, configurationNamespace!, key))]));
}

function publishConfigurationChanges(): void {
  const next = currentConfigurationSnapshot();
  const changed = configurationKeys.filter(key => configurationSnapshot.get(key) !== next.get(key));
  configurationSnapshot = next;
  fireSqliteConfigurationChanges(changed);
}

export function sqliteConfiguration(config: vscode.WorkspaceConfiguration): vscode.WorkspaceConfiguration {
  const store = configurationStore;
  const namespace = configurationNamespace;
  if (!store || !namespace) return config;
  // VS Code freezes configuration methods; a separate target permits delegation.
  const validate=(key:string,value:unknown)=>{
    const schema=configurationSchema[`codexManager.${key}`];if(!schema)throw new Error(`Unknown Codex Manager setting: ${key}`);
    const type=Array.isArray(value)?'array':value===null?'null':typeof value;
    if(value!==undefined&&(type!==schema.type||(schema.enum&&!schema.enum.includes(value))||(typeof value==='number'&&(!Number.isFinite(value)||(schema.minimum!==undefined&&value<schema.minimum)||(schema.maximum!==undefined&&value>schema.maximum)||(schema.multipleOf!==undefined&&value%schema.multipleOf!==0)))))throw new Error(`Invalid value for Codex Manager setting: ${key}`);
  };
  const result=new Proxy({ ...config }, {
    get: (_target, property) => {
      if (property === "get") return <T>(key: string, fallback?: T): T | undefined => {
        const value = readConfigurationValue<T>(store, namespace, key);
        return value === undefined ? config.get<T>(key, fallback as T) : value;
      };
      if (property === "update") return (key: string, value: unknown, target?: vscode.ConfigurationTarget | boolean | null): Promise<void> => Promise.resolve().then(() => {
        validate(key,value);
        const local = target === false || target === vscode.ConfigurationTarget.Workspace || target === vscode.ConfigurationTarget.WorkspaceFolder;
        store.set(local ? `settings-overrides:${namespace}` : "settings-overrides:global", key, value);
        publishConfigurationChanges();
      });
      if (property === "inspect") return <T>(key: string) => {
        const original = config.inspect<T>(key);
        if (!original) return original;
        return { ...original, globalValue: store.get<T>("settings-overrides:global", key) ?? original.globalValue,
          workspaceValue: store.get<T>(`settings-overrides:${namespace}`, key) ?? original.workspaceValue };
      };
      const value: unknown = Reflect.get(config, property);
      return typeof value === "function" ? value.bind(config) as unknown : value;
    }
  });
  configurationBatches.set(result,updates=>{for(const [key,value] of updates)validate(key,value);store.transaction(()=>{for(const [key,value] of updates)store.set('settings-overrides:global',key,value);});publishConfigurationChanges();});
  return result;
}

export function disposeSqliteContext(): void {
  officeStorage?.dispose(); officeStorage = undefined;
  configurationStore?.close();
  configurationStore = undefined;
  configurationNamespace = undefined;
  configurationKeys = [];
  configurationSnapshot.clear();
  configurationSchema = {};
  configureSqliteStateStore(undefined);
}

export async function ensureOfficeStorageReady(): Promise<void> { await officeStorage?.ready(); }
