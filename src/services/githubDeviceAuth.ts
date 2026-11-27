import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

type Attempt = {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  code?: string;
  status: "pending" | "complete" | "failed";
  error?: string;
};
let active: Attempt | undefined;

function cli(): string {
  const windowsPath = join(process.env["ProgramFiles"] || "C:\\Program Files", "GitHub CLI", "gh.exe");
  return process.platform === "win32" && existsSync(windowsPath) ? windowsPath : "gh";
}

/** The official CLI owns OAuth and credential storage. Only its user code leaves this process. */
export async function connectGitHubDevice(cwd: string): Promise<string | undefined> {
  if (!active) {
    const command = cli();
    const options = {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GH_BROWSER: process.platform === "win32" ? "cmd /c exit 0" : "true",
        NO_COLOR: "1"
      }
    };
    const child = spawn(
      command,
      ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--clipboard=false"],
      options
    );
    let ready!: () => void;
    const attempt: Attempt = {
      child,
      ready: new Promise<void>((resolve) => {
        ready = resolve;
      }),
      status: "pending"
    };
    active = attempt;
    let output = "";
    let setup: ChildProcessWithoutNullStreams | undefined;
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: string) => {
      if (attempt.status !== "pending") return;
      attempt.status = error ? "failed" : "complete";
      attempt.error = error;
      clearTimeout(startTimer);
      clearTimeout(expiryTimer);
      clearTimeout(setupTimer);
      ready();
    };
    const stop = (message: string) => {
      finish(message);
      child.kill();
      setup?.kill();
    };
    const startTimer = setTimeout(
      () => stop("GitHub did not return a sign-in code. Check this system's connection and try Connect GitHub again."),
      30_000
    );
    const expiryTimer = setTimeout(
      () => stop("GitHub sign-in expired. Connect GitHub to request a new code."),
      15 * 60_000
    );
    startTimer.unref();
    expiryTimer.unref();
    const consume = (chunk: Buffer) => {
      if (attempt.status !== "pending") return;
      output = (output + chunk.toString("utf8")).slice(-16_384);
      const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(output)?.[1];
      if (code) {
        attempt.code = code;
        clearTimeout(startTimer);
        ready();
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.stdin.on("error", () => undefined);
    child.on("error", () =>
      finish("GitHub CLI could not start. Install GitHub CLI on the selected system, then Connect GitHub again.")
    );
    child.on("close", (code) => {
      if (attempt.status !== "pending") return;
      if (code !== 0) {
        finish("GitHub sign-in failed, was denied, or was cancelled. Connect GitHub to request a new code.");
        return;
      }
      clearTimeout(startTimer);
      setup = spawn(command, ["auth", "setup-git", "--hostname", "github.com"], options);
      setup.stdout.resume();
      setup.stderr.resume();
      setup.stdin.on("error", () => undefined);
      setup.stdin.end();
      setup.on("error", () => finish("GitHub signed in, but Git credential setup failed. Try Connect GitHub again."));
      setup.on("close", (result) =>
        finish(
          result === 0 ? undefined : "GitHub signed in, but Git credential setup failed. Try Connect GitHub again."
        )
      );
      setupTimer = setTimeout(
        () => stop("GitHub signed in, but Git credential setup timed out. Try Connect GitHub again."),
        15_000
      );
      setupTimer.unref();
    });
    child.stdin.end("\n");
  }
  const attempt = active;
  await attempt.ready;
  if (attempt.status === "failed") {
    if (active === attempt) active = undefined;
    throw new Error(attempt.error);
  }
  if (attempt.status === "complete") {
    if (active === attempt) active = undefined;
    return undefined;
  }
  return `Open https://github.com/login/device and enter ${attempt.code}. Approve GitHub CLI, then click Connect GitHub again to finish. The code expires after 15 minutes.`;
}
