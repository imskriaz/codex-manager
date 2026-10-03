import { describe, expect, it } from "vitest";
import { mergeCachedCliSession, mergeCachedCliSessions } from "../webview-src/dashboard/cliSessionCache";

describe("CLI session cache merging", () => {
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
