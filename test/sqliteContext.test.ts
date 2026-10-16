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
import { getCodexManagerConfiguration } from "../src/infrastructure/config/extensionSettings";
import { removeTestDirectory } from "./testFilesystem";

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
function changed() { for (const listener of listeners) listener({ affectsConfiguration: key => key === "codexManager" } as vscode.ConfigurationChangeEvent); }
beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sqlite-context-"));
  values = new Map([["autoResumeEnabled", true], ["autoSwitchEnabled", true], ["autoResumeGoalOnlyEnabled", false]]);
  listeners = new Set(); subscriptions = [];
  nativeConfig = {
    get: vi.fn((key: string, fallback?: unknown) => values.has(key) ? values.get(key) : manifest.contributes.configuration.properties[`codexManager.${key}`]?.default ?? fallback),
    update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); changed(); }),
    inspect: vi.fn((key: string) => ({ key, globalValue: values.get(key) })),
    has: vi.fn((key: string) => values.has(key))
  } as unknown as vscode.WorkspaceConfiguration;
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
  it("migrates existing state and settings while preserving credentials and VS Code editing", async () => {
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
    expect(nativeConfig.update).toHaveBeenCalledWith("autoResumeEnabled", false, vscode.ConfigurationTarget.Global);
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
    disposeSqliteContext();
    const second = await initializeSqliteContext(original);
    expect(second.globalState.get("accountPreference")).toBeUndefined();
    expect(second.workspaceState.get("recovery")).toEqual(["latest"]);
  });
});
