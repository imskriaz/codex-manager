import { isCodexSessionInspectionNotice } from '../../src/domain/codexSessionState';
import type { DashboardNotice } from "../../src/domain/dashboard/types";

export const DASHBOARD_TOAST_DURATION_MS = 10_000;
export const DASHBOARD_INFO_TOAST_DURATION_MS = 3_000;

export type DashboardToast = DashboardNotice & { id: number };

export function scheduleDashboardToastDismiss(onDismiss: () => void, durationMs = DASHBOARD_TOAST_DURATION_MS): () => void {
  const timeout = globalThis.setTimeout(onDismiss, durationMs);
  return () => globalThis.clearTimeout(timeout);
}

/** Keep one dashboard toast visible and own its dismissal timer. */
export function createDashboardToastController(onChange: (toast: DashboardToast | undefined) => void) {
  let current: DashboardToast | undefined;
  let nextId = 0;
  let cancelDismiss: (() => void) | undefined;
  let disposed = false;

  const clearTimer = () => {
    cancelDismiss?.();
    cancelDismiss = undefined;
  };

  return {
    show(notice: DashboardNotice): void {
      if (!notice.actions?.length && !notice.actionPrompt && (notice.message === "Stop requested. Waiting for Codex to end the turn." || /^The connection (?:closed|failed) before this action was confirmed\./.test(notice.message))) return;
      if (disposed || isCodexSessionInspectionNotice(notice.message) || notice.level === "info") {
        return;
      }
      if (current?.level === notice.level && current.message === notice.message && current.notificationId === notice.notificationId && current.systemName === notice.systemName) return;
      clearTimer();
      const toast = { ...notice, id: ++nextId };
      current = toast;
      onChange(toast);
      cancelDismiss = scheduleDashboardToastDismiss(() => {
        if (disposed || current?.id !== toast.id) {
          return;
        }
        cancelDismiss = undefined;
        current = undefined;
        onChange(undefined);
      }, DASHBOARD_TOAST_DURATION_MS);
    },
    dismiss(id: number): void {
      if (disposed || current?.id !== id) {
        return;
      }
      clearTimer();
      current = undefined;
      onChange(undefined);
    },
    connectionRestored(system = false): void {
      if (!current || !(system ? /^(?:The owning system is offline\.|This system is offline\.|Offline saved view\.)/ : /^(?:The browser is offline\.|The host is offline\. This operation was not sent or queued\.|Offline saved view\.|Dashboard is still unavailable\.|Connection lost while loading)/).test(current.message)) return;
      clearTimer();
      current = undefined;
      onChange(undefined);
    },
    dispose(): void {
      disposed = true;
      clearTimer();
      current = undefined;
    }
  };
}
