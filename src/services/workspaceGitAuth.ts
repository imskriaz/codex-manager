import { spawn } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { WorkspaceGitAuthState } from "../domain/dashboard/types";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { loadPty, releaseWindowsResources } from "./workspaceTerminalPty";

const DEVICE_PAGE = "https://github.com/login/device";
function gitHubDeviceCode(output: string): string | undefined {
  const text = stripVTControlCharacters(output);
  if (!text.includes(DEVICE_PAGE)) {
    return undefined;
  }
  return /^\s*([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m.exec(text)?.[1];
}

/** Read via Git so the same helper and matching rules used by HTTPS Git also apply here. */
export function readGitHubCredential(cwd: string, repository?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "credential.interactive=false", "credential", "fill"], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      windowsHide: true
    });
    let output = "";
    const finish = (value?: string) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 16_384) {
        child.kill();
        finish();
      } else {
        output += chunk.toString("utf8");
      }
    });
    child.stderr.resume();
    child.on("error", () => finish());
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => finish(code === 0 ? /^password=(.+)$/m.exec(output)?.[1]?.trim() : undefined));
    child.stdin.end("protocol=https\nhost=github.com\n" + (repository ? "path=" + repository + "\n" : "") + "\n");
  });
}

type Attempt = { id: string; cwd: string; state: WorkspaceGitAuthState; cancel: AbortController; done?: boolean };
let attempt: Attempt | undefined;

function record(value: Attempt, status: "completed" | "failed" | "cancelled", message: string): void {
  value.state = { status, message };
  value.done = true;
}

async function authorize(value: Attempt, repository: string, ownership: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(5 * 60_000);
  const startTimeout = new AbortController();
  const signal = AbortSignal.any([value.cancel.signal, ownership, timeout, startTimeout.signal]);
  const backend = await loadPty();
  signal.throwIfAborted();
  // The credential manager grants access for github.com on this host. Launch it
  // outside the project so its Git configuration cannot redirect the sign-in.
  const terminal = backend.spawn(process.platform === "win32" ? "git.exe" : "git",
    ["credential-manager", "github", "login", "--url", "https://github.com", "--device", "--no-ui"], {
      cwd: path.dirname(process.execPath),
      cols: 120,
      rows: 24,
      name: "xterm-256color",
      env: { ...process.env, NO_COLOR: "1", GCM_INTERACTIVE: "always" },
      useConpty: true,
      useConptyDll: process.platform === "win32"
    });
  let output = "";
  const exitCode = await new Promise<number | undefined>((resolve) => {
    const startTimer = setTimeout(() => startTimeout.abort(), 20_000);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code?: number) => {
      clearTimeout(startTimer);
      clearTimeout(killTimer);
      clearTimeout(finishTimer);
      signal.removeEventListener("abort", stop);
      read.dispose();
      exit.dispose();
      try { releaseWindowsResources(terminal); } catch { /* The console may already be closed. */ }
      resolve(code);
    };
    const stop = () => {
      try { terminal.write("\x03"); } catch { /* The process may already be closing. */ }
      killTimer = setTimeout(() => {
        try { terminal.kill(); } catch { /* Native cleanup may have already started. */ }
        finishTimer = setTimeout(finish, 1000);
      }, 2000);
    };
    const read = terminal.onData((chunk) => {
      output = (output + chunk).slice(-8000);
      if (!signal.aborted && value.state.status === "starting") {
        const code = gitHubDeviceCode(output);
        if (code) {
          clearTimeout(startTimer);
          value.state = { status: "waiting", code };
        }
      }
    });
    const exit = terminal.onExit(({ exitCode: code }) => finish(code));
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
  if (exitCode === 0 && await readGitHubCredential(value.cwd, repository)) {
    record(value, "completed", "GitHub HTTPS is authorized on the selected system.");
  } else if (exitCode === undefined) {
    record(value, "failed", "The system could not confirm that GitHub authorization stopped. Check the selected system’s Git credentials before retrying.");
  } else if (value.cancel.signal.aborted) {
    record(value, "cancelled", "GitHub authorization cancelled.");
  } else if (timeout.aborted) {
    record(value, "failed", "GitHub authorization timed out. Start a new authorization to try again.");
  } else if (startTimeout.signal.aborted) {
    record(value, "failed", "Git Credential Manager did not return a device code. Check the selected system’s connection to GitHub and retry.");
  } else if (ownership.aborted) {
    record(value, "failed", "The system lost ownership of this sign-in. Check GitHub authorization on the selected system.");
  } else if (exitCode === 0) {
    record(value, "failed", "Sign-in finished, but Git could not read the credential. Check the selected system’s Git credential helper.");
  } else {
    const error = stripVTControlCharacters(output).split(/\r?\n/).find(line => /^(?:fatal|error):/i.test(line));
    const detail = error?.replace(/https?:\/\/\S+|(?:gh[pousr]_|github_pat_)\w+|\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "[redacted]").slice(0, 300);
    record(value, "failed", detail ? "Git Credential Manager could not sign in. " + detail : "Git Credential Manager could not sign in. Check that it is installed and the selected system can reach GitHub.");
  }
}

export function startWorkspaceGitAuth(cwd: string, id: string, repository: string): WorkspaceGitAuthState {
  if (attempt?.id === id) return workspaceGitAuthStatus(cwd, id, false);
  if (attempt && !attempt.done) throw new Error("GitHub authorization is already running on this system.");
  const value: Attempt = { cwd, id, state: { status: "starting" }, cancel: new AbortController() };
  attempt = value;
  void runCrossWindowExclusive("workspace-github-device-login", "GitHub authorization", (signal) =>
    authorize(value, repository, signal)).catch((error: unknown) => {
    if (value.cancel.signal.aborted) record(value, "cancelled", "GitHub authorization cancelled.");
    else record(value, "failed", error instanceof Error ? error.message : "GitHub authorization could not start.");
  });
  return value.state;
}

export function workspaceGitAuthStatus(cwd: string, id: string, cancel: boolean): WorkspaceGitAuthState {
  if (!attempt || attempt.id !== id || attempt.cwd !== cwd) {
    return { status: "failed", message: "This GitHub authorization is no longer available. Start a new one to retry." };
  }
  if (cancel && !attempt.done) {
    attempt.state = { status: "starting", message: "Cancelling GitHub authorization…" };
    attempt.cancel.abort();
  }
  return attempt.state;
}
