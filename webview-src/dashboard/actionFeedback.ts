import type { DashboardActionName, DashboardHostMessage, DashboardNotice } from "../../src/domain/dashboard/types";

export function noticeFromActionResult(
  message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>
): DashboardNotice | undefined {
  if (message.status === "cancelled") {
    return {
      level: "warning",
      message: message.error?.trim() || `${formatActionName(message.action)} was cancelled.`
    };
  }
  if (message.status === "failed") {
    let errorMessage = message.error?.trim();
    if (message.action === "getDailyUsage" && isQuietDailyUsageError(errorMessage)) return undefined;
    if (
      message.action === "syncNow" &&
      errorMessage?.startsWith("Cross-PC claim sync did not complete.")
    ) {
      return undefined;
    }
    if (!errorMessage) {
      errorMessage = `The ${formatActionName(message.action)} action failed. Please try again.`;
    }
    return {
      level: "error",
      message: compactDashboardNotice(errorMessage)
    };
  }

  if (message.payload?.notice) {
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

  if (["getDailyUsage", "getUsageGraph", "listCodexCliSessions", "getCodexCliSessionMessages", "getCodexSubAgentMessages", "getWorkspaceEnvironment", "listWorkspaceFiles", "readWorkspaceFile", "startCodexCliSession", "sendCodexCliSessionMessage", "cancelCodexCliSessionTurn"].includes(message.action)) {
    return undefined;
  }

  return { level: "info", message: `${formatActionName(message.action)} done.` };
}

function isQuietDailyUsageError(message: string | undefined): boolean {
  return message === "The usage endpoint returned no readable daily data." ||
    message === "The previous daily usage check did not complete. Automatic usage checks wait at least one hour and respect server retry delays.";
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
