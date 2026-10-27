import { vi } from "vitest";

vi.mock("../src/services/codexNativeSessionStatus", () => ({
  readNativeCodexSessionRunning: vi.fn(async () => undefined),
  waitForNativeCodexSessionReady: vi.fn(async () => undefined),
  startNativeCodexSessionTurn: vi.fn(async () => false),
  cancelNativeCodexSessionTurn: vi.fn(async () => false),
  getNativeCodexSessionRunning: vi.fn(() => undefined),
  disposeNativeCodexSessionStatus: vi.fn()
}));

vi.mock("vscode", () => ({
  CancellationTokenSource: class {
    token = { isCancellationRequested: false, onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })) };
    cancel(): void {
      this.token.isCancellationRequested = true;
    }
    dispose(): void {}
  },
  env: {
    language: "en",
    openExternal: vi.fn(async () => true)
  },
  extensions: {
    getExtension: vi.fn(() => undefined)
  },
  Uri: {
    file: vi.fn((fsPath: string) => ({
      fsPath,
      scheme: "file",
      authority: "",
      path: fsPath,
      query: "",
      with: vi.fn((changes: Record<string, unknown>) => ({
        fsPath,
        scheme: changes.scheme ?? "file",
        authority: changes.authority ?? "",
        path: fsPath,
        query: "",
        ...changes
      }))
    }))
  },
  ViewColumn: {
    Active: 1
  },
  authentication: {
    getAccounts: vi.fn(async () => [])
  },
  commands: {
    executeCommand: vi.fn()
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      // Unrelated unit tests opt out of automation and listeners explicitly.
      get: (key: string, defaultValue?: unknown) => ["autoSwitchEnabled", "autoResetEnabled", "autoResumeEnabled", "autoSwitchWaitForSessionsEnabled", "autoSwitchReloadWindowEnabled", "autoSwitchRefreshAllBeforeSwitchEnabled", "quotaWarningEnabled", "cliIntegrationEnabled", "apiAccessEnabled", "webDashboardEnabled"].includes(key) ? false : defaultValue,
      update: vi.fn(),
      inspect: vi.fn()
    })),
    onDidChangeConfiguration: vi.fn()
  },
  window: {
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    setStatusBarMessage: vi.fn(() => ({ dispose: vi.fn() })),
    withProgress: vi.fn(async (_options, task) =>
      task(
        { report: vi.fn() },
        {
          isCancellationRequested: false,
          onCancellationRequested: vi.fn()
        }
      )
    )
  },
  ProgressLocation: {
    Notification: 15
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
  }
}));
