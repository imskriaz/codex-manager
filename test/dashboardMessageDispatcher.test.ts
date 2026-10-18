import { afterEach, expect, it, vi } from "vitest";
import { dispatchDashboardClientMessage, type DashboardMessageHandlers } from "../src/presentation/dashboard/messageDispatcher";
import * as diagnostics from "../src/utils/persistentLog";

afterEach(() => vi.restoreAllMocks());
it("leaves action auditing to the action handler and excludes startup and history synchronization", async () => {
  const audit = vi.spyOn(diagnostics, "runWithPersistentOperation");
  const handlers: DashboardMessageHandlers = {
    onReady: vi.fn(), onAction: vi.fn(), onSetting: vi.fn(), onUsageHistory: vi.fn(),
    onPickCodexAppPath: vi.fn(), onClearCodexAppPath: vi.fn(), onPickCodexCliPath: vi.fn(), onClearCodexCliPath: vi.fn()
  };
  await dispatchDashboardClientMessage({ type: "dashboard:ready" }, handlers);
  await dispatchDashboardClientMessage({ type: "dashboard:usage-history", samples: [] }, handlers);
  await dispatchDashboardClientMessage({ type: "dashboard:action", action: "viewLogs", requestId: "read" }, handlers);
  expect(handlers.onReady).toHaveBeenCalledOnce();
  expect(handlers.onUsageHistory).toHaveBeenCalledOnce();
  expect(handlers.onAction).toHaveBeenCalledOnce();
  expect(audit).not.toHaveBeenCalled();
  vi.mocked(handlers.onAction).mockRejectedValueOnce(new Error("read failed"));
  await expect(dispatchDashboardClientMessage({ type: "dashboard:action", action: "viewLogs", requestId: "failed" }, handlers)).rejects.toThrow("read failed");
  expect(audit).not.toHaveBeenCalled();
  await dispatchDashboardClientMessage({ type: "dashboard:setting", key: "persistentLoggingEnabled", value: false }, handlers);
  expect(audit).toHaveBeenCalledOnce();
});
