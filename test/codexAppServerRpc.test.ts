import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mocks.spawn }));
import { CodexAppServerRpc } from "../src/services/codexAppServerRpc";

function child() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  process.kill.mockImplementation(() => { process.emit("exit", 0); return true; });
  mocks.spawn.mockReturnValue(process);
  return process;
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("app-server initialization recovery", () => {
  it('checks an idle stream and keeps a confirmed long turn alive without replaying it', async () => {
    vi.useFakeTimers();
    const processChild = child(); processChild.stdin.resume();
    const opening = CodexAppServerRpc.open({ command: 'codex', prefixArgs: [] }, process.cwd());
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
    const rpc = await opening;
    const request = vi.spyOn(rpc, 'request');
    const turn = rpc.startAndWaitForTurn('thread', {}, 1000);
    processChild.stdout.write(JSON.stringify({ id: 2, result: { turn: { id: 'long' } } }) + '\n');
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenLastCalledWith('thread/read', { threadId: 'thread', includeTurns: true });
    processChild.stdout.write(JSON.stringify({ id: 3, result: { thread: { turns: [{ id: 'long', status: 'inProgress' }] } } }) + '\n');
    await vi.advanceTimersByTimeAsync(500);
    processChild.stdout.write(JSON.stringify({ method: 'item/updated', params: { threadId: 'thread', turnId: 'long' } }) + '\n');
    await vi.advanceTimersByTimeAsync(900);
    expect(request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1);
    processChild.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'long', status: 'completed' } } }) + '\n');
    await expect(turn).resolves.toBeUndefined();
    expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    await rpc.close();
  });
  it.each(['completed', 'missing', 'offline'])('recovers a silent %s turn without resending its prompt', async state => {
    vi.useFakeTimers(); const processChild = child(); processChild.stdin.resume();
    const opening = CodexAppServerRpc.open({ command: 'codex', prefixArgs: [] }, process.cwd());
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n'); const rpc = await opening;
    const turn = rpc.startAndWaitForTurn('thread', {}, 1000);
    const settled = state === 'completed' ? expect(turn).resolves.toBeUndefined() : expect(turn).rejects.toThrow(state === 'offline' ? 'Offline' : 'could not be verified');
    processChild.stdout.write(JSON.stringify({ id: 2, result: { turn: { id: 'long' } } }) + '\n');
    await vi.advanceTimersByTimeAsync(1000);
    processChild.stdout.write(JSON.stringify(state === 'offline' ? { id: 3, error: { message: 'Offline' } } : { id: 3, result: { thread: { turns: state === 'missing' ? [] : [{ id: 'long', status: 'completed' }] } } }) + '\n');
    await settled; await rpc.close();
  });
  it('sends image attachment inputs larger than the previous 2 MB protocol limit', async () => {
    const processChild = child(); processChild.stdin.resume();
    const opening = CodexAppServerRpc.open({ command: 'codex', prefixArgs: [] }, process.cwd());
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
    const rpc = await opening;
    const request = rpc.request('turn/steer', { input: [{ type: 'image', url: 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024) }] });
    processChild.stdout.write(JSON.stringify({ id: 2, result: { turnId: 'large-upload' } }) + '\n');
    await expect(request).resolves.toEqual({ turnId: 'large-upload' }); await rpc.close();
  });

  it("terminates only the spawned Windows child tree before closing its wrapper", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    const processChild = Object.assign(child(), { pid: 12345 });
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReturnValueOnce(processChild).mockReturnValueOnce(killer);
    try {
      const opening = CodexAppServerRpc.open({ command: "node", prefixArgs: ["codex.js"] }, process.cwd());
      processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
      const rpc = await opening;
      const closing = rpc.close();
      expect(mocks.spawn).toHaveBeenLastCalledWith(expect.stringMatching(/[\\/]System32[\\/]taskkill\.exe$/i), ["/PID", "12345", "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      expect(processChild.kill).not.toHaveBeenCalled();
      processChild.emit("exit", 0); killer.emit("exit", 0); await closing;
      await rpc.close(); expect(mocks.spawn).toHaveBeenCalledTimes(2);
      expect(processChild.stdin.destroyed).toBe(true);
    } finally { Object.defineProperty(process, "platform", platform); }
  });
  it("finishes successful Windows tree cleanup even when its wrapper did not exit", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    const processChild = Object.assign(child(), { pid: 12345 });
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReturnValueOnce(processChild).mockReturnValueOnce(killer);
    try {
      const opening = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
      processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
      const rpc = await opening; const closing = rpc.close();
      killer.emit("exit", 0); await closing;
      expect(processChild.kill).toHaveBeenCalledOnce();
    } finally { Object.defineProperty(process, "platform", platform); }
  });
  it("accepts a child exit racing Windows taskkill reporting that its PID is gone", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    const processChild = Object.assign(child(), { pid: 12345 });
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReturnValueOnce(processChild).mockReturnValueOnce(killer);
    try {
      const opening = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
      processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
      const rpc = await opening, closing = rpc.close();
      processChild.emit("exit", 0); killer.emit("exit", 128);
      await expect(closing).resolves.toBeUndefined();
      expect(processChild.kill).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, "platform", platform); }
  });
  it("never targets an exited child PID for process-tree cleanup", async () => {
    const processChild = Object.assign(child(), { pid: 12345 });
    const opening = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    const rpc = await opening;
    processChild.emit("exit", 0); processChild.emit("close", 0);
    await rpc.close(); expect(mocks.spawn).toHaveBeenCalledOnce(); expect(processChild.kill).not.toHaveBeenCalled();
  });
  it("initializes the WebSocket transport and rejects pending reads on disconnect", async () => {
    const processChild = child();
    let server: WebSocketServer | undefined;
    mocks.spawn.mockImplementation((_command, args: string[]) => {
      const url = new URL(args[args.indexOf("--listen") + 1]!);
      server = new WebSocketServer({ host: url.hostname, port: Number(url.port) });
      server.on("listening", () => processChild.stderr.write(`listening on: ${url.href}\n`));
      server.on("connection", (socket) => socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
      }));
      return processChild;
    });
    const rpc = await CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd(), undefined, "websocket");
    try {
      const pending = rpc.request("thread/read", {});
      server!.clients.forEach((socket) => socket.close());
      await expect(pending).rejects.toThrow(/WebSocket closed/);
      expect(processChild.kill).toHaveBeenCalledOnce();
    } finally {
      rpc.close();
      server!.clients.forEach((socket) => socket.terminate());
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  it.each(["exit", "abort"])("cleans up WebSocket startup after %s", async (cause) => {
    const processChild = child();
    const controller = new AbortController();
    mocks.spawn.mockImplementation(() => {
      setTimeout(() => {
        if (cause === "abort") controller.abort();
        else { processChild.stderr.write("startup failed"); processChild.emit("close", 1); }
      }, 0);
      return processChild;
    });
    await expect(CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd(), controller.signal, "websocket")).rejects.toThrow(cause === "exit" ? /startup failed/ : /closed/);
    expect(processChild.kill).toHaveBeenCalledOnce();
  });
  it("pins a relative Codex home before switching to a session's project", async () => {
    vi.stubEnv("CODEX_HOME", "relative-codex-home");
    const processChild = child();
    const opening = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, path.resolve("different-project"));
    expect(mocks.spawn).toHaveBeenCalledWith("codex", ["app-server", "--stdio"], expect.any(Object));
    expect(mocks.spawn.mock.calls[0]?.[2].env.CODEX_HOME).toBe(path.resolve("relative-codex-home"));
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n"); (await opening).close();
  });
  it("closes initialization immediately when recovery is cancelled", async () => {
    const processChild = child(), controller = new AbortController();
    const pending = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(processChild.kill).toHaveBeenCalledOnce();
  });
  it("opts into the native goal lifecycle API", async () => {
    const processChild = child();
    const pending = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    const initialize = JSON.parse(processChild.stdin.read().toString());
    expect(initialize.params.capabilities).toEqual({ experimentalApi: true });
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    (await pending).close();
  });
  it.each(["stdout", "stderr"] as const)("reports %s pipe failures and rejects pending work", async (pipe) => {
    const processChild = child();
    const pending = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    processChild[pipe].emit("error", new Error("read pipe closed"));
    await expect(pending).rejects.toThrow("read pipe closed");
    expect(processChild.kill).toHaveBeenCalledOnce();
  });
  it("preserves official proxy diagnostics when the daemon exits", async () => {
    const processChild = child();
    const pending = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd(), undefined, "proxy");
    processChild.stderr.write("failed to connect to app-server-control.sock: dead network\n");
    processChild.emit("close", 1);
    await expect(pending).rejects.toThrow(/official Codex app-server daemon is unavailable/);
    await expect(pending).rejects.toThrow(/failed to connect to app-server-control\.sock/);
  });
  it("bounds incomplete protocol lines and rejects every waiter on disconnect", async () => {
    const processChild = child();
    const opening = CodexAppServerRpc.open({ command: "codex", prefixArgs: [] }, process.cwd());
    processChild.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    const rpc = await opening;
    const request = rpc.request("thread/read", {});
    const size = vi.spyOn(Buffer, "byteLength").mockImplementationOnce(() => 128 * 1024 * 1024 + 1);
    processChild.stdout.write("oversized-fixture");
    size.mockRestore();
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
