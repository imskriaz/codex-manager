import { describe, expect, it } from "vitest";
import { mergeCachedCliSession, mergeCachedCliSessions, scopeDashboardAccounts } from "../webview-src/dashboard/cliSessionCache";

describe("CLI session cache merging", () => {
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
