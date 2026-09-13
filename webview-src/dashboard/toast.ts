import type { DashboardNotice } from "../../src/domain/dashboard/types";

export const DASHBOARD_TOAST_DURATION_MS = 10_000;

export type DashboardToast = DashboardNotice & { id: number };

export function scheduleDashboardToastDismiss(onDismiss: () => void): () => void {
  const timeout = globalThis.setTimeout(onDismiss, DASHBOARD_TOAST_DURATION_MS);
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
      if (disposed) {
        return;
      }
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
      });
    },
    dismiss(id: number): void {
      if (disposed || current?.id !== id) {
        return;
      }
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
