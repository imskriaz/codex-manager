import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";

export type AppServerExecutable = { command: string; prefixArgs: string[]; shell?: boolean };
export class CodexAppServerTurnInterruptedError extends Error {
  constructor() {
    super("Codex stopped this turn before it completed.");
    this.name = "CodexAppServerTurnInterruptedError";
  }
}
type RpcResponse = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
export type AppServerRequest = { id: string | number; method: string; params: unknown };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One scoped app-server connection. The browser never receives the local
 * app-server URL or process handle; all requests stay inside the VS Code host. */
export class CodexAppServerRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private lines?: readline.Interface;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications = new Set<(method: string, params: unknown) => void>();
  private readonly serverRequests = new Set<(request: AppServerRequest) => void>();
  private closed = false;
  private transportError?: Error;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.on("error", (error) => this.fail(error));
    child.on("close", (code) => this.fail(new Error(`Codex app-server exited with code ${code ?? "unknown"}.`)));
  }

  static async open(executable: AppServerExecutable, cwd: string): Promise<CodexAppServerRpc> {
    const args = ["app-server", "--stdio"];
    const child = spawn(executable.command, [...executable.prefixArgs, ...args], {
      cwd,
      env: process.env,
      windowsHide: true,
      shell: executable.shell,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new CodexAppServerRpc(child);
    child.stderr.on("data", () => undefined);
    try {
      client.lines = readline.createInterface({ input: child.stdout });
      client.lines.on("line", (line) => client.receive(line));
      await client.request("initialize", {
        clientInfo: { name: "codex-manager", title: "Codex Manager", version: "1.2.11-pre2" },
        capabilities: null
      }, 10_000);
      client.send({ method: "initialized", params: {} });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) throw this.transportError ?? new Error("Codex app-server connection is closed.");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server did not answer ${method} within ${Math.ceil(timeoutMs / 1000)} seconds.`));
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
    let earlyCompletion: Record<string, unknown> | undefined;
    let settle!: (params: Record<string, unknown>) => void;
    const completed = new Promise<void>((resolve, reject) => {
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
    const off = this.onNotification((method, raw) => {
      if (method !== "turn/completed" || !raw || typeof raw !== "object") return;
      const payload = raw as Record<string, unknown>;
      if (payload["threadId"] !== threadId) return;
      const eventTurn = payload["turn"] as Record<string, unknown> | undefined;
      if (!turnId) earlyCompletion = payload;
      else if (eventTurn?.["id"] === turnId) settle(payload);
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      const started = await this.request<{ turn?: { id?: unknown } }>("turn/start", params);
      turnId = typeof started.turn?.id === "string" ? started.turn.id : undefined;
      if (!turnId) throw new Error("Codex started a turn without returning its ID. Refresh the session before retrying.");
      onTurnStarted?.(turnId);
      if ((earlyCompletion?.["turn"] as Record<string, unknown> | undefined)?.["id"] === turnId) settle(earlyCompletion!);
      await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Codex did not finish the turn within 15 minutes. Refresh the session before retrying.")), timeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      off();
    }
  }

  close(): void {
    if (this.closed) return;
    this.fail(new Error("Codex app-server connection closed."));
    this.lines?.close();
    this.child.kill();
  }

  private send(message: unknown): void {
    if (this.closed) throw this.transportError ?? new Error("Codex app-server connection is closed.");
    const encoded = JSON.stringify(message);
    this.child.stdin.write(`${encoded}\n`, "utf8");
  }

  private receive(raw: string): void {
    let message: RpcResponse;
    try { message = JSON.parse(raw) as RpcResponse; } catch { return; }
    if (typeof message.id === "number" || typeof message.id === "string") {
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (pending) {
        this.pending.delete(message.id as number);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Codex rejected the request."));
        else pending.resolve(message.result);
      } else if (typeof message.method === "string") {
        if (this.serverRequests.size === 0) {
          this.rejectServerRequest(message.id, `Codex Manager cannot answer ${message.method} without a dashboard prompt.`);
        } else {
          for (const listener of this.serverRequests) listener({ id: message.id, method: message.method, params: message.params });
        }
      }
    } else if (typeof message.method === "string") {
      for (const listener of this.notifications) listener(message.method, message.params);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.transportError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
