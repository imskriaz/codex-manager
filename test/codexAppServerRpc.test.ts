import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mocks.spawn }));
import { CodexAppServerRpc } from "../src/services/codexAppServerRpc";

function child() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  mocks.spawn.mockReturnValue(process);
  return process;
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("app-server initialization recovery", () => {
  it("fails an accepted turn immediately when the server exits", async () => {
    const processChild = child();
    const opening = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    const rpc = await opening;
    const turn = rpc.startAndWaitForTurn("thread-1", {}, 900000);
    processChild.stdout.write(JSON.stringify({ id: 2, result: { turn: { id: "turn-1" } } }) + "\n");
    await Promise.resolve();
    processChild.emit("close", 1);
    await expect(turn).rejects.toThrow("exited with code 1");
  });
  it("allows a slow initialization beyond ten seconds and launches Node shims correctly in Electron", async () => {
    vi.useFakeTimers();
    const processChild = child();
    const pending = CodexAppServerRpc.open({ command: process.execPath, prefixArgs: ["codex.js"] }, process.cwd());
    await vi.advanceTimersByTimeAsync(11_000);
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    const rpc = await pending;
    expect(mocks.spawn.mock.calls[0]?.[2].env.ELECTRON_RUN_AS_NODE).toBe("1");
    rpc.close();
    expect(processChild.kill).toHaveBeenCalled();
  });
  it("bounds initialization and terminates the abandoned process", async () => {
    vi.useFakeTimers();
    const processChild = child();
    const pending = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    const assertion = expect(pending).rejects.toThrow(/initialize within 30 seconds/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(processChild.kill).toHaveBeenCalled();
  });
  it("reports pipe failures immediately without leaving initialization waiting", async () => {
    const processChild = child();
    const pending = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    processChild.stdin.emit("error", new Error("pipe closed"));
    await expect(pending).rejects.toThrow("pipe closed");
    expect(processChild.kill).toHaveBeenCalled();
  });
});
