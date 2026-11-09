import { MAX_CHAT_WIRE_BYTES } from "../domain/chatAttachments";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "node:string_decoder";
import { createServer } from "node:net";
import * as path from "node:path";
import { WebSocket } from "ws";
import { normalizeNativePath } from "../utils/nativePaths";

export type AppServerExecutable = { command: string; prefixArgs: string[]; shell?: boolean };
export type AppServerTransport = "stdio" | "proxy" | "websocket";
export class CodexAppServerTurnInterruptedError extends Error {
  constructor() {
    super("Codex stopped this turn before it completed.");
    this.name = "CodexAppServerTurnInterruptedError";
  }
}
export class CodexAppServerDisconnectedError extends Error {
  constructor(message: string) { super(message); this.name = "CodexAppServerDisconnectedError"; }
}
type RpcResponse = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
export type AppServerRequest = { id: string | number; method: string; params: unknown };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

function appServerExitError(code: number | null, stderr: string, transport: AppServerTransport): Error {
  const detail = stderr.trim().slice(-512);
  const guidance = transport === "proxy" && /no complete local package/i.test(detail)
    ? "The installed official Codex CLI package is incomplete. Update or reinstall the official Codex extension/CLI, then retry."
    : transport === "proxy" && /app-server-control\.sock|dead network|failed to connect/i.test(detail)
      ? "The official Codex app-server daemon is unavailable. Restart or update official Codex, then retry."
      : undefined;
  return new Error(`Codex app-server ${transport} exited with code ${code ?? "unknown"}.${guidance ? ` ${guidance}` : ""}${detail ? ` ${detail}` : ""}`);
}

/** One scoped app-server connection; browser actions use the official app-server transport. */
export class CodexAppServerRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private readonly decoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications = new Set<(method: string, params: unknown) => void>();
  private readonly serverRequests = new Set<(request: AppServerRequest) => void>();
  private readonly disconnects = new Set<(error: Error) => void>();
  private closed = false;
  private transportError?: Error;
  private stderr = "";
  private readonly transport: AppServerTransport;
  private childExited = false;
  private teardown?: Promise<void>;

  private constructor(child: ChildProcessWithoutNullStreams, transport: AppServerTransport) {
    this.child = child;
    this.transport = transport;
    child.once("exit", () => { this.childExited = true; });
    child.on("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => this.fail(error));
    child.stdout.on("error", (error) => this.fail(error));
    child.stderr.on("error", (error) => this.fail(error));
    child.on("close", (code) => this.fail(appServerExitError(code, this.stderr, transport)));
  }

  static async open(executable: AppServerExecutable, cwd: string, signal?: AbortSignal, transport: AppServerTransport = "stdio"): Promise<CodexAppServerRpc> {
    signal?.throwIfAborted();
    if (transport === "websocket") return CodexAppServerRpc.openWebSocket(executable, cwd, signal);
    const args = transport === "proxy" ? ["app-server", "proxy"] : ["app-server", "--stdio"];
    const configuredHome = process.env["CODEX_HOME"]?.trim().replace(/^['"]|['"]$/g, "");
    const child = spawn(executable.command, [...executable.prefixArgs, ...args], {
      cwd,
      env: { ...process.env, ...(configuredHome ? { CODEX_HOME: path.resolve(normalizeNativePath(configuredHome)) } : {}), ...(executable.command === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      windowsHide: true,
      shell: executable.shell,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new CodexAppServerRpc(child, transport);
    const abort = () => { void client.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer | string) => {
      client.stderr = `${client.stderr}${chunk.toString()}`.slice(-2048);
    });
    try {
      child.stdout.on("data", (chunk: Buffer) => client.receiveChunk(chunk));
      await client.request("initialize", {
        clientInfo: { name: "codex-manager", title: "Codex Manager", version: "1.4.1" },
        capabilities: { experimentalApi: true }
      }, 30_000);
      signal?.throwIfAborted();
      client.send({ method: "initialized", params: {} });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private static async openWebSocket(executable: AppServerExecutable, cwd: string, signal?: AbortSignal): Promise<CodexAppServerRpc> {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") { server.close(); reject(new Error("Could not reserve a local app-server port.")); return; }
        server.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
    const configuredHome = process.env["CODEX_HOME"]?.trim().replace(/^['"]|['"]$/g, "");
    const child = spawn(executable.command, [...executable.prefixArgs, "app-server", "--listen", `ws://127.0.0.1:${port}`, "--analytics-default-enabled"], {
      cwd,
      env: { ...process.env, ...(configuredHome ? { CODEX_HOME: path.resolve(normalizeNativePath(configuredHome)) } : {}), ...(executable.command === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      windowsHide: true,
      shell: executable.shell,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new CodexAppServerRpc(child, "websocket");
    const abort = () => { void client.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.resume();
    try {
      signal?.throwIfAborted();
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("The official Codex app-server WebSocket did not start within 30 seconds."));
        }, 30_000);
        const onStderr = (chunk: Buffer | string) => {
          client.stderr = `${client.stderr}${chunk.toString()}`.slice(-4096);
          if (/listening on:\s+ws:\/\/127\.0\.0\.1:\d+/.test(client.stderr)) {
            cleanup();
            resolve(`ws://127.0.0.1:${port}`);
          }
        };
        let off = () => undefined as void;
        const cleanup = () => { clearTimeout(timer); child.stderr.off("data", onStderr); off(); };
        off = client.onDisconnect((error) => { cleanup(); reject(error); });
        child.stderr.on("data", onStderr);
      });
      child.stderr.on("data", (chunk: Buffer | string) => { client.stderr = `${client.stderr}${chunk.toString()}`.slice(-4096); });
      signal?.throwIfAborted();
      const socket = new WebSocket(url, { handshakeTimeout: 30_000, maxPayload: MAX_CHAT_WIRE_BYTES });
      client.socket = socket;
      socket.on("message", (data) => {
        const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString() : data instanceof ArrayBuffer ? Buffer.from(data).toString() : Buffer.concat(data).toString();
        client.receive(text);
      });
      socket.on("error", (error) => client.fail(error instanceof Error ? error : new Error(String(error))));
      socket.on("close", () => client.fail(new Error("Codex app-server WebSocket closed.")));
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => { cleanup(); resolve(); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onClose = () => { cleanup(); reject(client.transportError ?? new Error("Codex app-server WebSocket closed before connecting.")); };
        const cleanup = () => { socket.off("open", onOpen); socket.off("error", onError); socket.off("close", onClose); };
        socket.once("open", onOpen);
        socket.once("error", onError);
        socket.once("close", onClose);
      });
        await client.request("initialize", {
          clientInfo: { name: "codex-manager", title: "codex-manager browser workspace", version: "1.6.0" },
          capabilities: { experimentalApi: true }
        }, 30_000);
        signal?.throwIfAborted();
        client.send({ method: "initialized", params: {} });
        return client;
    } catch (error) {
      await client.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) throw this.transportError ?? new Error("Codex app-server connection is closed.");
    if (this.pending.size >= 64) throw new Error("Codex app-server request queue is full. Wait for pending actions before retrying.");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const guidance = method === "initialize" && this.transport === "proxy" ? " The official Codex app-server daemon is unavailable or unresponsive; restart or update official Codex, then retry." : "";
        reject(new CodexAppServerDisconnectedError(`Codex app-server did not answer ${method} within ${Math.ceil(timeoutMs / 1000)} seconds.${guidance} Its outcome is unconfirmed; refresh before retrying.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onServerRequest(listener: (request: AppServerRequest) => void): () => void {
    this.serverRequests.add(listener);
    return () => this.serverRequests.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    if (this.closed) listener(this.transportError ?? new CodexAppServerDisconnectedError("Codex app-server connection closed."));
    else this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }

  answerServerRequest(id: string | number, result: unknown): void {
    this.send({ id, result });
  }

  rejectServerRequest(id: string | number, message: string): void {
    this.send({ id, error: { code: -32000, message } });
  }

  async startAndWaitForTurn(
    threadId: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    onTurnStarted?: (turnId: string) => void
  ): Promise<void> {
    let turnId: string | undefined;
    const earlyCompletions = new Map<string, Record<string, unknown>>();
    let settle!: (params: Record<string, unknown>) => void;
    let failTurn!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => {
      failTurn = reject;
      settle = (payload) => {
        const turn = payload["turn"] as Record<string, unknown> | undefined;
        const status = turn?.["status"];
        if (status === "completed") resolve();
        else if (status === "interrupted") reject(new CodexAppServerTurnInterruptedError());
        else {
          const details = turn?.["error"] as { message?: unknown } | undefined;
          reject(new Error(typeof details?.message === "string" ? details.message : "Codex did not complete the turn."));
        }
      };
    });
    void completed.catch(() => undefined);
    this.disconnects.add(failTurn);
    const off = this.onNotification((method, raw) => {
      if (method !== "turn/completed" || !raw || typeof raw !== "object") return;
      const payload = raw as Record<string, unknown>;
      if (payload["threadId"] !== threadId) return;
      const eventTurn = payload["turn"] as Record<string, unknown> | undefined;
      if (!turnId && typeof eventTurn?.["id"] === "string") {
        if (earlyCompletions.size >= 64) earlyCompletions.delete(earlyCompletions.keys().next().value!);
        earlyCompletions.set(eventTurn["id"], payload);
      }
      else if (eventTurn?.["id"] === turnId) settle(payload);
    });
    let timeout: NodeJS.Timeout | undefined;
    let waiting = true;
    let resetDeadline: (() => void) | undefined;
    const offProgress = this.onNotification((_method, raw) => {
      if (!turnId || !raw || typeof raw !== 'object') return;
      const event = raw as { threadId?: string; turnId?: string };
      if (event.threadId === threadId && (!event.turnId || event.turnId === turnId)) resetDeadline?.();
    });
    try {
      const started = await this.request<{ turn?: { id?: unknown } }>("turn/start", params);
      turnId = typeof started.turn?.id === "string" ? started.turn.id : undefined;
      if (!turnId) throw new Error("Codex started a turn without returning its ID. Refresh the session before retrying.");
      onTurnStarted?.(turnId);
      const earlyCompletion = earlyCompletions.get(turnId);
      earlyCompletions.clear();
      if (earlyCompletion) settle(earlyCompletion);
      await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          resetDeadline = () => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => {
              // Verify an idle stream before closing it; long active turns need no replay.
              void this.request<{ thread?: { turns?: Array<{ id?: string; status?: string }> } }>('thread/read', { threadId, includeTurns: true }).then(result => {
                if (!waiting) return;
                const turn = result.thread?.turns?.find(value => value.id === turnId);
                if (turn && ['inProgress', 'running'].includes(turn.status ?? '')) resetDeadline?.();
                else if (turn && ['completed', 'failed', 'interrupted'].includes(turn.status ?? '')) settle({ turn });
                else reject(new CodexAppServerDisconnectedError('The turn status could not be verified after the connection stopped responding.'));
              }, error => { if (waiting) reject(new CodexAppServerDisconnectedError(`The turn status could not be verified: ${error instanceof Error ? error.message : String(error)}`)); });
            }, timeoutMs);
          };
          resetDeadline();
        })
      ]);
    } finally {
      waiting = false;
      if (timeout) clearTimeout(timeout);
      off();
      offProgress();
      this.disconnects.delete(failTurn);
    }
  }

  close(): Promise<void> {
    if (!this.closed) this.fail(new Error("Codex app-server connection closed."));
    return this.teardown ?? Promise.resolve();
  }

  private send(message: unknown): void {
    if (this.closed) throw this.transportError ?? new Error("Codex app-server connection is closed.");
    const encoded = JSON.stringify(message);
    const request = message as { method?: string; params?: { input?: Array<{ type?: string }> } };
    const limit = ['turn/start','turn/steer'].includes(request.method ?? '') && Array.isArray(request.params?.input) && request.params.input.some(item => item.type === 'image') ? MAX_CHAT_WIRE_BYTES : 2 * 1024 * 1024;
    if (this.socket) {
      if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 2 * 1024 * 1024 || Buffer.byteLength(encoded, "utf8") > limit) throw new Error("The Codex app-server WebSocket is closed, the queue is full, or the request is too large.");
      this.socket.send(encoded);
      return;
    }
    if (Buffer.byteLength(encoded, "utf8") > limit || this.child.stdin.writableLength > 2 * 1024 * 1024) throw new Error("The Codex app-server message queue is full or the request is too large.");
    this.child.stdin.write(`${encoded}\n`, "utf8");
  }

  private receiveChunk(chunk: Buffer): void {
    if (this.closed) return;
    this.lineBuffer += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.lineBuffer.indexOf("\n")) >= 0) {
      if (Buffer.byteLength(this.lineBuffer.slice(0, newline), "utf8") > MAX_CHAT_WIRE_BYTES) { this.fail(new Error("Codex app-server sent an oversized protocol message.")); return; }
      const line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      this.receive(line);
      if (this.closed) return;
    }
    if (Buffer.byteLength(this.lineBuffer, "utf8") > MAX_CHAT_WIRE_BYTES) this.fail(new Error("Codex app-server sent an oversized unfinished protocol message."));
  }

  private receive(raw: string): void {
    let message: RpcResponse;
    try { message = JSON.parse(raw) as RpcResponse; } catch { return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (typeof message.id === "number" || typeof message.id === "string") {
      const pending = typeof message.method !== "string" && typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (pending) {
        if (!Object.prototype.hasOwnProperty.call(message, "result") && !message.error) return;
        this.pending.delete(message.id as number);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Codex rejected the request."));
        else pending.resolve(message.result);
      } else if (typeof message.method === "string") {
        if (this.serverRequests.size === 0) {
          this.rejectServerRequest(message.id, `Codex Manager cannot answer ${message.method} without a dashboard prompt.`);
        } else {
          for (const listener of this.serverRequests) {
            try { listener({ id: message.id, method: message.method, params: message.params }); }
            catch { this.rejectServerRequest(message.id, "The dashboard could not display this request."); }
          }
        }
      }
    } else if (typeof message.method === "string") {
      for (const listener of this.notifications) {
        try { listener(message.method, message.params); } catch { /* One display listener cannot break turn tracking. */ }
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.transportError = error instanceof CodexAppServerDisconnectedError ? error : new CodexAppServerDisconnectedError(error.message);
    for (const listener of this.disconnects) { try { listener(this.transportError); } catch { /* Cleanup continues for every waiter. */ } }
    this.disconnects.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.transportError);
    }
    this.pending.clear();
    this.lineBuffer = "";
    if (this.socket?.readyState === WebSocket.CONNECTING) this.socket.terminate();
    else this.socket?.close();
    this.teardown = this.terminateOwnedChild();
    void this.teardown.catch(() => undefined);
  }

  private terminateOwnedChild(): Promise<void> {
    const child = this.child;
    if (this.childExited || child.exitCode != null || child.signalCode != null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let treeStopped = process.platform !== "win32" || !child.pid;
      let failure: Error | undefined;
      const finish = () => {
        if (!this.childExited || !treeStopped) return;
        clearTimeout(timer); child.off("exit", finish);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        if (failure) reject(failure); else resolve();
      };
      const kill = () => { if (this.childExited) return; try { child.kill("SIGKILL"); } catch { /* Already exited. */ } };
      const timer = setTimeout(() => {
        failure = new Error("Codex Manager could not confirm its private app-server process stopped. Refresh before starting another writer.");
        treeStopped = true; kill(); this.childExited = true; finish();
      }, 3_000);
      timer.unref(); child.once("exit", finish);
      // A Node or shell shim can own a Codex grandchild holding the writer handle.
      if (!treeStopped) {
        const failed = () => {
          // Taskkill can report a vanished PID before Node delivers its exit event.
          setTimeout(() => {
            treeStopped = true;
            if (!this.childExited) {
              failure = new Error("Codex Manager could not stop its private app-server process tree. Refresh before starting another writer.");
              kill();
            }
            finish();
          }, 50).unref();
        };
        try {
          const killer = spawn(path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", failed);
          killer.once("exit", code => { if (code !== 0) failed(); else { treeStopped = true; kill(); finish(); } });
          killer.unref();
        } catch { failed(); }
      } else {
        if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Direct child fallback. */ } }
        kill();
      }
    });
  }

}
