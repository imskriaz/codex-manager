import * as vscode from "vscode";
import type { AccountsRepository } from "../storage";
import type { WebDashboardServer } from "./webDashboardServer";
import { getAutoRefreshMinutes, getAutoRefreshCurrentMinutes, getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import { initAutoSwitchRuntimeState } from "../presentation/workbench/autoSwitchState";
import { registerAutoRefreshScheduler, registerTokenRefreshScheduler } from "../presentation/workbench/schedulerRegistration";
import { registerSessionRecording } from "./sessionRecording";
import { registerCodexSessionQueue } from "./codexSessionQueue";
import { registerWorkspaceTerminalMonitoring } from "./workspaceTools";
import { registerModelCapacitySwitch } from "./modelCapacitySwitch";
import { registerQuotaRecoveryAutoResume } from "./quotaRecoveryAutoResume";
import { registerCodexSessionAutoResumeTracking, resumePersistedCodexSessions, scheduleCodexSessionAutoResume, formatAutoResumeResult } from "./codexSessionAutoResume";
import { publishDashboardRealtime } from "./dashboardRealtime";
import { AccountsCommandService } from "../application/accounts/commandService";

/** Start only after this host owns the port, so a rejected competing host cannot automate accounts. */
export function registerNodeBackgroundServices(context: vscode.ExtensionContext, repo: AccountsRepository, dashboard: WebDashboardServer,
  canUseAccount: (accountId: string) => boolean = () => !getCodexManagerConfiguration().get<boolean>("encryptedSyncEnabled", false)): void {
  initAutoSwitchRuntimeState(context);
  const refresh = () => dashboard.publishLocalStateChange();
  const view = { refresh };
  const commands = new AccountsCommandService(context, repo, view, canUseAccount, undefined, canUseAccount);
  context.subscriptions.push(
    vscode.commands.registerCommand("codexManager.refreshQuota", (account: Parameters<AccountsCommandService["refreshQuota"]>[0]) => commands.refreshQuota(account)),
    vscode.commands.registerCommand("codexManager.refreshAllQuotas", (options: Parameters<AccountsCommandService["refreshAllQuotas"]>[0]) => commands.refreshAllQuotas(options))
  );
  registerWorkspaceTerminalMonitoring(context);
  registerSessionRecording(context);
  registerCodexSessionQueue(context);
  context.subscriptions.push(
    registerCodexSessionAutoResumeTracking(context),
    registerModelCapacitySwitch(repo, view, canUseAccount),
    registerQuotaRecoveryAutoResume(context, repo, canUseAccount),
    registerAutoRefreshScheduler({ context, repo, onRefresh: refresh, canRefreshAccount: canUseAccount }),
    registerTokenRefreshScheduler({ context, repo, view, checkIntervalMs: 15 * 60_000, skewSeconds: 5 * 60, canRefreshAccount: canUseAccount }),
    scheduleCodexSessionAutoResume(async () => {
      const result = await resumePersistedCodexSessions(context);
      const message = formatAutoResumeResult(result);
      if (message) publishDashboardRealtime({ type: "dashboard:notice", level: result.failed.length ? "warning" : "info", message });
      return result.failed.length > 0;
    })
  );
  // Standalone has no VS Code activation refresh pass; check quotas once after
  // ownership is established instead of waiting for the first interval.
  if (getAutoRefreshMinutes() > 0 || getAutoRefreshCurrentMinutes() > 0) {
    void commands.refreshAllQuotas({ silent: true, forceRefresh: true, respectQuotaCheckGap: false })
      .catch(error => console.warn("[codexManager] standalone quota refresh failed:", error));
  }
}
