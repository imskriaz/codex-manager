import type { DashboardWorkspaceTerminalOutput, DashboardWorkspaceTerminalResult } from "./dashboard/types";

export type WorkspaceTerminalActivity = {
  outputs: Record<string, DashboardWorkspaceTerminalOutput>;
  results: DashboardWorkspaceTerminalResult[];
  completed: string[];
};
export const emptyWorkspaceTerminalActivity: WorkspaceTerminalActivity = { outputs: {}, results: [], completed: [] };
export const terminalActivityKey = (item: { id: string; deviceId?: string }): string => `${item.deviceId ?? "local"}:${item.id}`;

export function reduceWorkspaceTerminalActivity(state: WorkspaceTerminalActivity, event:
  | { output: DashboardWorkspaceTerminalOutput; replay?: boolean }
  | { result: DashboardWorkspaceTerminalResult }
  | { clear: true; deviceId?: string }
  | { resetDevice: string }
): WorkspaceTerminalActivity {
  if ("clear" in event) return { ...state, results: event.deviceId ? state.results.filter((result) => (result.deviceId ?? "local") !== event.deviceId) : [] };
  if ("resetDevice" in event) {
    let next = state;
    for (const output of Object.values(state.outputs)) {
      if ((output.deviceId ?? "local") !== event.resetDevice) continue;
      next = reduceWorkspaceTerminalActivity(next, { result: { ...output, output: `${output.chunk}\nTerminal monitoring restarted. Command status is unconfirmed; check the VS Code terminal before retrying.`, durationMs: 0, finishedAt: new Date().toISOString(), status: "untracked" } });
    }
    return next;
  }
  const item = "output" in event ? event.output : event.result;
  const key = terminalActivityKey(item);
  if (state.completed.includes(key)) return state;
  if ("output" in event) {
    const previous = state.outputs[key];
    if (previous && previous.sequence >= event.output.sequence) return state;
    const output = { ...event.output, chunk: (event.replay ? event.output.chunk : (previous?.chunk ?? "") + event.output.chunk).slice(-16_384) };
    // ponytail: retain the latest 32 streams and 64 completions; use a paged
    // terminal history if users need more concurrent terminal dashboards.
    const entries: Array<[string, DashboardWorkspaceTerminalOutput]> = [...Object.entries(state.outputs).filter(([id]) => id !== key), [key, output]];
    const outputs = Object.fromEntries(entries.slice(-32));
    return { ...state, outputs };
  }
  const outputs = { ...state.outputs };
  delete outputs[key];
  return { outputs, results: [...state.results, { ...event.result, output: event.result.output.slice(-16_384) }].slice(-64), completed: [...state.completed, key].slice(-64) };
}
