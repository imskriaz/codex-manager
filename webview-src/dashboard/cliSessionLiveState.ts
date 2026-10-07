import type { DashboardCliSessionMessage, DashboardCliSessionSummary, DashboardCodexSessionLiveState } from "../../src/domain/dashboard/types";
import { isNewerCodexSessionLiveState } from "../../src/domain/codexSessionLive";

export function isCliTurnActive(state: DashboardCodexSessionLiveState | undefined): boolean {
  return state?.status === "starting" || state?.status === "running";
}

/** Keep a delayed session-index refresh from reviving a completed live turn. */
export function reconcileCliSessionStatuses(
  sessions: DashboardCliSessionSummary[],
  liveStates: Record<string, DashboardCodexSessionLiveState>
): DashboardCliSessionSummary[] {
  return sessions.map((session) => reconcileCliSessionStatus(session, liveStates));
}

export function reconcileCliSessionStatus(
  session: DashboardCliSessionSummary,
  liveStates: Record<string, DashboardCodexSessionLiveState>
): DashboardCliSessionSummary {
  const live = liveStates[`${session.deviceId ?? "local"}:${session.id}`];
  if (!live || live.sessionId !== session.id || (live.deviceId ?? undefined) !== (session.deviceId ?? undefined)) return session;
  // A later index update can describe a new turn started outside this host.
  if (Date.parse(session.updatedAt ?? "") > live.updatedAt) return session;
  if (isCliTurnActive(live)) return { ...session, status: "running" };
  if (["completed", "cancelled", "failed"].includes(live.status)) return { ...session, status: "idle", locked: false, canStop: false, runningBy: undefined };
  return session;
}

/** Full snapshots replace earlier snapshots; a terminal stream cannot become running again. */
export function acceptCliLiveState(previous: DashboardCodexSessionLiveState | undefined, incoming: DashboardCodexSessionLiveState): boolean {
  if (!incoming.streamId || !incoming.sessionId || !Number.isSafeInteger(incoming.sequence) || incoming.sequence < 0 || !Number.isFinite(incoming.updatedAt)) return false;
  if (previous && (previous.sessionId !== incoming.sessionId || previous.deviceId !== incoming.deviceId)) return false;
  return isNewerCodexSessionLiveState(incoming, previous);
}

/** Replace the current turn suffix instead of accumulating duplicate streamed/transcript items. */
export function combineCliLiveMessages(history: DashboardCliSessionMessage[], live: DashboardCodexSessionLiveState | undefined): DashboardCliSessionMessage[] {
  if (!live?.messages.length) return history;
  const exactTurn = live.turnId ? history.findIndex((item) => item.turnId === live.turnId) : -1;
  const ids = new Set(live.messages.map((item) => item.id));
  const exactItem = history.findIndex((item) => ids.has(item.id));
  let boundary = exactTurn >= 0 ? exactTurn : exactItem;
  if (boundary < 0) {
    const prompt = live.messages.find((item) => item.role === "user" && (!item.kind || item.kind === "message"));
    if (prompt) {
      for (let index = history.length - 1; index >= 0; index--) {
        const item = history[index]!;
        if (item.role !== "user" || (item.kind && item.kind !== "message")) continue;
        const currentTurnEvidence = (prompt.timestamp && item.timestamp === prompt.timestamp)
          || history.slice(index).some((activity) => activity.status === "inProgress");
        if (item.text === prompt.text && currentTurnEvidence && (!item.turnId || !live.turnId || item.turnId === live.turnId)) boundary = index;
        break;
      }
    }
  }
  return [...(boundary >= 0 ? history.slice(0, boundary) : history), ...live.messages];
}
