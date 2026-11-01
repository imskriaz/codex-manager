import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeCachedCliSession, mergeCachedCliSessions, mergeConfirmedCliSession, scopeDashboardAccounts } from "../webview-src/dashboard/cliSessionCache";
import { writeCliComposerDraft, hasUnsavedCliComposerDrafts } from '../webview-src/dashboard/cliSessionCache';

afterEach(() => { vi.unstubAllGlobals(); });
it('settles thrown draft writes as failed and prevents automatic reopening until the draft is cleared', async () => {
  vi.stubGlobal('indexedDB', { open: () => {
    const request = { result: { transaction: () => { throw new DOMException('Storage full', 'QuotaExceededError'); } }, onsuccess: undefined as undefined | (() => void) };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } });
  expect(await writeCliComposerDraft('storage-full', { text: 'Keep my draft', attachments: [] })).toBe(false);
  expect(hasUnsavedCliComposerDrafts()).toBe(true);
  expect(await writeCliComposerDraft('storage-full', { text: '', attachments: [] })).toBe(false);
  expect(hasUnsavedCliComposerDrafts()).toBe(false);
});

describe("CLI session cache merging", () => {
  it('applies confirmed preferences, renames and goal changes independently of a newer transcript timestamp', () => {
    const previous = { id: 'session', title: 'Old title', status: 'running' as const, canStop: true, updatedAt: '2026-11-01T12:00:00Z', autoResumeEnabled: true, queueEnabled: true, queuePriority: 2 as const, queueError: 'Old failure', goal: { objective: 'Work', status: 'active' as const } };
    const incoming = { ...previous, status: 'idle' as const, canStop: false, updatedAt: '2026-11-01T11:00:00Z', autoResumeEnabled: false, queueEnabled: false, queuePriority: undefined, queueError: undefined, title: 'Confirmed title', goal: null };
    for (const action of ['setCodexSessionAutoResume', 'setCodexSessionQueue'] as const) {
      expect(mergeConfirmedCliSession(incoming, previous, action)).toMatchObject({ status: 'running', canStop: true, title: 'Old title', autoResumeEnabled: false, queueEnabled: false, queuePriority: undefined, queueError: undefined });
    }
    expect(mergeConfirmedCliSession(incoming, previous, 'renameCodexCliSession')).toMatchObject({ title: 'Confirmed title', status: 'running', autoResumeEnabled: true });
    expect(mergeConfirmedCliSession(incoming, previous, 'setCodexSessionGoalStatus')).toMatchObject({ goal: null, status: 'running' });
    expect(mergeCachedCliSession(incoming, previous)).toBe(previous);
  });
  it('preserves archive metadata during partial refreshes and ignores older snapshots', () => {
    const archived = {id:'archived',title:'Archived task',status:'idle' as const,archived:true,updatedAt:'2026-10-31T10:00:00Z'};
    const partial = {id:'archived',title:'Archived task',status:'unknown' as const};
    expect(mergeCachedCliSession(partial,archived).archived).toBe(true);
    expect(mergeCachedCliSession({...archived,archived:false,updatedAt:'2026-10-31T09:00:00Z'},archived)).toBe(archived);
    expect(mergeCachedCliSession({...archived,archived:false,updatedAt:'2026-10-31T11:00:00Z'},archived).archived).toBe(false);
  });
  it("keeps only the selected remote account catalogue in live state", () => {
    const a = [{ id: "same-id", email: "a@example.test" }], b = [{ id: "same-id", email: "b@example.test" }];
    const state = { accounts: [], peerAccounts: { a, b } } as never;
    expect(scopeDashboardAccounts(state, "a").peerAccounts).toEqual({ a });
    expect(scopeDashboardAccounts(state, "b").peerAccounts).toEqual({ b });
    expect(scopeDashboardAccounts(state).peerAccounts).toEqual({});
    expect(scopeDashboardAccounts(state, "missing").peerAccounts).toEqual({});
    expect((state as { peerAccounts: unknown }).peerAccounts).toEqual({ a, b });
  });
  it('replaces only the source PC rows and retains equal session IDs on other PCs', () => {
    const local = { id: 'shared-id', title: 'Local', status: 'idle' as const };
    const remote = { ...local, deviceId: 'remote', remote: true, title: 'Remote' };
    const other = { ...remote, deviceId: 'other', title: 'Other' };
    expect(mergeCachedCliSessions([{ ...remote, title: 'Updated' }], [local, remote, other], 'remote')).toEqual([local, other, { ...remote, title: 'Updated' }]);
    expect(mergeCachedCliSessions([], [local, remote, other], 'remote')).toEqual([local, other]);
    expect(mergeCachedCliSessions([local], [local, remote, other], 'remote')).toEqual([local, other]);
  });
  it("isolates local refreshes, truncated pushes, duplicates and authoritative deletions", () => {
    const local = { id: "local", title: "Local", status: "idle" as const };
    const a = { ...local, id: "a", deviceId: "remote", remote: true };
    const b = { ...a, id: "b", status: "running" as const };
    expect(mergeCachedCliSessions([], [local, a, b])).toEqual([a, b]);
    expect(mergeCachedCliSessions([local, { ...a, title: "Stale aggregate" }], [a, b])).toEqual([local, a, b]);
    expect(mergeCachedCliSessions([{ ...a, title: "Updated" }, { ...a, title: "Newest" }], [local, a, b], "remote", true)).toEqual([local, b, { ...a, title: "Newest" }]);
    expect(mergeCachedCliSessions([], [local, a, b], "remote", true)).toEqual([local, a, b]);
    expect(mergeCachedCliSessions([], [local, a, b], "remote")).toEqual([local]);
    expect(mergeCachedCliSessions([{ ...a, title: "Stale aggregate" }], [local])).toEqual([]);
  });
  it("restores missing cached rows without rolling back a live partial status", () => {
    const old = { id: "live", title: "Work", status: "idle" as const, deviceId: "remote" };
    const live = { ...old, status: "running" as const };
    const older = { ...old, id: "older" };
    const local = { id: "local", title: "Local", status: "idle" as const };
    const restored = mergeCachedCliSessions([old, older], [local, live], "remote");
    expect(mergeCachedCliSessions([local, live], restored, "remote", true)).toEqual([local, older, live]);
  });
  it("keeps unavailable goal and model metadata without retaining stale runtime status", () => {
    const prior={id:"session",title:"Task",status:"running" as const,model:"gpt-5",reasoningEffort:"high",goal:{objective:"Finish",status:"active"},subAgent:true,parentSessionId:"parent",agentName:"Reviewer"};
    const incoming={id:"session",title:"Task",status:"unknown" as const,canStop:false};
    const merged=mergeCachedCliSessions([incoming],[prior])[0];
    expect(merged).toMatchObject({...prior,status:"unknown",canStop:false});
    expect(mergeCachedCliSession({...incoming,goal:null},prior).goal).toBeNull();
    expect(mergeCachedCliSession({...incoming,goal:{objective:"Finish",status:"paused"}},prior).goal?.status).toBe("paused");
    expect(mergeCachedCliSession({...incoming,deviceId:"other"},prior).goal).toBeUndefined();
    expect(prior.status).toBe("running");
  });
  it("reuses complete incoming metadata without cloning it or restoring deleted rows",()=>{
    const incoming={id:"session",title:"New",status:"idle" as const,model:"gpt-5",goal:null};
    expect(mergeCachedCliSession(incoming,{...incoming,goal:{objective:"Old",status:"active"}})).toBe(incoming);
    expect(mergeCachedCliSessions([], [incoming])).toEqual([]);
  });
  it("does not reuse a selected folder for a different session or device", () => {
    const previous = { id: "session-1", title: "Old", status: "idle" as const, deviceId: "pc-a", projectPath: "D:/Secret" };
    expect(mergeCachedCliSession({ ...previous, id: "session-2", projectPath: undefined }, previous).projectPath).toBeUndefined();
    expect(mergeCachedCliSession({ ...previous, deviceId: "pc-b", projectPath: undefined }, previous).projectPath).toBeUndefined();
  });
  it("keeps a known project folder when a partial refresh omits it", () => {
    const previous = [{
      id: "session-1",
      title: "Persisted project",
      status: "idle" as const,
      projectPath: "D:/Projects/demo"
    }];

    expect(mergeCachedCliSessions(
      [{ id: "session-1", title: "Persisted project", status: "running" }],
      previous
    )).toEqual([{
      id: "session-1",
      title: "Persisted project",
      status: "running",
      projectPath: "D:/Projects/demo"
    }]);
  });

  it("does not mix folders between PCs with the same session id", () => {
    const previous = [{
      id: "session-1",
      title: "Remote project",
      status: "idle" as const,
      deviceId: "pc-a",
      projectPath: "D:/Projects/remote"
    }];

    expect(mergeCachedCliSessions(
      [{ id: "session-1", title: "Other PC", status: "idle", deviceId: "pc-b" }],
      previous, "pc-b"
    ).find(session => session.deviceId === "pc-b")?.projectPath).toBeUndefined();
  });

  it("keeps selected-session folder metadata during a short refresh gap", () => {
    expect(mergeCachedCliSession(
      { id: "session-1", title: "Updated", status: "idle" },
      { id: "session-1", title: "Old", status: "idle", projectPath: "D:/Projects/demo" }
    ).projectPath).toBe("D:/Projects/demo");
  });
});
