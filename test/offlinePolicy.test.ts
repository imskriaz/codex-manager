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
