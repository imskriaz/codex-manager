import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn(), spawn: vi.fn() }));
vi.mock("child_process", async (original) => ({ ...await original<typeof import("child_process")>(), spawn: mocks.spawn }));
vi.mock("../src/services/codexAppServerRpc", () => ({ CodexAppServerRpc: { open: mocks.open }, CodexAppServerTurnInterruptedError: class extends Error {}, CodexAppServerDisconnectedError: class extends Error {} }));
import { startCodexCliSession, cancelCodexCliSessionTurn, readNewCodexCliSessionSummary, steerCodexCliSessionTurn } from "../src/services/codexSessionResume";
import { getCodexSessionLiveState } from "../src/services/codexSessionLive";

const id = "01a04882-d037-7a42-ad24-9afb61901199";
let root: string;
let previousHome: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-native-start-"));
  previousHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = root;
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback, inspect: () => ({ globalValue: "app-server-stdio", workspaceValue: "cli" }) } as unknown as vscode.WorkspaceConfiguration);
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = previousHome;
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback } as vscode.WorkspaceConfiguration);
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("native App Server new sessions", () => {
  it("steers only the expected owned turn through its existing connection", async () => {
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    const rpc = { request: vi.fn(async (method: string) => method === "turn/steer" ? { turnId: "turn-1" } : { thread: { id } }), onServerRequest: () => () => undefined, onNotification: () => () => undefined, close: vi.fn(), startAndWaitForTurn: vi.fn(async (_id: string, _params: unknown, _timeout: number, started: (id: string) => void) => { started("turn-1"); await completed; }) };
    mocks.open.mockResolvedValue(rpc);
    try {
      await startCodexCliSession({ text: "First prompt", projectPath: root });
      await expect(steerCodexCliSessionTurn({ sessionId: id, expectedTurnId: "other", text: "Guide" })).rejects.toThrow(/turn changed/);
      await steerCodexCliSessionTurn({ sessionId: id, expectedTurnId: "turn-1", text: "Guide" });
      expect(rpc.request).toHaveBeenCalledWith("turn/steer", { threadId: id, expectedTurnId: "turn-1", input: [expect.objectContaining({ text: "Guide", type: "text" })] });
      expect(mocks.open).toHaveBeenCalledTimes(1);
      expect(getCodexSessionLiveState(id)?.status).toBe("running");
    } finally { finish(); await completed; await new Promise((resolve) => setTimeout(resolve, 0)); }
    await expect(steerCodexCliSessionTurn({ sessionId: id, expectedTurnId: "turn-1", text: "Guide" })).rejects.toThrow(/does not own/);
  });
  it("acknowledges the first accepted turn immediately and stops through App Server without launching exec", async () => {
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    const rpc = { request: vi.fn(async () => ({ thread: { id } })), onServerRequest: () => () => undefined, onNotification: () => () => undefined, close: vi.fn(), startAndWaitForTurn: vi.fn(async (_id: string, _params: unknown, _timeout: number, started: (id: string) => void) => { started("turn-1"); await completed; }) };
    mocks.open.mockResolvedValue(rpc);
    try {
      await expect(startCodexCliSession({ text: "First prompt", projectPath: root, reasoningEffort: "high", sandboxMode: "read-only" })).resolves.toBe(id);
      expect(rpc.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ cwd: root, sandbox: "read-only" }));
      expect(rpc.startAndWaitForTurn).toHaveBeenCalledWith(id, expect.objectContaining({ effort: "high", input: [expect.objectContaining({ type: "text", text: "First prompt" })] }), expect.any(Number), expect.any(Function));
      expect(readNewCodexCliSessionSummary(id)).toMatchObject({ status: "running", canStop: true });
      await expect(cancelCodexCliSessionTurn(id)).resolves.toBe(true);
      expect(rpc.request).toHaveBeenCalledWith("turn/interrupt", { threadId: id, turnId: "turn-1" }, 10000);
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally { finish(); await completed; await new Promise((resolve) => setTimeout(resolve, 0)); }
    expect(rpc.close).toHaveBeenCalled();
  });
  it("reports initialization failure without silently falling back to CLI exec", async () => {
    mocks.open.mockRejectedValue(new Error("initialize unavailable"));
    await expect(startCodexCliSession({ text: "First prompt", projectPath: root })).rejects.toThrow("initialize unavailable");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("reports a rejected first turn and closes its App Server connection", async () => {
    const rpc = { request: vi.fn(async () => ({ thread: { id } })), onServerRequest: () => () => undefined, onNotification: () => () => undefined, close: vi.fn(), startAndWaitForTurn: vi.fn(async () => { throw new Error("Quota unavailable. Switch accounts."); }) };
    mocks.open.mockResolvedValue(rpc);
    await expect(startCodexCliSession({ text: "First prompt", projectPath: root })).rejects.toThrow("Quota unavailable");
    expect(rpc.close).toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
