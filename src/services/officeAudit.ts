import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getSqliteStateStore } from "../storage/sqliteState";
import type { DashboardCliSessionSummary } from "../domain/dashboard/types";

export type OfficeActor = { id: string; name: string; email?: string };
export type OfficeAuditEntry = { id: string; at: number; actor: OfficeActor; action: string; status: string; sessionId?: string };
const context = new AsyncLocalStorage<OfficeActor>();
export const localMasterActor: OfficeActor = { id: "master", name: "Master" };
export function officeActor(user: { id: string; username: string; displayName: string }): OfficeActor {
  return user.id === "master" ? localMasterActor : { id: user.id, name: user.displayName || user.username, ...(user.username.includes("@") ? { email: user.username } : {}) };
}
export function currentOfficeActor(): OfficeActor | undefined { return context.getStore(); }
export function withOfficeActor<T>(actor: OfficeActor, work: () => T): T { return context.run(actor, work); }

export function recordOfficeAudit(action: string, status: string, actor = currentOfficeActor(), sessionId?: string): boolean {
  if (!actor) return true;
  const store = getSqliteStateStore();
  if (!store) return true;
  try {
    store.transaction(() => {
      const entries = store.get<OfficeAuditEntry[]>("office-audit", "entries") ?? [];
      store.set("office-audit", "entries", [{ id: randomUUID(), at: Date.now(), actor, action, status, ...(sessionId ? { sessionId } : {}) }, ...entries].slice(0, 500));
    });
    return true;
  } catch (error) { console.warn("[codexManager] user audit could not be saved", error); return false; }
}
export function readOfficeAudit(): OfficeAuditEntry[] {
  const store = getSqliteStateStore();
  if (!store) throw new Error("Audit storage is unavailable. Retry when the host is ready.");
  return store.get<OfficeAuditEntry[]>("office-audit", "entries") ?? [];
}
export function recordSessionInitiator(sessionId: string, actor = currentOfficeActor()): void {
  const store = getSqliteStateStore();
  if (!actor || !store) return;
  store.transaction(() => {
    const previous = store.get<{ startedBy: OfficeActor }>("office-session-actors", sessionId);
    store.set("office-session-actors", sessionId, { startedBy: previous?.startedBy ?? actor, lastRunBy: actor });
  });
}
export function withSessionInitiator(session: DashboardCliSessionSummary): DashboardCliSessionSummary {
  if (session.remote || session.deviceId) return session;
  const actor = getSqliteStateStore()?.get<{ startedBy: OfficeActor; lastRunBy: OfficeActor }>("office-session-actors", session.id);
  return actor ? { ...session, startedBy: actor.startedBy, lastRunBy: actor.lastRunBy } : session;
}
