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
    if (!errorMessage) {
      errorMessage = `The ${formatActionName(message.action)} action failed. Please try again.`;
    }
    return {
      level: "error",
      message: errorMessage
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
      message: `${formatActionName(message.action)} finished with ${batch.successCount} succeeded and ${batch.failedCount} failed.${firstFailure ? ` First error: ${firstFailure}` : ""}`
    };
  }

  if (["getDailyUsage", "listCodexCliSessions", "getCodexCliSessionMessages", "getWorkspaceEnvironment", "listWorkspaceFiles", "readWorkspaceFile", "markAnnouncementRead"].includes(message.action)) {
    return undefined;
  }

  return { level: "info", message: `${formatActionName(message.action)} completed.` };
}

export function noticeFromActionTimeout(action: DashboardActionName): DashboardNotice {
  return {
    level: "warning",
    message: `${formatActionName(action)} did not finish in time. Check VS Code notifications, then try again.`
  };
}

function formatActionName(action: DashboardActionName): string {
  const words = action.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
