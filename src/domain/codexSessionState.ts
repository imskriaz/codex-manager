import type { DashboardCliSessionSummary, DashboardCodexSessionLiveState, DashboardCodexSessionGoal, DashboardPeerView } from "./dashboard/types";
import { readSubAgentMetadata } from "./sessionSource";

export function isCodexQuotaInterruption(message: string): boolean {
  return /usage[_ -]?limit(?:[_ -]?reached|ed)|usageLimitReached|hit (?:your |the )?usage limit|(?:quota|usage limit) (?:has been )?(?:exceeded|exhausted|reached)|insufficient_quota|quota_exceeded|out of quota/i.test(message);
}

export function isCodexCapacityInterruption(message: string): boolean {
  return /selected model is at capacity|model(?:[_ -](?:server|provider))?[_ -]?overloaded|server[_ -]?overloaded|(?:provider|model) capacity/i.test(message);
}

export function isCliTurnActive(state: DashboardCodexSessionLiveState | undefined): boolean {
  return state?.status === "starting" || state?.status === "running";
}

export function normalizeCodexSessionGoal(value: unknown): DashboardCodexSessionGoal | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const goal = value as Partial<DashboardCodexSessionGoal>;
  if (typeof goal.objective !== "string" || !goal.objective.trim() || goal.objective.length > 4096 ||
      typeof goal.status !== "string" || !/^[a-z_]{1,40}$/.test(goal.status) ||
      (goal.elapsedMs !== undefined && (!Number.isFinite(goal.elapsedMs) || goal.elapsedMs < 0 || goal.elapsedMs > Number.MAX_SAFE_INTEGER))) return undefined;
  return { objective: goal.objective.trim(), status: goal.status, elapsedMs: goal.elapsedMs };
}

export function isCodexSessionRunning(
  session: Pick<DashboardCliSessionSummary, "status" | "locked" | "archived"> | undefined
): boolean {
  return Boolean(session && !session.archived && (session.status === "running" || session.status === "unknown" || session.locked));
}

export function showsCodexSessionAutoResume(session: Pick<DashboardCliSessionSummary, "status" | "archived" | "interrupted" | "queueEnabled" | "queueError">): boolean {
  return !session.archived && (session.status === "running" ||
    (session.status === "idle" && session.interrupted === true && !session.queueEnabled && !session.queueError));
}

export function filterCliSessionsBySection(
  sessions: DashboardCliSessionSummary[],
  section: "active" | "archived"
): DashboardCliSessionSummary[] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    const key = `${session.deviceId ?? "local"}:${session.id}`;
    if (
      readSubAgentMetadata(session).subAgent ||
      seen.has(key) ||
      (session.archived === true) !== (section === "archived")
    )
      return false;
    seen.add(key);
    return true;
  });
}

export function countPeerSessions(
  sessions: DashboardCliSessionSummary[],
  peers: Array<{ id: string; local?: boolean }>
) {
  const active = filterCliSessionsBySection(sessions, "active");
  return peers.map((peer) => {
    const rows = active.filter((session) =>
      peer.local ? !session.remote : session.remote && session.deviceId === peer.id
    );
    return { id: peer.id, total: rows.length, running: rows.filter(isCodexSessionRunning).length };
  });
}

/** Keep cached PCs selectable without treating saved sessions as proof they are online. */
export function mergeDashboardPeers(
  peers: readonly DashboardPeerView[],
  sessions: readonly DashboardCliSessionSummary[]
): DashboardPeerView[] {
  const merged = peers.map((peer) => ({ ...peer }));
  const known = new Set(merged.map((peer) => peer.id));
  for (const session of sessions) {
    if (!session.remote || !session.deviceId || known.has(session.deviceId)) continue;
    known.add(session.deviceId);
    merged.push({ id: session.deviceId, name: session.deviceName?.trim() || "Remote PC", sessionCount: 0, connected: false, local: false });
  }
  return merged;
}

export function stabilizeCliSessionOrder(sessions: DashboardCliSessionSummary[], order: Map<string, number>): DashboardCliSessionSummary[] {
  const key = (session: DashboardCliSessionSummary) => `${session.deviceId ?? "local"}:${session.id}`;
  const incoming = new Set(sessions.map(key));
  const added = [...incoming].filter(id => !order.has(id));
  const start = order.size ? Math.min(0, ...order.values()) - added.length : 0;
  added.forEach((id, index) => order.set(id, start + index));
  for (const id of order.keys()) {
    if (order.size <= 6000) break;
    if (!incoming.has(id)) order.delete(id);
  }
  return [...sessions].sort((a, b) => order.get(key(a))! - order.get(key(b))!);
}
