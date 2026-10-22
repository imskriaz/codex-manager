import type { DashboardActionName, DashboardHostMessage, DashboardNotice } from "../../src/domain/dashboard/types";

export function noticeFromActionResult(
  message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>,
  automatic = false
): DashboardNotice | undefined {
  if (automatic) return undefined;
  if (message.action === 'getCodexCliSessionMessages' && message.status === 'failed' && isMissingCliSessionError(message.error ?? '')) return undefined;
  if (message.action === "getDailyUsage" || message.action === "getUsageGraph" || message.action === "listCodexCliSessions") return undefined;
  if (["listCodexCliSessions", "getCodexCliSessionMessages", "getCodexSubAgentMessages"].includes(message.action) &&
    message.error?.startsWith("Session Integration is disabled.")) return undefined;
  if (message.status === "cancelled") {
    return {
      level: "warning",
      message: message.error?.trim() || `${formatActionName(message.action)} was cancelled.`
    };
  }
  if (message.status === "failed") {
    let errorMessage = message.error?.trim();
    if (!errorMessage) {
      errorMessage = `The ${formatActionName(message.action)} action failed. Please try again.`;
    }
    return {
      level: "error",
      message: compactDashboardNotice(formatSessionReadError(message.action, errorMessage))
    };
  }

  if (message.payload?.notice) {
    if (["listCodexCliSessions", "getCodexCliSessionMessages"].includes(message.action) &&
      message.payload.notice.message.startsWith("Session history is available, but running state could not be verified.")) return undefined;
    return message.payload.notice;
  }

  // The action-area prompt is the terminal feedback for this interaction;
  // avoid stacking a generic success toast underneath it.
  if (message.payload?.actionPrompts?.length) {
    return undefined;
  }

  const batch = message.payload?.batchResult;
  if (batch?.failedCount && batch.failedCount > 0) {
    const firstFailure = batch.failures[0]?.message?.trim();
    return {
      level: "warning",
      message: `${formatActionName(message.action)}: ${batch.successCount} done, ${batch.failedCount} failed.${firstFailure ? ` ${compactDashboardNotice(firstFailure)}` : ""}`
    };
  }

  if (["getDailyUsage", "getUsageGraph", "listCodexCliSessions", "getCodexCliSessionMessages", "getCodexSubAgentMessages", "getWorkspaceEnvironment", "listWorkspaceFiles", "readWorkspaceFile", "getProjectTaskDetails", "listWorkspaceTerminals", "listApiTokens", "getMaintenanceStatus", "getMaintenancePage", "previewMaintenance", "inspectMaintenanceStorage", "viewLogs", "getResetCredits", "startCodexCliSession", "sendCodexCliSessionMessage", "cancelCodexCliSessionTurn"].includes(message.action)) {
    return undefined;
  }

  if (message.action === 'getProjectBoard') return { level: 'info', message: 'Board refreshed.' };
  return { level: "info", message: `${formatActionName(message.action)} done.` };
}

export function isMissingCliSessionError(message: string): boolean {
  return /(?:session|transcript).*not found/i.test(message) && !/timeout|timed out|offline|unreachable|discovery.*pending/i.test(message);
}

export function formatSessionReadError(action: DashboardActionName, message: string): string {
  return action === "getCodexCliSessionMessages" && /(?:session|transcript).*not found/i.test(message)
    ? "This conversation is unavailable. Refresh the session list or choose another conversation."
    : message;
}

export function noticeFromActionTimeout(action: DashboardActionName): DashboardNotice {
  return {
    level: "warning",
    message: `${formatActionName(action)} is still running. Refresh to check before trying again.`
  };
}

function compactDashboardNotice(message: string): string {
  const value = message.trim().replace(/\s+/g, " ");
  return value.length > 180 ? `${value.slice(0, 179).trimEnd()}…` : value;
}

function formatActionName(action: DashboardActionName): string {
  const words = action.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
