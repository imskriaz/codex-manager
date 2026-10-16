import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ enabled: true, construct: vi.fn(), activate: vi.fn(async () => undefined) }));
vi.mock("../src/presentation/workbench/accountsWorkbench", () => ({ AccountsWorkbench: class {
  constructor() { fixture.construct(); }
  activate = fixture.activate;
} }));
vi.mock("../src/storage/sqliteContext", () => ({ initializeSqliteContext: async (context: unknown) => context, disposeSqliteContext: vi.fn(), sqliteConfiguration: (config: unknown) => config }));
vi.mock("../src/utils/persistentLog", () => ({ registerPersistentLogging: vi.fn(), disposePersistentLogging: vi.fn() }));
vi.mock("../src/utils/notificationMirror", () => ({ enableTransientVscodeNotices: () => ({ dispose() {} }) }));
vi.mock("../src/services/workspaceTools", () => ({ registerWorkspaceTerminalMonitoring: vi.fn() }));
vi.mock("../src/utils/crossWindowOperations", () => ({ configureCrossWindowOperationCoordinator: vi.fn() }));
vi.mock("../src/services/windowAccountMode", () => ({
  initializeCrossWindowAccountMode: async () => { throw new Error("Registry unavailable"); },
  isCrossWindowAccountModeEnabled: () => fixture.enabled,
  disposeCrossWindowAccountMode: vi.fn()
}));
vi.mock("../src/infrastructure/config/proxyEnvironment", () => ({ initializeCodexProxyEnvironment: vi.fn(), getCodexProxyConfigurationError: () => undefined }));
import { activate } from "../src/extension";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
beforeEach(() => {
  fixture.enabled = true;
  vi.clearAllMocks();
  Object.assign(vscode.commands, { registerCommand: vi.fn(() => ({ dispose() {} })) });
});

it("stops startup before shared-home account work and keeps contributed commands actionable", async () => {
  const handlers = new Map<string, () => unknown>();
  vi.mocked(vscode.commands.registerCommand).mockImplementation((id, handler) => {
    handlers.set(id, handler);
    return { dispose() {} };
  });
  await activate({ subscriptions: [], extension: { packageJSON: manifest } } as never);
  expect(fixture.construct).not.toHaveBeenCalled();
  expect(fixture.activate).not.toHaveBeenCalled();
  expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("protect the shared Codex home"));
  vi.mocked(vscode.window.showErrorMessage).mockClear();
  expect(handlers.has("codexManager.showQuotaSummary")).toBe(true);
  await handlers.get("codexManager.showQuotaSummary")!();
  expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Reload the window"));
});

it("continues ordinary startup when optional coordination fails with isolation disabled", async () => {
  fixture.enabled = false;
  await activate({ subscriptions: [], extension: { packageJSON: manifest } } as never);
  expect(fixture.construct).toHaveBeenCalledOnce();
  expect(fixture.activate).toHaveBeenCalledOnce();
});
