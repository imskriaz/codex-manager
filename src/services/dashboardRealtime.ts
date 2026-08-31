import type { DashboardHostMessage } from "../domain/dashboard/types";

type DashboardRealtimeListener = (message: DashboardHostMessage) => void;

const listeners = new Set<DashboardRealtimeListener>();

/** Subscribe a dashboard host (for example the browser server) to transient
 * events produced by another host, such as the VS Code webview. */
export function subscribeDashboardRealtime(listener: DashboardRealtimeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishDashboardRealtime(message: DashboardHostMessage): void {
  for (const listener of listeners) {
    try {
      listener(message);
    } catch (error) {
      console.warn("[codexManager] dashboard realtime listener failed", error);
    }
  }
}
