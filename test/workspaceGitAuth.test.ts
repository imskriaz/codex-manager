import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkspaceGitAuth, workspaceGitAuthStatus } from "../src/services/workspaceGitAuth";

const mocks = vi.hoisted(() => ({ spawnPty: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/services/workspaceTerminalPty", () => ({
  loadPty: async () => ({ spawn: mocks.spawnPty }),
  releaseWindowsResources: vi.fn()
}));
vi.mock("../src/utils/crossWindowOperations", () => ({
  runCrossWindowExclusive: async (_key: string, _label: string, task: (signal: AbortSignal) => Promise<void>) =>
    task(new AbortController().signal)
}));

function fixture() {
  const events = new EventEmitter();
  const subscribe = (event: string, listener: (...args: unknown[]) => void) => {
    events.on(event, listener);
    return { dispose: () => events.off(event, listener) };
  };
  const terminal = {
    onData: (listener: (...args: unknown[]) => void) => subscribe("data", listener),
    onExit: (listener: (...args: unknown[]) => void) => subscribe("exit", listener),
    write: vi.fn(),
    kill: vi.fn()
  };
  mocks.spawnPty.mockReturnValue(terminal);
  const id = randomUUID();
  const cwd = "D:/fixture";
  const status = (cancel = false) => workspaceGitAuthStatus(cwd, id, cancel);
  const ready = async () => {
    expect(startWorkspaceGitAuth(cwd, id, "owner/repo.git")).toEqual({ status: "starting" });
    await Promise.resolve();
  };
  return { cwd, events, id, status, ready, terminal };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("workspace GitHub device authorization", () => {
  it("shows only the device code and verifies the credential with Git after approval", async () => {
    const { cwd, events, id, status, ready } = fixture();
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
      child.stdin.on("data", (data: Buffer) => {
        expect(data.toString()).toContain("path=owner/repo.git");
        child.stdout.write("password=secret-never-sent-to-dashboard\n");
        child.emit("close", 0);
      });
      return child;
    });
    await ready();
    events.emit("data", "ignore OTHER-CODE outside its own line\n");
    expect(status()).toEqual({ status: "starting" });
    events.emit("data", "Visit https://github.com/login/device and enter the following code:\r\n\u001b[1mT3ST-");
    events.emit("data", "C0DE\u001b[0m\r\n");
    expect(status()).toEqual({ status: "waiting", code: "T3ST-C0DE" });
    expect(workspaceGitAuthStatus("D:/other", id, false)).toMatchObject({ status: "failed" });
    expect(() => startWorkspaceGitAuth(cwd, randomUUID(), "owner/repo.git")).toThrow("already running");
    events.emit("exit", { exitCode: 0 });
    await vi.waitFor(() => expect(status()).toEqual({
      status: "completed", message: "GitHub HTTPS is authorized on the selected system."
    }));
  });

  it("confirms cancellation only after the child exits", async () => {
    const { events, status, ready, terminal } = fixture();
    await ready();
    expect(status(true)).toMatchObject({ status: "starting" });
    expect(terminal.write).toHaveBeenCalledWith("\x03");
    events.emit("exit", { exitCode: 58 });
    await vi.waitFor(() => expect(status()).toMatchObject({ status: "cancelled" }));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("reports a missing device code within the startup deadline", async () => {
    vi.useFakeTimers();
    const { events, status, ready, terminal } = fixture();
    await ready();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(terminal.write).toHaveBeenCalledWith("\x03");
    events.emit("exit", { exitCode: 58 });
    await Promise.resolve();
    expect(status()).toMatchObject({ status: "failed", message: expect.stringContaining("did not return a device code") });
  });

  it("reports an inconclusive cancellation if the helper never confirms exit", async () => {
    vi.useFakeTimers();
    const { status, ready, terminal } = fixture();
    await ready();
    status(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(terminal.kill).toHaveBeenCalledOnce();
    expect(status()).toMatchObject({ status: "failed", message: expect.stringContaining("could not confirm") });
  });
});
