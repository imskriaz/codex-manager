import { getCodexHome } from "../codex/authFile";
import { readCodexSessionGoals } from "./codexSessionGoals";
import { execFile } from "node:child_process";

export type AppServerExecutable = { command: string; prefixArgs: string[]; shell?: boolean };
export type AppServerRequest = { id: string | number; method: string; params: unknown };
export class CodexAppServerTurnInterruptedError extends Error {
  constructor() { super("Codex stopped this turn before it completed."); this.name = "CodexAppServerTurnInterruptedError"; }
}
export class CodexAppServerDisconnectedError extends Error {
  constructor(message: string) { super(message); this.name = "CodexAppServerDisconnectedError"; }
}

function unavailable(method: string): Error {
  return new Error(`Official Codex does not expose ${method} through its shared connection. Use the official Codex UI for this action. Manager does not start a private server.`);
}

/** Compatibility boundary for callers awaiting an official shared API; never owns a process or writer. */
export class CodexAppServerRpc {
  private constructor(private readonly home: string, private readonly executable: AppServerExecutable, private readonly cwd: string) {}

  static open(_executable: AppServerExecutable, _cwd: string, signal?: AbortSignal): Promise<CodexAppServerRpc> {
    return Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return new CodexAppServerRpc(getCodexHome(), _executable, _cwd);
    });
  }

  async request<T>(method: string, params: unknown, _timeoutMs?: number): Promise<T> {
    if (getCodexHome() !== this.home) throw new Error("The active Codex home changed. Refresh before retrying.");
    if (method === "thread/goal/get") {
      const id = (params as { threadId?: unknown } | null)?.threadId;
      if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error("The session identifier is invalid.");
      const goals = await readCodexSessionGoals(this.home, [id]);
      if (getCodexHome() !== this.home) throw new Error("The active Codex home changed. Refresh before retrying.");
      if (!goals) throw new Error("Official Codex goal storage is unavailable. Recovery was kept.");
      return { goal: goals.get(id) ?? null } as T;
    }
    const command = method === "thread/archive" ? "archive" : method === "thread/unarchive" ? "unarchive" : method === "thread/delete" ? "delete" : undefined;
    if (command) {
      const id = (params as { threadId?: unknown } | null)?.threadId;
      if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error("The session identifier is invalid.");
      await new Promise<void>((resolve, reject) => {
        execFile(this.executable.command, [...this.executable.prefixArgs, command, id, ...(command === "delete" ? ["--force"] : [])], {
          cwd: this.cwd,
          env: { ...process.env, CODEX_HOME: this.home },
          shell: this.executable.shell,
          windowsHide: true,
          timeout: _timeoutMs ?? 30_000,
          maxBuffer: 1024 * 1024
        }, (error, _stdout, stderr) => {
          if (!error) { resolve(); return; }
          const detail = typeof stderr === "string" && stderr.trim() ? stderr.trim().split(/\r?\n/).pop() : undefined;
          reject(new Error(detail || `Codex ${command} failed. ${error.message}`));
        });
      });
      if (getCodexHome() !== this.home) throw new Error("The active Codex home changed. Refresh before retrying.");
      return undefined as T;
    }
    throw unavailable(method);
  }

  onNotification(_listener: (method: string, params: unknown) => void): () => void { return () => undefined; }
  onServerRequest(_listener: (request: AppServerRequest) => void): () => void { return () => undefined; }
  onDisconnect(_listener: (error: Error) => void): () => void { return () => undefined; }
  answerServerRequest(_id: string | number, _result: unknown): void { throw unavailable("approval response"); }
  rejectServerRequest(_id: string | number, _message: string): void { throw unavailable("approval response"); }
  startAndWaitForTurn(_threadId: string, _params: Record<string, unknown>, _timeoutMs: number, _onStarted?: (turnId: string) => void): Promise<void> { return Promise.reject(unavailable("turn/start")); }
  close(): void {}
}
