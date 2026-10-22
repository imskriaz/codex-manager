import { describe, expect, it } from "vitest";
import { formatSessionReadError, isMissingCliSessionError, noticeFromActionResult, noticeFromActionTimeout } from "../webview-src/dashboard/actionFeedback";

describe("dashboard action feedback", () => {
  it("shows token refresh outcomes and keeps automatic refreshes quiet", () => {
    const message = { type: 'dashboard:action-result' as const, requestId: 'token', action: 'refreshToken' as const };
    expect(noticeFromActionResult({ ...message, status: 'completed', payload: { notice: { level: 'info', message: 'Account token refreshed.' } } })).toEqual({ level: 'info', message: 'Account token refreshed.' });
    expect(noticeFromActionResult({ ...message, status: 'failed', error: 'Refresh token was revoked. Reauthorize this account.' })?.level).toBe('error');
    expect(noticeFromActionResult({ ...message, status: 'cancelled' })?.level).toBe('warning');
    expect(noticeFromActionResult({ ...message, status: 'completed' }, true)).toBeUndefined();
    expect(noticeFromActionResult({ ...message, action: 'getProjectBoard', status: 'completed' }, true)).toBeUndefined();
    expect(noticeFromActionResult({ ...message, action: 'getProjectBoard', status: 'completed' })?.message).toBe('Board refreshed.');
    for (const action of ['getProjectTaskDetails', 'listWorkspaceTerminals', 'listApiTokens', 'getMaintenanceStatus', 'getMaintenancePage', 'previewMaintenance', 'inspectMaintenanceStorage', 'viewLogs', 'getResetCredits'] as const) {
      expect(noticeFromActionResult({ ...message, action, status: 'completed' })).toBeUndefined();
      expect(noticeFromActionResult({ ...message, action, status: 'failed', error: 'Offline' })?.level).toBe('error');
    }
  });
  it("keeps list failures and cancellations in the session view instead of duplicating technical toasts", () => {
    for (const status of ["failed", "cancelled", "completed"] as const) expect(noticeFromActionResult({ type: "dashboard:action-result", requestId: "retry", action: "listCodexCliSessions", status, error: "Technical inspection failed.", payload: { notice: { level: "warning", message: "Technical inspection failed." } } })).toBeUndefined();
  });
  it.each(["failed", "cancelled", "completed"] as const)("keeps token history %s outcomes out of toasts", status => {
    for (const action of ["getDailyUsage", "getUsageGraph"] as const) for (const error of [undefined, "offline", "storage full", "The usage provider requested a retry delay.",
      "The usage endpoint returned no readable daily data. Automatic usage checks wait at least one hour and respect server retry delay",
      "Failed to get tokens for codex_test Automatic usage checks wait at least one hour and respect server retry delays."]) {
      expect(noticeFromActionResult({ type: "dashboard:action-result", requestId: "usage", action, status, error,
        payload: { notice: { level: "warning", message: "Automatic token history is disabled. Saved history remains available." } } })).toBeUndefined();
    }
  });
  it("keeps unverified and disabled session reads inline, preserving send failures", () => {
    for (const action of ["listCodexCliSessions", "getCodexCliSessionMessages"] as const) {
      for (const detail of ["Session inspection timed out.", "The file did not respond within 5 seconds. Try again after the other app finishes writing it."]) {
        expect(noticeFromActionResult({ type: "dashboard:action-result", requestId: "busy-history", action, status: "completed",
          payload: { notice: { level: "warning", message: `Session history is available, but running state could not be verified. Refresh before sending. ${detail}` } } })).toBeUndefined();
      }
      expect(noticeFromActionResult({ type: "dashboard:action-result", requestId: "sessions", action, status: "completed",
        payload: { notice: { level: "warning", message: "Session history is available, but running state could not be verified. Refresh before sending. Session inspection timed out." } } })).toBeUndefined();
      expect(noticeFromActionResult({ type: "dashboard:action-result", requestId: "sessions", action, status: "failed",
        error: "Session Integration is disabled. Enable it in Settings before opening sessions." })).toBeUndefined();
    }
    expect(noticeFromActionResult({ type: "dashboard:action-result", requestId: "send", action: "sendCodexCliSessionMessage", status: "failed", error: "Session running state could not be verified." })?.level).toBe("error");
  });
  it("keeps startup session failures, warnings and late results out of toasts", () => {
    for (const status of ["failed", "cancelled", "completed"] as const) {
      expect(noticeFromActionResult({ type: "dashboard:action-result", requestId: "startup", action: "getCodexCliSessionMessages", status,
        error: "The session transcript was not found on this PC.", payload: { notice: { level: "warning", message: "Technical inspection failed" } } }, true)).toBeUndefined();
    }
    expect(noticeFromActionResult({ type: "dashboard:action-result", requestId: "manual", action: "getCodexCliSessionMessages", status: "failed",
      error: "The session transcript was not found on this PC." })).toBeUndefined();
    expect(formatSessionReadError("getCodexCliSessionMessages", "Permission denied.")).toBe("Permission denied.");
  });
  it('evicts only confirmed missing conversations while preserving transient read failures', () => {
    expect(isMissingCliSessionError('This session was not found.')).toBe(true);
    for (const error of ['Permission denied.', 'Session discovery is still pending.', 'Session transcript not found while offline.', 'Session read timed out.']) expect(isMissingCliSessionError(error)).toBe(false);
    expect(noticeFromActionResult({ type: 'dashboard:action-result', requestId: 'rename', action: 'renameCodexCliSession', status: 'completed', payload: { notice: { level: 'warning', message: 'The session action completed, but the session list could not refresh: Session discovery is still pending.' } } })).toBeUndefined();
  });
  it("does not duplicate embedded turn completion with an internal CLI action-name toast", () => {
    expect(noticeFromActionResult({ type: "dashboard:action-result", requestId: "turn", action: "sendCodexCliSessionMessage", status: "completed" })).toBeUndefined();
  });
  it("uses inline agent messages as success feedback while preserving failed and cancelled outcomes", () => {
    const result = { type: "dashboard:action-result" as const, requestId: "agent-read", action: "getCodexSubAgentMessages" as const };
    expect(noticeFromActionResult({ ...result, status: "completed" })).toBeUndefined();
    expect(noticeFromActionResult({ ...result, status: "failed", error: "Agent unavailable. Try Refresh." })).toEqual({ level: "error", message: "Agent unavailable. Try Refresh." });
    expect(noticeFromActionResult({ ...result, status: "cancelled" })?.level).toBe("warning");
  });
  it("shows a warning when the cross-PC sync toggle times out", () => {
    expect(noticeFromActionTimeout("setCrossPcSyncEnabled")).toMatchObject({
      level: "warning",
      message: expect.stringMatching(/still running.*refresh to check/i)
    });
  });
  it("surfaces the host error from every failed action result", () => {
    expect(
      noticeFromActionResult({
        type: "dashboard:action-result",
        requestId: "request-1",
        action: "syncNow",
        status: "failed",
        error: "VS Code Settings Sync is unavailable."
      })
    ).toEqual({
      level: "error",
      message: "VS Code Settings Sync is unavailable."
    });
  });

  it("shows explicit sync failures even when no transport is available", () => {
    expect(
      noticeFromActionResult({
        type: "dashboard:action-result",
        requestId: "request-sync-unavailable",
        action: "syncNow",
        status: "failed",
        error: "Cross-PC claim sync did not complete. Connect an authenticated peer WebSocket or sign in to VS Code Settings Sync, then try again."
      })
    ).toMatchObject({level:"error",message:expect.stringContaining("Cross-PC claim sync did not complete.")});
  });

  it("keeps recoverable automatic usage checks out of notices", () => {
    for (const error of [
      "The usage endpoint returned no readable daily data.",
      "The previous daily usage check did not complete. Automatic usage checks wait at least one hour and respect server retry delays."
    ]) {
      expect(noticeFromActionResult({
        type: "dashboard:action-result",
        requestId: "usage-check",
        action: "getDailyUsage",
        status: "failed",
        error
      })).toBeUndefined();
    }
  });

  it("provides fallback feedback when a failed result has no message", () => {
    expect(
      noticeFromActionResult({
        type: "dashboard:action-result",
        requestId: "request-2",
        action: "refreshAll",
        status: "failed"
      })?.message
    ).toMatch(/refresh all action failed/i);
  });

  it("turns a client-side action timeout into an actionable warning", () => {
    expect(noticeFromActionTimeout("configureEncryptedSync")).toEqual({
      level: "warning",
      message: "Configure encrypted sync is still running. Refresh to check before trying again."
    });
  });

  it("surfaces a cancelled CLI turn as a visible warning", () => {
    expect(
      noticeFromActionResult({
        type: "dashboard:action-result",
        requestId: "request-stop",
        action: "sendCodexCliSessionMessage",
        status: "cancelled",
        error: "Codex stopped this turn before it completed."
      })
    ).toEqual({
      level: "warning",
      message: "Codex stopped this turn before it completed."
    });
  });

  it("shows a visible terminal state for completed user actions without custom copy", () => {
    expect(
      noticeFromActionResult({
        type: "dashboard:action-result",
        requestId: "request-3",
        action: "refreshView",
        status: "completed"
      })
    ).toEqual({ level: "info", message: "Refresh view done." });
  });

  it("does not bombard users for background data reads whose result is visible inline", () => {
    expect(
      noticeFromActionResult({
        type: "dashboard:action-result",
        requestId: "request-background",
        action: "listCodexCliSessions",
        status: "completed"
      })
    ).toBeUndefined();
  });

  it("shows an explicit terminal notice returned by a completed action", () => {
    expect(
      noticeFromActionResult({
        type: "dashboard:action-result",
        requestId: "request-notice",
        action: "refreshView",
        status: "completed",
        payload: {
          notice: { level: "info", message: "Registry refreshed." }
        }
      })
    ).toEqual({ level: "info", message: "Registry refreshed." });
  });

  it("surfaces partial batch failures even when the action completed", () => {
    expect(
      noticeFromActionResult({
        type: "dashboard:action-result",
        requestId: "request-4",
        action: "batchRefresh",
        status: "completed",
        payload: {
          batchResult: {
            kind: "batch_refresh",
            successCount: 2,
            failedCount: 1,
            failures: [{ message: "Session expired." }]
          }
        }
      })
    ).toEqual({
      level: "warning",
      message: "Batch refresh: 2 done, 1 failed. Session expired."
    });
  });

  it("surfaces partial Disable All failures", () => {
    expect(
      noticeFromActionResult({
        type: "dashboard:action-result",
        requestId: "request-disable-all",
        action: "disableAll",
        status: "completed",
        payload: {
          batchResult: {
            kind: "disable_all",
            successCount: 2,
            failedCount: 1,
            failures: [{ message: "Account is claimed by another PC." }]
          }
        }
      })
    ).toEqual({
      level: "warning",
      message: "Disable all: 2 done, 1 failed. Account is claimed by another PC."
    });
  });
});
