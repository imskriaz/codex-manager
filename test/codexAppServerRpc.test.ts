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
  it("bounds incomplete protocol lines and rejects every waiter on disconnect", async () => {
    const processChild = child();
    const opening = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    const rpc = await opening;
    const request = rpc.request("thread/read", {});
    processChild.stdout.write("x".repeat(4 * 1024 * 1024 + 1));
    await expect(request).rejects.toThrow(/oversized unfinished/);
    expect(processChild.kill).toHaveBeenCalled();
  });

  it("keeps server requests separate when their ID matches a client request", async () => {
    const processChild = child();
    const opening = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    const rpc = await opening;
    const request = rpc.request("thread/read", {});
    const callback = vi.fn();
    rpc.onServerRequest(callback);
    processChild.stdout.write(JSON.stringify({ id: 2, method: "item/tool/requestUserInput", params: {} }) + "\n");
    expect(callback).toHaveBeenCalled();
    processChild.stdout.write(JSON.stringify({ id: 2, result: { confirmed: true } }) + "\n");
    await expect(request).resolves.toEqual({ confirmed: true });
    rpc.close();
  });

  it("refuses oversized requests and a full request queue without leaking waiters", async () => {
    const processChild = child();
    const opening = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    const rpc = await opening;
    await expect(rpc.request("turn/start", { text: "x".repeat(2 * 1024 * 1024 + 1) })).rejects.toThrow(/too large/);
    const requests = Array.from({ length: 64 }, () => rpc.request("thread/read", {}).catch((error: unknown) => error));
    await expect(rpc.request("thread/read", {})).rejects.toThrow(/queue is full/);
    rpc.close();
    expect((await Promise.all(requests)).every((value) => value instanceof Error)).toBe(true);
  });
  it("ignores malformed protocol envelopes without breaking initialization", async () => {
    const processChild = child();
    const opening = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    processChild.stdout.write('null\n[]\n42\n"diagnostic"\nnot json\n');
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    const rpc = await opening;
    rpc.close();
  });
  it("preserves the matching early completion when another turn completes before the start response", async () => {
    const processChild = child();
    const opening = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    const rpc = await opening;
    const turn = rpc.startAndWaitForTurn("thread-1", {}, 900000);
    for (const id of ["turn-1", "other-turn"]) {
      processChild.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id, status: "completed" } } }) + "\n");
    }
    processChild.stdout.write(JSON.stringify({ id: 2, result: { turn: { id: "turn-1" } } }) + "\n");
    await expect(turn).resolves.toBeUndefined();
    rpc.close();
  });
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
