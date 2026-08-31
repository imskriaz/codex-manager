import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import mammoth from "mammoth";
import { readSafeFileSnapshot, SafeFileReadTimeoutError } from "../utils/safeFileReads";
import type {
  DashboardWorkspaceEnvironment,
  DashboardWorkspaceFile,
  DashboardWorkspaceFileEntry,
  DashboardWorkspaceTerminalInfo,
  DashboardWorkspaceTerminalResult
} from "../domain/dashboard/types";

const MAX_COMMAND_CHARS = 8_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_TREE_ENTRIES = 5_000;
const WORKSPACE_READ_TIMEOUT_MS = 5_000;
const HIDDEN_TREE_DIRECTORIES = new Set([".git", "node_modules"]);
const activeTerminalCommands = new Map<string, ChildProcessWithoutNullStreams>();
const cancelledTerminalCommands = new Set<string>();
const environmentReads = new Map<string, Promise<DashboardWorkspaceEnvironment>>();
let resolvedWindowsPowerShell: string | undefined;

type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs: number;
  cancelled: boolean;
  timedOut: boolean;
};

export class WorkspaceTerminalCommandError extends Error {
  constructor(
    message: string,
    readonly result: DashboardWorkspaceTerminalResult
  ) {
    super(message);
    this.name = "WorkspaceTerminalCommandError";
  }
}

export function resolveWorkspaceProjectPath(projectPath: string | undefined): string {
  const fallback = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const requested = path.resolve(projectPath?.trim() || fallback);
  const allowed = (vscode.workspace.workspaceFolders ?? []).map((folder) => path.resolve(folder.uri.fsPath));
  if (allowed.length === 0 || allowed.some((root) => requested === root || requested.startsWith(`${root}${path.sep}`))) {
    return requested;
  }
  throw new Error("The selected project is not an open workspace folder.");
}

export async function readWorkspaceEnvironment(projectPath: string | undefined): Promise<DashboardWorkspaceEnvironment> {
  const cwd = resolveWorkspaceProjectPath(projectPath);
  const pending = environmentReads.get(cwd);
  if (pending) return pending;
  const read = readWorkspaceEnvironmentInternal(cwd).finally(() => {
    if (environmentReads.get(cwd) === read) environmentReads.delete(cwd);
  });
  environmentReads.set(cwd, read);
  return read;
}

export async function listWorkspaceFiles(projectPath: string | undefined): Promise<DashboardWorkspaceFileEntry[]> {
  const root = resolveWorkspaceProjectPath(projectPath);
  const entries: DashboardWorkspaceFileEntry[] = [];
  const deadline = Date.now() + WORKSPACE_READ_TIMEOUT_MS;
  let cancelled = false;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (cancelled || entries.length >= MAX_TREE_ENTRIES) return;
    const children = await workspaceReadBeforeDeadline(
      fs.readdir(directory, { withFileTypes: true }),
      deadline,
      "The workspace file list took too long to read. Try again after the other app finishes writing."
    );
    children.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
    for (const child of children) {
      if (cancelled || entries.length >= MAX_TREE_ENTRIES) break;
      if (child.isSymbolicLink() || (child.isDirectory() && HIDDEN_TREE_DIRECTORIES.has(child.name))) continue;
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (child.isDirectory()) {
        entries.push({ path: relative, name: child.name, type: "directory", depth });
        await visit(absolute, depth + 1);
      } else if (child.isFile()) {
        entries.push({ path: relative, name: child.name, type: "file", depth });
      }
    }
  };
  try {
    await visit(root, 0);
  } catch (error) {
    cancelled = true;
    throw error;
  }
  return entries;
}

export async function readWorkspaceFile(
  projectPath: string | undefined,
  filePath: string | undefined
): Promise<DashboardWorkspaceFile> {
  const { relative, absolute } = await resolveReadableWorkspaceFile(projectPath, filePath);
  const preview = previewTypeForFile(relative);
  let snapshot;
  try {
    snapshot = await readSafeFileSnapshot(absolute, {
      maxBytes: preview ? MAX_PREVIEW_BYTES : MAX_FILE_BYTES,
      rejectIfLarger: true,
      timeoutMs: WORKSPACE_READ_TIMEOUT_MS
    });
  } catch (error) {
    if (error instanceof SafeFileReadTimeoutError) throw error;
    if ((error as Error)?.name === "SafeFileReadLimitError") {
      throw new Error(preview
        ? "This preview is larger than 8 MB. Open the file in VS Code instead."
        : "This text file is larger than 1 MB and cannot be edited here.");
    }
    throw error;
  }
  if (preview) {
    const buffer = snapshot.buffer;
    if (preview.kind === "document") {
      const converted = await mammoth.convertToHtml({ buffer });
      return { path: relative, content: converted.value, language: "html", kind: "document", mimeType: preview.mimeType, size: snapshot.size };
    }
    return { path: relative, content: "", language: preview.kind, kind: preview.kind, mimeType: preview.mimeType, size: snapshot.size, dataUrl: `data:${preview.mimeType};base64,${buffer.toString("base64")}` };
  }
  const content = snapshot.buffer.toString("utf8");
  if (content.includes("\0")) throw new Error("Binary files cannot be edited in the dashboard.");
  return { path: relative, content, language: languageForFile(relative), kind: "text", mimeType: textMimeTypeForFile(relative), size: snapshot.size };
}

export async function deleteWorkspaceFile(
  projectPath: string | undefined,
  filePath: string | undefined
): Promise<string> {
  const { relative, absolute } = resolveWorkspaceFile(projectPath, filePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error("Only files can be deleted from the project tree.");
  await fs.unlink(absolute);
  return relative;
}

function terminalInfo(terminal: vscode.Terminal): DashboardWorkspaceTerminalInfo {
  return {
    id: terminal.name,
    name: terminal.name,
    state: terminal.exitStatus ? "idle" : "running",
    isActive: vscode.window.activeTerminal === terminal
  };
}

export function listWorkspaceTerminals(): DashboardWorkspaceTerminalInfo[] {
  return vscode.window.terminals.map(terminalInfo);
}

export function createWorkspaceTerminal(
  projectPath: string | undefined,
  profile: "default" | "powershell" | "cmd" | "bash" = "default",
  name?: string
): DashboardWorkspaceTerminalInfo {
  const cwd = resolveWorkspaceProjectPath(projectPath);
  const shellPath = profile === "powershell"
    ? resolveWindowsPowerShell()
    : profile === "cmd"
      ? (process.env["ComSpec"] || "cmd.exe")
      : profile === "bash" ? "bash" : undefined;
  const terminal = vscode.window.createTerminal({
    name: name?.trim() || `Codex · ${path.basename(cwd) || "Workspace"}`,
    cwd: vscode.Uri.file(cwd),
    ...(shellPath ? { shellPath } : {})
  });
  terminal.show(true);
  return terminalInfo(terminal);
}

export function focusWorkspaceTerminal(terminalId: string | undefined): DashboardWorkspaceTerminalInfo {
  const wanted = terminalId?.trim();
  const terminal = vscode.window.terminals.find((item) => item.name === wanted);
  if (!terminal) throw new Error("That VS Code terminal is no longer open. Refresh the terminal list.");
  terminal.show(true);
  return terminalInfo(terminal);
}

export async function saveWorkspaceFile(
  projectPath: string | undefined,
  filePath: string | undefined,
  content: string | undefined
): Promise<DashboardWorkspaceFile> {
  if (typeof content !== "string") throw new Error("The editor content is missing. Reload the file and try again.");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("Keep edited files under 1 MB.");
  const { relative, absolute } = await resolveReadableWorkspaceFile(projectPath, filePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error("Choose a file from the project tree.");
  // Write beside the original and replace it in one rename. A direct writeFile
  // truncates first, so a competing editor or interrupted process can leave a
  // zero-byte/partially written workspace file. The destination is untouched
  // if the other app has changed it while the editor was open.
  const temporaryPath = `${absolute}.${process.pid}.${Date.now()}.codex-manager.tmp`;
  await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  try {
    const current = await fs.stat(absolute);
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
      throw new Error("The file changed in another app while it was open. Reload it before saving.");
    }
    await fs.rename(temporaryPath, absolute);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return { path: relative, content, language: languageForFile(relative), kind: "text", mimeType: textMimeTypeForFile(relative), size: Buffer.byteLength(content, "utf8") };
}

function previewTypeForFile(filePath: string): { kind: "image" | "audio" | "video" | "pdf" | "document"; mimeType: string } | undefined {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const imageMimeTypes: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml", avif: "image/avif"
  };
  if (imageMimeTypes[extension]) return { kind: "image", mimeType: imageMimeTypes[extension] };
  const audioMimeTypes: Record<string, string> = {
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac"
  };
  if (audioMimeTypes[extension]) return { kind: "audio", mimeType: audioMimeTypes[extension] };
  const videoMimeTypes: Record<string, string> = {
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime"
  };
  if (videoMimeTypes[extension]) return { kind: "video", mimeType: videoMimeTypes[extension] };
  if (extension === "pdf") return { kind: "pdf", mimeType: "application/pdf" };
  if (extension === "docx") return { kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  return undefined;
}

function textMimeTypeForFile(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return ({ html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", json: "application/json", md: "text/markdown", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml" } as Record<string, string>)[extension] ?? "text/plain";
}

function resolveWorkspaceFile(projectPath: string | undefined, filePath: string | undefined): { relative: string; absolute: string } {
  const root = resolveWorkspaceProjectPath(projectPath);
  const requested = filePath?.trim().replace(/\\/g, "/") ?? "";
  if (!requested || path.isAbsolute(requested)) throw new Error("Choose a valid project file.");
  const absolute = path.resolve(root, requested);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) throw new Error("The selected file is outside the project.");
  return { relative: path.relative(root, absolute).replace(/\\/g, "/"), absolute };
}

function languageForFile(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return ({ tsx: "typescriptreact", jsx: "javascriptreact", md: "markdown", yml: "yaml", ps1: "powershell" } as Record<string, string>)[extension]
    ?? extension
    ?? "plaintext";
}

async function readWorkspaceEnvironmentInternal(cwd: string): Promise<DashboardWorkspaceEnvironment> {
  const projectName = path.basename(cwd) || cwd;
  const status = await runProcess("git", ["status", "--porcelain=v1", "--branch"], cwd, GIT_TIMEOUT_MS);
  if (status.exitCode !== 0) {
    return {
      projectPath: cwd,
      projectName,
      isGitRepository: false,
      changes: 0,
      additions: 0,
      deletions: 0,
      ahead: 0,
      behind: 0,
      hasRemote: false
    };
  }

  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  const branchLine = lines[0]?.startsWith("## ") ? lines.shift()?.slice(3) : undefined;
  const branchMatch = branchLine?.match(/^(.+?)(?:\.\.\.([^\s]+))?(?:\s+\[(.+)\])?$/);
  const relationship = branchMatch?.[3] ?? "";
  const ahead = Number(relationship.match(/ahead\s+(\d+)/)?.[1] ?? 0);
  const behind = Number(relationship.match(/behind\s+(\d+)/)?.[1] ?? 0);
  const [diff, remotes] = await Promise.all([
    runProcess("git", ["diff", "--numstat", "HEAD"], cwd, GIT_TIMEOUT_MS),
    runProcess("git", ["remote"], cwd, GIT_TIMEOUT_MS)
  ]);
  let additions = 0;
  let deletions = 0;
  if (diff.exitCode === 0) {
    for (const line of diff.stdout.split(/\r?\n/)) {
      const [added, removed] = line.split(/\s+/, 3);
      if (added && added !== "-") additions += Number(added) || 0;
      if (removed && removed !== "-") deletions += Number(removed) || 0;
    }
  }
  return {
    projectPath: cwd,
    projectName,
    isGitRepository: true,
    branch: branchMatch?.[1] === "HEAD" ? "Detached HEAD" : branchMatch?.[1],
    upstream: branchMatch?.[2],
    changes: lines.length,
    additions,
    deletions,
    ahead,
    behind,
    hasRemote: remotes.exitCode === 0 && Boolean(remotes.stdout.trim())
  };
}

export async function runWorkspaceTerminalCommand(options: {
  projectPath?: string;
  command?: string;
  terminalId?: string;
}): Promise<DashboardWorkspaceTerminalResult> {
  const command = options.command?.trim() ?? "";
  if (!command) throw new Error("Enter a command before running it.");
  if (command.length > MAX_COMMAND_CHARS) {
    throw new Error(`Keep terminal commands under ${MAX_COMMAND_CHARS.toLocaleString()} characters.`);
  }
  const terminalId = normalizeTerminalId(options.terminalId);
  if (activeTerminalCommands.has(terminalId)) {
    throw new Error("A command is already running in this terminal. Stop it or wait for it to finish.");
  }
  const cwd = resolveWorkspaceProjectPath(options.projectPath);
  // Interactive programs need a real VS Code TTY; a detached child process
  // reports “stdin is not a terminal” and exits before the user can interact.
  if (/^(?:codex|node|python(?:3)?|pwsh|powershell|bash|zsh|cmd)(?:\s|$)/i.test(command)) {
    const terminal = vscode.window.terminals.find((item) => item.name === options.terminalId)
      ?? vscode.window.createTerminal({
        name: options.terminalId?.trim() || `Codex · ${path.basename(cwd) || "Workspace"}`,
        cwd: vscode.Uri.file(cwd)
      });
    terminal.show(true);
    terminal.sendText(command, true);
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      terminalId: terminal.name,
      command,
      cwd,
      output: "Command sent to the VS Code terminal.",
      durationMs: 0,
      status: "completed",
      finishedAt: new Date().toISOString()
    };
  }
  const shell = process.platform === "win32"
    ? resolveWindowsShell(command)
    : { command: "/bin/sh", args: ["-lc", command] };
  const processResult = await runProcess(shell.command, shell.args, cwd, COMMAND_TIMEOUT_MS, terminalId);
  const status: DashboardWorkspaceTerminalResult["status"] = processResult.cancelled
    ? "cancelled"
    : processResult.timedOut
      ? "timedOut"
      : processResult.exitCode === 0
        ? "completed"
        : "failed";
  const output = [processResult.stdout, processResult.stderr]
    .filter(Boolean)
    .join(processResult.stdout && processResult.stderr ? "\n" : "");
  const result: DashboardWorkspaceTerminalResult = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    terminalId,
    command,
    cwd,
    output: output || (status === "completed" ? "Command completed without output." : "No command output was captured."),
    exitCode: processResult.exitCode,
    durationMs: processResult.durationMs,
    status,
    finishedAt: new Date().toISOString()
  };
  if (status !== "completed") {
    const message = status === "cancelled"
      ? "Terminal command cancelled."
      : status === "timedOut"
        ? "Terminal command timed out after 2 minutes."
        : `Terminal command failed with exit code ${processResult.exitCode ?? "unknown"}.`;
    throw new WorkspaceTerminalCommandError(message, result);
  }
  return result;
}

export function cancelWorkspaceTerminalCommand(terminalId: string | undefined): boolean {
  const child = activeTerminalCommands.get(normalizeTerminalId(terminalId));
  if (!child) return false;
  cancelledTerminalCommands.add(normalizeTerminalId(terminalId));
  terminateChildProcess(child);
  return true;
}

export async function commitWorkspaceChanges(
  projectPath: string | undefined,
  commitMessage: string | undefined,
  confirmed: boolean | undefined
): Promise<DashboardWorkspaceEnvironment> {
  if (confirmed !== true) throw new Error("Confirm committing all workspace changes, then try again.");
  const message = commitMessage?.trim() ?? "";
  if (!message) throw new Error("Enter a commit message before committing changes.");
  if (message.length > 200) throw new Error("Keep the commit message under 200 characters.");
  const cwd = resolveWorkspaceProjectPath(projectPath);
  await requireSuccessfulGit(["add", "--all"], cwd, "Workspace changes could not be staged.");
  await requireSuccessfulGit(["commit", "-m", message], cwd, "Git could not create the commit.");
  environmentReads.delete(cwd);
  return readWorkspaceEnvironment(cwd);
}

export async function pushWorkspaceBranch(
  projectPath: string | undefined,
  confirmed: boolean | undefined
): Promise<DashboardWorkspaceEnvironment> {
  if (confirmed !== true) throw new Error("Confirm pushing the current branch, then try again.");
  const cwd = resolveWorkspaceProjectPath(projectPath);
  await requireSuccessfulGit(["push"], cwd, "Git could not push the current branch.", COMMAND_TIMEOUT_MS);
  environmentReads.delete(cwd);
  return readWorkspaceEnvironment(cwd);
}

async function requireSuccessfulGit(args: string[], cwd: string, fallback: string, timeoutMs = GIT_TIMEOUT_MS): Promise<void> {
  const result = await runProcess("git", args, cwd, timeoutMs);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || fallback);
}

function normalizeTerminalId(value: string | undefined): string {
  const normalized = value?.trim() || "workspace-terminal";
  return /^[a-zA-Z0-9._:-]{1,120}$/.test(normalized) ? normalized : "workspace-terminal";
}

function resolveWindowsShell(command: string): { command: string; args: string[] } {
  // Most workspace commands are shell-neutral (`git`, `npm`, `dir`, etc.).
  // cmd.exe starts much faster than Windows PowerShell, while retaining
  // PowerShell for scripts that clearly depend on its cmdlets or syntax.
  const needsPowerShell = /\b(?:Write-Output|Write-Error|Start-Sleep|Get-[A-Za-z]|Set-[A-Za-z]|New-[A-Za-z]|Remove-[A-Za-z]|Where-Object|ForEach-Object)\b|\$env:|`/.test(command);
  return needsPowerShell
    ? { command: resolveWindowsPowerShell(), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] }
    : { command: process.env["ComSpec"] || "cmd.exe", args: ["/d", "/s", "/c", command] };
}

async function resolveReadableWorkspaceFile(
  projectPath: string | undefined,
  filePath: string | undefined
): Promise<{ relative: string; absolute: string }> {
  const resolved = resolveWorkspaceFile(projectPath, filePath);
  const root = resolveWorkspaceProjectPath(projectPath);
  const deadline = Date.now() + WORKSPACE_READ_TIMEOUT_MS;
  const [realRoot, realFile] = await Promise.all([
    workspaceReadBeforeDeadline(fs.realpath(root), deadline, "The workspace path took too long to inspect."),
    workspaceReadBeforeDeadline(fs.realpath(resolved.absolute), deadline, "The workspace file took too long to inspect.")
  ]);
  if (!isPathInside(realRoot, realFile)) throw new Error("The selected file resolves outside the project.");
  return { relative: resolved.relative, absolute: realFile };
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
  const normalizedCandidate = process.platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
  return normalizedCandidate !== normalizedRoot && normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

async function workspaceReadBeforeDeadline<T>(operation: Promise<T>, deadline: number, message: string): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    void operation.catch(() => undefined);
    throw new Error(message);
  }
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void operation.catch(() => undefined);
      reject(new Error(message));
    }, remainingMs);
    operation.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error instanceof Error ? error : new Error(String(error))); }
    );
  });
}

function resolveWindowsPowerShell(): string {
  if (resolvedWindowsPowerShell) return resolvedWindowsPowerShell;
  // PowerShell 7 is more reliable than Windows PowerShell 5 when Node starts
  // it without a visible console. Retain the inbox shell as the compatibility
  // fallback for machines where pwsh is not installed.
  const pwsh = spawnSync("where.exe", ["pwsh.exe"], { windowsHide: true, stdio: "ignore" });
  resolvedWindowsPowerShell = pwsh.status === 0 ? "pwsh.exe" : "powershell.exe";
  return resolvedWindowsPowerShell;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  terminalId?: string
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, { cwd, env: process.env, windowsHide: true });
    if (terminalId) activeTerminalCommands.set(terminalId, child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current, "utf8") >= MAX_OUTPUT_BYTES) return current;
      return `${current}${chunk.toString("utf8")}`.slice(0, MAX_OUTPUT_BYTES);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChildProcess(child);
    }, timeoutMs);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminalId && activeTerminalCommands.get(terminalId) === child) activeTerminalCommands.delete(terminalId);
      if (terminalId && child.exitCode === null && child.killed === false) cancelledTerminalCommands.delete(terminalId);
      callback();
    };
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => finish(() => {
      const explicitlyCancelled = terminalId ? cancelledTerminalCommands.delete(terminalId) : false;
      resolve({
        stdout,
        stderr,
        exitCode: code ?? undefined,
        durationMs: Date.now() - startedAt,
        cancelled: !timedOut && (explicitlyCancelled || signal !== null),
        timedOut
      });
    }));
  });
}

function terminateChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) return;
  child.kill();
  // PowerShell can leave a command child alive after the shell receives the
  // signal. Kill the process tree as a best-effort follow-up so cancellation
  // and timeout reach a terminal state promptly on Windows.
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", () => undefined);
    killer.stdout.resume();
    killer.stderr.resume();
  }
}
