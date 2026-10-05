import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "node:string_decoder";

export type AppServerExecutable = { command: string; prefixArgs: string[]; shell?: boolean };
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

/** One scoped app-server connection. The browser never receives the local
 * app-server URL or process handle; all requests stay inside the VS Code host. */
export class CodexAppServerRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications = new Set<(method: string, params: unknown) => void>();
  private readonly serverRequests = new Set<(request: AppServerRequest) => void>();
  private readonly disconnects = new Set<(error: Error) => void>();
  private closed = false;
  private transportError?: Error;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.on("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => this.fail(error));
    child.on("close", (code) => this.fail(new Error(`Codex app-server exited with code ${code ?? "unknown"}.`)));
  }

  static async open(executable: AppServerExecutable, cwd: string): Promise<CodexAppServerRpc> {
    const args = ["app-server", "--stdio"];
    const child = spawn(executable.command, [...executable.prefixArgs, ...args], {
      cwd,
      env: { ...process.env, ...(executable.command === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      windowsHide: true,
      shell: executable.shell,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new CodexAppServerRpc(child);
    child.stderr.on("data", () => undefined);
    try {
      child.stdout.on("data", (chunk: Buffer) => client.receiveChunk(chunk));
      await client.request("initialize", {
        clientInfo: { name: "codex-manager", title: "Codex Manager", version: "1.2.14" },
        capabilities: null
      }, 30_000);
      client.send({ method: "initialized", params: {} });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) throw this.transportError ?? new Error("Codex app-server connection is closed.");
    if (this.pending.size >= 64) throw new Error("Codex app-server request queue is full. Wait for pending actions before retrying.");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerDisconnectedError(`Codex app-server did not answer ${method} within ${Math.ceil(timeoutMs / 1000)} seconds. Its outcome is unconfirmed; refresh before retrying.`));
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
          timeout = setTimeout(() => reject(new CodexAppServerDisconnectedError("Codex did not finish the turn within 15 minutes. Refresh the session before retrying.")), timeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      off();
      this.disconnects.delete(failTurn);
    }
  }

  close(): void {
    if (this.closed) return;
    this.fail(new Error("Codex app-server connection closed."));
  }

  private send(message: unknown): void {
    if (this.closed) throw this.transportError ?? new Error("Codex app-server connection is closed.");
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded, "utf8") > 2 * 1024 * 1024 || this.child.stdin.writableLength > 2 * 1024 * 1024) throw new Error("The Codex app-server message queue is full or the request is too large.");
    this.child.stdin.write(`${encoded}\n`, "utf8");
  }

  private receiveChunk(chunk: Buffer): void {
    if (this.closed) return;
    this.lineBuffer += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.lineBuffer.indexOf("\n")) >= 0) {
      if (Buffer.byteLength(this.lineBuffer.slice(0, newline), "utf8") > 4 * 1024 * 1024) { this.fail(new Error("Codex app-server sent an oversized protocol message.")); return; }
      const line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      this.receive(line);
      if (this.closed) return;
    }
    if (Buffer.byteLength(this.lineBuffer, "utf8") > 4 * 1024 * 1024) this.fail(new Error("Codex app-server sent an oversized unfinished protocol message."));
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
    this.child.kill();
  }
}
