import type { DashboardCliSessionSummary, DashboardCodexSessionLiveState } from "../../src/domain/dashboard/types";
import { isNewerCodexSessionLiveState } from "../../src/domain/codexSessionLive";
import { cliSessionTargetKey, sameCliSessionTarget } from "./cliSessionRoute";

import { isCliTurnActive } from "../../src/domain/codexSessionState";
export { isCliTurnActive } from "../../src/domain/codexSessionState";

export function isCliLiveStateCurrent(session: DashboardCliSessionSummary | undefined, live: DashboardCodexSessionLiveState | undefined): boolean {
  return Boolean(session && live && sameCliSessionTarget(session, { id: live.sessionId, deviceId: live.deviceId }) &&
    !(Date.parse(session.updatedAt ?? "") > live.updatedAt));
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
  const live = liveStates[cliSessionTargetKey(session)];
  // A later index update can describe a new turn started outside this host.
  if (!live || !isCliLiveStateCurrent(session, live)) return session;
  if (isCliTurnActive(live)) return { ...session, status: "running", interrupted: false };
  if (["completed", "cancelled", "failed"].includes(live.status)) return { ...session, status: "idle", locked: false, canStop: false, runningBy: undefined, runningSince: undefined, interrupted: live.status === "failed" };
  return session;
}

/** Full snapshots replace earlier snapshots; a terminal stream cannot become running again. */
export function acceptCliLiveState(previous: DashboardCodexSessionLiveState | undefined, incoming: DashboardCodexSessionLiveState): boolean {
  if (!incoming.streamId || !incoming.sessionId || !Number.isSafeInteger(incoming.sequence) || incoming.sequence < 0 || !Number.isFinite(incoming.updatedAt)) return false;
  if (previous && (previous.sessionId !== incoming.sessionId || previous.deviceId !== incoming.deviceId)) return false;
  return isNewerCodexSessionLiveState(incoming, previous);
}

export { combineCliLiveMessages } from "../../src/domain/codexSessionLive";
