import type { DashboardHostMessage } from "../domain/dashboard/types";
import { randomUUID } from "node:crypto";
import { emptyWorkspaceTerminalActivity, reduceWorkspaceTerminalActivity } from "../domain/workspaceTerminalActivity";

let terminalActivity = emptyWorkspaceTerminalActivity;
const terminalActivityEpoch = randomUUID();
export function readWorkspaceTerminalActivity() {
  return {
    terminalActivityEpoch,
    terminalLiveOutputs: Object.values(terminalActivity.outputs).filter((output) => !output.deviceId),
    terminalResults: terminalActivity.results.filter((result) => !result.deviceId)
  };
}

type DashboardRealtimeListener = (message: DashboardHostMessage) => void;

const listeners = new Set<DashboardRealtimeListener>();

/** Subscribe a dashboard host (for example the browser server) to transient
 * events produced by another host, such as the VS Code webview. */
export function subscribeDashboardRealtime(listener: DashboardRealtimeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishDashboardRealtime(message: DashboardHostMessage): void {
  if (message.type === "dashboard:terminal-output") terminalActivity = reduceWorkspaceTerminalActivity(terminalActivity, { output: message.output });
  if (message.type === "dashboard:terminal-complete") terminalActivity = reduceWorkspaceTerminalActivity(terminalActivity, { result: message.result });
  for (const listener of listeners) {
    try {
      listener(message);
    } catch (error) {
      console.warn("[codexManager] dashboard realtime listener failed", error);
    }
  }
}
