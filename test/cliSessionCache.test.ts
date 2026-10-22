import { describe, expect, it } from "vitest";
import { mergeCachedCliSession, mergeCachedCliSessions } from "../webview-src/dashboard/cliSessionCache";

describe("CLI session cache merging", () => {
  it('replaces only the source PC rows and retains equal session IDs on other PCs', () => {
    const local = { id: 'shared-id', title: 'Local', status: 'idle' as const };
    const remote = { ...local, deviceId: 'remote', remote: true, title: 'Remote' };
    const other = { ...remote, deviceId: 'other', title: 'Other' };
    expect(mergeCachedCliSessions([{ ...remote, title: 'Updated' }], [local, remote, other], 'remote')).toEqual([local, other, { ...remote, title: 'Updated' }]);
    expect(mergeCachedCliSessions([], [local, remote, other], 'remote')).toEqual([local, other]);
    expect(mergeCachedCliSessions([local], [local, remote, other], 'remote')).toEqual([local, other]);
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
      previous
    )[0]?.projectPath).toBeUndefined();
  });

  it("keeps selected-session folder metadata during a short refresh gap", () => {
    expect(mergeCachedCliSession(
      { id: "session-1", title: "Updated", status: "idle" },
      { id: "session-1", title: "Old", status: "idle", projectPath: "D:/Projects/demo" }
    ).projectPath).toBe("D:/Projects/demo");
  });
});
