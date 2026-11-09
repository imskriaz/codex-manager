import { afterEach, expect, it, vi } from "vitest";
import { WebDashboardServer } from "../src/services/webDashboardServer";
import { getCodexSessionLiveState } from "../src/services/codexSessionLive";
vi.mock("../src/services/codexSessionLive", async (original) => ({
  ...(await original<typeof import("../src/services/codexSessionLive")>()),
  getCodexSessionLiveState: vi.fn()
}));
vi.mock("../src/services/codexSessionResume", async (original) => ({
  ...(await original<typeof import("../src/services/codexSessionResume")>()),
  readCodexCliSessionRecoveryMetadata: vi.fn(async () => ({ session: { title: "Test conversation" } }))
}));
const state = {
  sessionId: "session",
  streamId: "old-turn",
  status: "failed",
  updatedAt: Date.now(),
  error: "hit your usage limit"
};
const host = () =>
  Object.assign(Object.create(WebDashboardServer.prototype), {
    deviceId: "this-pc",
    remoteSessionLive: new Map(),
    sessionFailurePushTimers: new Map(),
    browserPush: { notify: vi.fn() }
  }) as any;
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
it("cancels a pending failure push when the session resumes", async () => {
  vi.useFakeTimers();
  const server = host();
  server.scheduleSessionFailurePush({ ...state, updatedAt: Date.now() });
  server.scheduleSessionFailurePush({ ...state, status: "running", streamId: "new-turn", updatedAt: Date.now() });
  await vi.advanceTimersByTimeAsync(11_000);
  expect(server.browserPush.notify).not.toHaveBeenCalled();
});
it("rechecks current state and reports account limits as interruptions", async () => {
  vi.useFakeTimers();
  const server = host(),
    failure = { ...state, updatedAt: Date.now() };
  vi.mocked(getCodexSessionLiveState).mockReturnValue(failure as never);
  server.scheduleSessionFailurePush(failure);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(server.browserPush.notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "warning", message: expect.stringContaining("Account usage limit interrupted") })
  );
  server.browserPush.notify.mockClear();
  server.scheduleSessionFailurePush({ ...failure, updatedAt: Date.now() });
  vi.mocked(getCodexSessionLiveState).mockReturnValue({
    ...failure,
    status: "running",
    streamId: "recovered"
  } as never);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(server.browserPush.notify).not.toHaveBeenCalled();
});
it("does not push old failures replayed after host restart", async () => {
  vi.useFakeTimers();
  const server = host();
  server.scheduleSessionFailurePush({ ...state, updatedAt: Date.now() - 60_000 });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(server.browserPush.notify).not.toHaveBeenCalled();
});
