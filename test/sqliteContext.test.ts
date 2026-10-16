import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/utils/storageRoot", () => ({ getCodexManagerStorageRoot: () => fixture.root }));
import { disposeSqliteContext, initializeSqliteContext } from "../src/storage/sqliteContext";
import { configureSqliteStateStore, getSqliteStateStore } from "../src/storage/sqliteState";
import { getCodexManagerConfiguration, getSyncHeartbeatMinutes } from "../src/infrastructure/config/extensionSettings";
import { removeTestDirectory } from "./testFilesystem";
import { onDidChangeConfiguration } from "../src/storage/configurationEvents";
import { SqliteStateStore } from "../src/storage/sqliteState";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
let values: Map<string, unknown>;
let listeners: Set<(event: vscode.ConfigurationChangeEvent) => unknown>;
let subscriptions: vscode.Disposable[];
let nativeConfig: vscode.WorkspaceConfiguration;
function memento(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  return { keys: () => [...data.keys()], get: (key: string, fallback?: unknown) => data.has(key) ? data.get(key) : fallback,
    update: vi.fn(async (key: string, value: unknown) => { if (value === undefined) data.delete(key); else data.set(key, value); }), setKeysForSync: vi.fn() };
}
function context() {
  return { globalState: memento({ accountPreference: true }), workspaceState: memento({ recovery: ["saved-id"] }),
    storageUri: { fsPath: path.join(fixture.root, "workspace") }, extension: { packageJSON: manifest },
    secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() }, subscriptions } as unknown as vscode.ExtensionContext;
}
function changed() { for (const listener of listeners) listener({ affectsConfiguration: key => key === "codexManager" || key.startsWith("codexManager.") } as vscode.ConfigurationChangeEvent); }
beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sqlite-context-"));
  values = new Map([["autoResumeEnabled", true], ["autoSwitchEnabled", true], ["autoResumeGoalOnlyEnabled", false]]);
  listeners = new Set(); subscriptions = [];
  nativeConfig = Object.freeze({
    get: vi.fn((key: string, fallback?: unknown) => values.has(key) ? values.get(key) : manifest.contributes.configuration.properties[`codexManager.${key}`]?.default ?? fallback),
    update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); changed(); }),
    inspect: vi.fn((key: string) => ({ key, globalValue: values.get(key) })),
    has: vi.fn((key: string) => values.has(key))
  }) as unknown as vscode.WorkspaceConfiguration;
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(nativeConfig);
  vi.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementation(listener => {
    listeners.add(listener);
    return { dispose: () => { listeners.delete(listener); } };
  });
});
afterEach(async () => {
  for (const disposable of subscriptions) disposable.dispose();
  disposeSqliteContext();
  configureSqliteStateStore(undefined);
  vi.restoreAllMocks();
  await removeTestDirectory(fixture.root);
});

describe("SQLite extension context and settings migration", () => {
  it("preserves native workspace precedence over global SQLite preferences", async () => {
    vi.mocked(nativeConfig.inspect).mockImplementation(key => ({ key, workspaceValue: key === "autoResumeEnabled" ? true : undefined }) as never);
    await initializeSqliteContext(context());
    const config = getCodexManagerConfiguration();
    await config.update("autoResumeEnabled", false, vscode.ConfigurationTarget.Global);
    expect(config.get("autoResumeEnabled")).toBe(true);
    await config.update("autoResumeEnabled", false, vscode.ConfigurationTarget.Workspace);
    expect(config.get("autoResumeEnabled")).toBe(false);
  });

  it("supports VS Code's frozen configuration methods during workbench initialization", async () => {
    await initializeSqliteContext(context());
    expect(Object.isFrozen(nativeConfig)).toBe(true);
    expect(getSyncHeartbeatMinutes()).toBe(manifest.contributes.configuration.properties["codexManager.encryptedSyncVsCodeHeartbeatMinutes"].default);
    const config = getCodexManagerConfiguration();
    expect(config.get("unknownSetting", "fallback")).toBe("fallback");
    expect(config.has("autoResumeEnabled")).toBe(true);
    expect(config.inspect("autoResumeEnabled")).toMatchObject({ globalValue: true });
    expect(vi.mocked(nativeConfig.has).mock.contexts.at(-1)).toBe(nativeConfig);
    expect(vi.mocked(nativeConfig.inspect).mock.contexts.at(-1)).toBe(nativeConfig);
  });

  it("migrates settings while preserving credentials and writes dashboard changes only to SQLite", async () => {
    const original = context();
    const migrated = await initializeSqliteContext(original);
    expect(migrated.globalState.get("accountPreference")).toBe(true);
    expect(migrated.workspaceState.get("recovery")).toEqual(["saved-id"]);
    expect(migrated.secrets).toBe(original.secrets);
    const config = getCodexManagerConfiguration();
    vi.mocked(nativeConfig.get).mockClear();
    expect(config.get("autoResumeEnabled")).toBe(true);
    expect(config.get("autoResumeGoalOnlyEnabled")).toBe(false);
    expect(nativeConfig.get).not.toHaveBeenCalled();
    await config.update("autoResumeEnabled", false, vscode.ConfigurationTarget.Global);
    expect(nativeConfig.update).not.toHaveBeenCalled();
    expect(getCodexManagerConfiguration().get("autoResumeEnabled")).toBe(false);
    values.set("autoResumeEnabled", true);
    changed();
    expect(getCodexManagerConfiguration().get("autoResumeEnabled")).toBe(true);
    expect(original.globalState.get("accountPreference")).toBe(true);
  });

  it("reports an uncommitted settings write and retries after SQLite contention clears", async () => {
    await initializeSqliteContext(context());
    const store = getSqliteStateStore()!;
    const moduleName = "node:sqlite";
    const { DatabaseSync } = await import(moduleName);
    const blocker = new DatabaseSync(store.file);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      await expect(getCodexManagerConfiguration().update("autoResumeEnabled", false)).rejects.toThrow(/locked|busy/i);
      expect(getCodexManagerConfiguration().get("autoResumeEnabled")).toBe(true);
      blocker.exec("ROLLBACK");
      await getCodexManagerConfiguration().update("autoResumeEnabled", false);
      expect(getCodexManagerConfiguration().get("autoResumeEnabled")).toBe(false);
    } finally { blocker.close(); }
  });

  it("keeps migrated values across reactivation and does not restore deleted legacy values", async () => {
    const original = context();
    const first = await initializeSqliteContext(original);
    await first.globalState.update("accountPreference", undefined);
    await first.workspaceState.update("recovery", ["latest"]);
    await getCodexManagerConfiguration().update("autoResumeEnabled", false);
    disposeSqliteContext();
    const second = await initializeSqliteContext(original);
    expect(second.globalState.get("accountPreference")).toBeUndefined();
    expect(second.workspaceState.get("recovery")).toEqual(["latest"]);
    expect(getCodexManagerConfiguration().get("autoResumeEnabled")).toBe(false);
  });

  it("preserves workspace overrides and validates values before writing SQLite", async () => {
    await initializeSqliteContext(context());
    const config = getCodexManagerConfiguration();
    await config.update("autoResumeEnabled", false, vscode.ConfigurationTarget.Workspace);
    await config.update("autoResumeEnabled", true, vscode.ConfigurationTarget.Global);
    expect(config.get("autoResumeEnabled")).toBe(false);
    expect(config.inspect("autoResumeEnabled")).toMatchObject({ workspaceValue: false, globalValue: true });
    await config.update("autoResumeEnabled", undefined, vscode.ConfigurationTarget.Workspace);
    expect(config.get("autoResumeEnabled")).toBe(true);
    await expect(config.update("autoResumeEnabled", "invalid")).rejects.toThrow("Invalid value");
    await expect(config.update("autoRefreshMinutes", -1)).rejects.toThrow("Invalid value");
    await expect(config.update("dashboardTheme", "invalid")).rejects.toThrow("Invalid value");
    expect(nativeConfig.update).not.toHaveBeenCalled();
  });

  it("notifies settings consumers locally and after another window commits a change", async () => {
    vi.useFakeTimers();
    let peer: SqliteStateStore | undefined;
    try {
      await initializeSqliteContext(context());
      const listener = vi.fn();
      subscriptions.push(onDidChangeConfiguration(listener));
      await getCodexManagerConfiguration().update("autoResumeEnabled", false);
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0]![0].affectsConfiguration("codexManager.autoResumeEnabled")).toBe(true);
      expect(listener.mock.calls[0]![0].affectsConfiguration("codexManager.crossWindowAccountModeEnabled")).toBe(false);
      peer = await SqliteStateStore.open(getSqliteStateStore()!.file);
      peer.set("settings-overrides:global", "autoResumeEnabled", true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getCodexManagerConfiguration().get("autoResumeEnabled")).toBe(true);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally { peer?.close(); vi.useRealTimers(); }
  });
});


it("enables token collection for untouched defaults and preserves an explicit Off choice", async () => {
  await initializeSqliteContext(context());
  const store = getSqliteStateStore()!;
  const namespace = store.keys("migrations").find(key => key.endsWith(":token-history-default-on"))!.replace(":token-history-default-on", "");
  store.set(namespace, "dailyTokenUsageEnabled", false);
  store.set("migrations", `${namespace}:token-history-default-on`, undefined);
  disposeSqliteContext();
  await initializeSqliteContext(context());
  expect(getCodexManagerConfiguration().get("dailyTokenUsageEnabled")).toBe(true);
  await getCodexManagerConfiguration().update("dailyTokenUsageEnabled", false, vscode.ConfigurationTarget.Global);
  getSqliteStateStore()!.set("migrations", `${namespace}:token-history-default-on`, undefined);
  disposeSqliteContext();
  await initializeSqliteContext(context());
  expect(getCodexManagerConfiguration().get("dailyTokenUsageEnabled")).toBe(false);
});
