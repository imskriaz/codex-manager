import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), goals: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("../src/services/codexSessionGoals", () => ({ readCodexSessionGoals: mocks.goals }));
import { CodexAppServerRpc } from "../src/services/codexAppServerRpc";

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
const id = "01a04882-d037-7a42-ad24-9afb61901188";

describe("official Codex boundary", () => {
  it.each(["thread/start", "thread/resume", "turn/start", "thread/name/set", "thread/goal/set", "model/list"])("never starts a private server for unsupported %s", async method => {
    const rpc = await CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    await expect(rpc.request(method, { threadId: id })).rejects.toThrow("Use the official Codex UI");
    rpc.close(); rpc.close();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each([["thread/archive", "archive"], ["thread/unarchive", "unarchive"], ["thread/delete", "delete"]] as const)("uses the official CLI for %s", async (method, command) => {
    mocks.execFile.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => callback(null, "", ""));
    const rpc = await CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    await expect(rpc.request(method, { threadId: id })).resolves.toBeUndefined();
    expect(mocks.execFile).toHaveBeenCalledWith("codex", [command, id, ...(command === "delete" ? ["--force"] : [])], expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: expect.any(String) }) }), expect.any(Function));
  });
  it("keeps the native failure detail for a failed maintenance command", async () => {
    mocks.execFile.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => callback(new Error("exit 1"), "", "Session is already active\n"));
    const rpc = await CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    await expect(rpc.request("thread/delete", { threadId: id })).rejects.toThrow("Session is already active");
  });
  it("reads existing goal metadata without taking ownership or starting a process", async () => {
    const goal = { objective: "Finish work", status: "active" };
    mocks.goals.mockResolvedValue(new Map([[id, goal]]));
    const rpc = await CodexAppServerRpc.open({ command: "missing", prefixArgs: [] }, process.cwd());
    await expect(rpc.request("thread/goal/get", { threadId: id })).resolves.toEqual({ goal });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("keeps unavailable goal storage inconclusive", async () => {
    mocks.goals.mockResolvedValue(undefined);
    const rpc = await CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    await expect(rpc.request("thread/goal/get", { threadId: id })).rejects.toThrow("storage is unavailable");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("does not switch a metadata connection to another account home", async () => {
    vi.stubEnv("CODEX_HOME", process.cwd());
    const rpc = await CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    vi.stubEnv("CODEX_HOME", process.cwd() + "/other-home");
    await expect(rpc.request("thread/goal/get", { threadId: id })).rejects.toThrow("home changed");
  });
  it("never starts work or answers approvals through the retired private transport", async () => {
    const rpc = await CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    await expect(rpc.startAndWaitForTurn(id, {}, 100)).rejects.toThrow("official Codex UI");
    expect(() => rpc.answerServerRequest(1, {})).toThrow("official Codex UI");
    expect(() => rpc.rejectServerRequest(1, "no")).toThrow("official Codex UI");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("honors cancellation before creating a connection", async () => {
    const controller = new AbortController(); controller.abort(new Error("Cancelled"));
    await expect(CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd(), controller.signal)).rejects.toThrow("Cancelled");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
