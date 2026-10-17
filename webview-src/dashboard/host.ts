import type { DashboardActionName, DashboardClientMessage } from "../../src/domain/dashboard/types";

declare function acquireVsCodeApi(): {
  postMessage(message: DashboardClientMessage): void;
  setState?(state: { dashboardOpen: true }): void;
};

const vscodeApi =
  typeof acquireVsCodeApi === "function"
    ? acquireVsCodeApi()
    : {
        postMessage(message: DashboardClientMessage): void {
          console.debug("[codex-manager] dashboard message", message);
        }
      };

if ("setState" in vscodeApi) vscodeApi.setState?.({ dashboardOpen: true });

export function getActionTimeoutMs(action: DashboardActionName, accountCount = 1): number {
  switch (action) {
    case "refreshView":
      return 8_000;
    case "sendCodexCliSessionMessage":
    case "startCodexCliSession":
      return 15 * 60_000 + 15_000;
    case "runWorkspaceTerminalCommand":
    case "saveWorkspaceFile":
    case "pushWorkspaceBranch":
      return 135_000;
    case "commitWorkspaceChanges":
      return 75_000;
    case "cancelWorkspaceTerminalCommand":
      return 10_000;
    case "steerCodexCliSessionTurn":
    case "cancelCodexCliSessionTurn":
      return 45_000;
    case "listCodexCliSessions":
    case "getCodexCliSessionMessages":
    case "getCodexSubAgentMessages":
      return 90_000;
    case "renameCodexCliSession":
    case "forkCodexCliSession":
    case "archiveCodexCliSession":
    case "unarchiveCodexCliSession":
    case "deleteCodexCliSession":
    case "openCodexCliSession":
    case "resumeCodexSessions":
      return 75_000;
    case "details":
    case "reloadPrompt":
    case "reauthorize":
    case "dismissHealthIssue":
    case "switch":
    case "refreshToken":
    case "getDailyUsage":
      return 120_000;
    case "refresh":
      return 240_000;
    case "resyncProfile":
      return 300_000;
    case "remove":
    case "toggleAccountEnabled":
    case "enableAllValid":
    case "disableAll":
      return 30_000;
    case "refreshAll":
    case "batchRefresh":
      return 240_000 * Math.max(1, accountCount);
    case "batchResyncProfile":
      return 300_000 * Math.max(1, accountCount);
    case "restoreFromBackup":
    case "restoreFromAuthJson":
      return 60_000;
    case "shareTokens":
    case "exportBackup":
    case "configureEncryptedSync":
    case "syncNow":
      // Settings Sync may need one download pass and one upload pass. Keep the
      // dashboard waiting for the host's real terminal result instead of
      // showing a misleading 30-second client timeout while sync continues.
      return 135_000;
    case "setEncryptedSyncRegistryOverride":
    case "exportAuthFile":
    case "prepareOAuthSession":
    case "cancelOAuthSession":
      return 30_000;
    case "importSharedJson":
    case "completeOAuthSession":
      return 120_000;
    case "addAccount":
    case "importCurrent":
    case "startOAuthAutoFlow":
      return 10 * 60_000 + 30_000;
    default:
      return 30_000;
  }
}

export function createActionRequestId(automatic = false): string {
  return `dashboard-${automatic ? "auto" : "action"}-${crypto.randomUUID()}`;
}

export function isAutomaticRequest(requestId: string): boolean { return requestId.startsWith("dashboard-auto-") || requestId.startsWith("realtime-cli-"); }

export function postMessageToHost(message: DashboardClientMessage): void {
  vscodeApi.postMessage(message);
}
