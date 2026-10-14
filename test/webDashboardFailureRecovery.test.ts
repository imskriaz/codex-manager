import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardClientMessage, DashboardHostMessage } from "../src/domain/dashboard/types";

const { buildState, executeAction } = vi.hoisted(() => ({ buildState: vi.fn(), executeAction: vi.fn() }));
vi.mock("../src/application/dashboard/buildDashboardState", () => ({ buildDashboardState: buildState }));
vi.mock("../src/presentation/dashboard/actionHandlers", () => ({ executeDashboardActionMessage: executeAction }));
vi.mock("../src/services/announcements", () => ({ AnnouncementService: class { getState = vi.fn().mockResolvedValue({}); dispose() {} } }));
import { WebDashboardServer } from "../src/services/webDashboardServer";

afterEach(() => { vi.restoreAllMocks(); });

function createServer() {
  const server = new WebDashboardServer({ extension: { packageJSON: { version: "test" } }, extensionUri: { fsPath: process.cwd() }, globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) } } as never, {} as never);
  const internal = server as unknown as {
    processClientMessage(message: DashboardClientMessage): Promise<{ messages: DashboardHostMessage[]; reloadAfterResponse: boolean }>;
    webSocketServer: EventEmitter & { options: { maxPayload: number } };
  };
  return { server, internal };
}

describe("browser action completion during state failure", () => {
  it("returns a completed action within 250ms when its optional snapshot stalls", async () => {
    vi.useFakeTimers();
    buildState.mockReturnValue(new Promise(() => undefined));
    executeAction.mockResolvedValue({ status: "completed", payload: { reloadScheduled: true } });
    const { server, internal } = createServer();
    try {
      const work = internal.processClientMessage({ type: "dashboard:action", action: "switch", requestId: "slow-snapshot" });
      await vi.advanceTimersByTimeAsync(250);
      const result = await work;
      expect(result.reloadAfterResponse).toBe(true);
      expect(result.messages).toContainEqual(expect.objectContaining({ requestId: "slow-snapshot", status: "completed" }));
      expect(result.messages).toContainEqual(expect.objectContaining({ type: "dashboard:notice", level: "warning", message: expect.stringContaining("still loading") }));
    } finally { server.dispose(); vi.useRealTimers(); }
  });

  it("bounds a stalled explicit snapshot refresh and reports failure", async () => {
    vi.useFakeTimers();
    buildState.mockReturnValue(new Promise(() => undefined));
    executeAction.mockResolvedValue({ status: "completed" });
    const { server, internal } = createServer();
    try {
      const work = internal.processClientMessage({ type: "dashboard:action", action: "refreshView", requestId: "slow-refresh" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await work).messages).toContainEqual(expect.objectContaining({ requestId: "slow-refresh", status: "failed", error: "Dashboard state is still loading" }));
    } finally { server.dispose(); vi.useRealTimers(); }
  });
  it("preserves a successful mutation and scheduled reload when snapshot building fails", async () => {
    buildState.mockRejectedValue(new Error("storage temporarily unavailable"));
    executeAction.mockResolvedValue({ status: "completed", payload: { reloadScheduled: true } });
    const { server, internal } = createServer();
    try {
      const result = await internal.processClientMessage({ type: "dashboard:action", action: "switch", requestId: "switch-1" });
      expect(result.reloadAfterResponse).toBe(true);
      expect(result.messages).toContainEqual(expect.objectContaining({ type: "dashboard:action-result", requestId: "switch-1", status: "completed" }));
      expect(result.messages).toContainEqual(expect.objectContaining({ type: "dashboard:notice", level: "warning", message: expect.stringContaining("storage temporarily unavailable") }));
    } finally { server.dispose(); }
  });

  it("fails an explicit refresh when no snapshot can be produced", async () => {
    buildState.mockRejectedValue(new Error("cannot refresh"));
    executeAction.mockResolvedValue({ status: "completed" });
    const { server, internal } = createServer();
    try {
      const result = await internal.processClientMessage({ type: "dashboard:action", action: "refreshView", requestId: "refresh-1" });
      expect(result.messages).toContainEqual(expect.objectContaining({ type: "dashboard:action-result", requestId: "refresh-1", status: "failed", error: "cannot refresh" }));
    } finally { server.dispose(); }
  });

  it("bounds inbound messages and handles peer socket errors without crashing the host", () => {
    const { server, internal } = createServer();
    const socket = new EventEmitter();
    try {
      expect(internal.webSocketServer.options.maxPayload).toBe(2 * 1024 * 1024);
      internal.webSocketServer.emit("connection", socket, { url: "/ws?peer=1&deviceId=test" });
      expect(() => socket.emit("error", new Error("oversized message"))).not.toThrow();
    } finally { server.dispose(); }
  });
});
