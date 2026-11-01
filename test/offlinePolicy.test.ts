import { expect, it } from "vitest";
import { offlineReadCacheKey, canQueueOfflineAction } from "../webview-src/dashboard/offlinePolicy";

it("keeps local cached reads with their actual system across a host change", () => {
  const payload = { projectPath: "D:/project", filePath: "index.ts" };
  expect(offlineReadCacheKey("readWorkspaceFile", undefined, payload, "host-a")).not.toBe(
    offlineReadCacheKey("readWorkspaceFile", undefined, payload, "host-b")
  );
  expect(offlineReadCacheKey("readWorkspaceFile", undefined, { ...payload, targetDeviceId: "remote" }, "host-a")).toBe(
    offlineReadCacheKey("readWorkspaceFile", undefined, { ...payload, targetDeviceId: "remote" }, "host-b")
  );
  expect(offlineReadCacheKey("readWorkspaceFile", undefined, { ...payload, targetDeviceId: "local" }, "host-a")).toBe(
    offlineReadCacheKey("readWorkspaceFile", undefined, payload, "host-a")
  );
});

it("never queues execution or destructive actions offline", () => {
  for (const action of [
    "startCodexCliSession",
    "deleteCodexCliSession",
    "refreshToken",
    "pushWorkspaceBranch"
  ] as const)
    expect(canQueueOfflineAction(action)).toBe(false);
  expect(canQueueOfflineAction("saveProjectTask")).toBe(true);
  expect(canQueueOfflineAction("addProjectComment")).toBe(true);
});

it('shares project file caches across sessions while separating files, projects and history pages', () => {
  const key = (payload: Parameters<typeof offlineReadCacheKey>[2]) => offlineReadCacheKey('readWorkspaceFile', undefined, payload, 'pc');
  expect(key({ projectPath: 'D:/project', sessionId: 'one', filePath: 'a.ts' })).toBe(key({ projectPath: 'D:/project', sessionId: 'two', filePath: 'a.ts' }));
  expect(key({ sessionId: 'one' })).not.toBe(key({ sessionId: 'two' }));
  expect(key({ projectPath: 'D:/project', filePath: 'a.ts' })).not.toBe(key({ projectPath: 'D:/project', filePath: 'b.ts' }));
  expect(key({ projectPath: 'D:/one' })).not.toBe(key({ projectPath: 'D:/two' }));
  expect(key({ gitHistory: { offset: 0 } })).not.toBe(key({ gitHistory: { offset: 50 } }));
});
