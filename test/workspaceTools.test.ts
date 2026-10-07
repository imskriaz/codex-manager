import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  cancelWorkspaceTerminalCommand,
  commitWorkspaceChanges,
  deleteWorkspaceFile,
  pushWorkspaceBranch,
  listWorkspaceFiles,
  listWorkspaceTerminals,
  focusWorkspaceTerminal,
  readWorkspaceFile,
  readWorkspaceEnvironment,
  registerWorkspaceTerminalMonitoring,
  resolveWorkspaceProjectPath,
  runWorkspaceTerminalCommand,
  saveWorkspaceFile,
  WorkspaceTerminalCommandError
} from "../src/services/workspaceTools";
import { subscribeDashboardRealtime } from "../src/services/dashboardRealtime";

describe("workspace tools", () => {
  it.skipIf(process.platform !== "win32")("accepts Windows workspace casing without allowing sibling projects", () => {
    const restoreWorkspace = exposeWorkspaceRoot("D:\\Projects\\Codex-Manager");
    try {
      expect(resolveWorkspaceProjectPath("d:\\projects\\codex-manager")).toBe("d:\\projects\\codex-manager");
      expect(resolveWorkspaceProjectPath("d:\\projects\\codex-manager\\src")).toContain("src");
      expect(() => resolveWorkspaceProjectPath("D:\\Projects\\codex-manager-other")).toThrow(/open workspace folder/i);
    } finally { restoreWorkspace(); }
  });
  it.skipIf(process.platform !== "win32")("allows projects under an open drive root", () => {
    const restoreWorkspace = exposeWorkspaceRoot("D:\\");
    try { expect(resolveWorkspaceProjectPath("d:\\Projects\\app")).toContain("Projects"); }
    finally { restoreWorkspace(); }
  });
  it("reads the selected project Git environment", async () => {
    const environment = await readWorkspaceEnvironment(process.cwd());

    expect(environment.projectPath).toBe(process.cwd());
    expect(environment.projectName).toBe("codex-manager");
    expect(environment.isGitRepository).toBe(true);
    expect(environment.changes).toBeGreaterThanOrEqual(0);
    expect(environment.additions).toBeGreaterThanOrEqual(0);
    expect(environment.deletions).toBeGreaterThanOrEqual(0);
  });

  it("compares working changes and unpushed commits against Git's upstream", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "codex-branch-compare-"));
    const restoreWorkspace = exposeWorkspaceRoot(projectPath);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: projectPath, stdio: "ignore" });
    try {
      git("init", "--initial-branch=main");
      git("config", "user.name", "Workspace Test");
      git("config", "user.email", "workspace-test@example.invalid");
      await writeFile(join(projectPath, "proof.txt"), "original\n");
      git("add", "proof.txt");
      git("commit", "-m", "initial");
      expect(await readWorkspaceEnvironment(projectPath, true)).toMatchObject({ branchDiff: "", branchDiffBase: "HEAD" });
      const bare = join(projectPath, "remote.git");
      git("init", "--bare", bare);
      git("remote", "add", "origin", bare);
      git("push", "-u", "origin", "main");
      await writeFile(join(projectPath, "proof.txt"), "changed\n");
      const dirty = await readWorkspaceEnvironment(projectPath, true);
      expect(dirty.branchDiffBase).toBe("origin/main");
      expect(dirty.branchDiff).toContain("-original\n+changed");
      expect(dirty.branchDiffTruncated).toBe(false);
      git("add", "proof.txt");
      git("commit", "-m", "unpushed change");
      expect((await readWorkspaceEnvironment(projectPath, true)).branchDiff).toContain("+changed");
      git("push");
      expect((await readWorkspaceEnvironment(projectPath, true)).branchDiff).toBe("");
    } finally { restoreWorkspace(); await rm(projectPath, { recursive: true, force: true }); }
  });

  it("compares an unborn branch and reports a non-Git project explicitly", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "codex-branch-empty-"));
    const restoreWorkspace = exposeWorkspaceRoot(projectPath);
    try {
      await expect(readWorkspaceEnvironment(projectPath, true)).rejects.toThrow(/not a Git repository/i);
      execFileSync("git", ["init"], { cwd: projectPath, stdio: "ignore" });
      await writeFile(join(projectPath, "new.txt"), "new content\n");
      execFileSync("git", ["add", "new.txt"], { cwd: projectPath });
      const comparison = await readWorkspaceEnvironment(projectPath, true);
      expect(comparison.branchDiffBase).toBe("empty tree");
      expect(comparison.branchDiff).toContain("+new content");
    } finally { restoreWorkspace(); await rm(projectPath, { recursive: true, force: true }); }
  });

  it("runs a project-scoped terminal command and captures its terminal state", async () => {
    const command = process.platform === "win32"
      ? "Write-Output codex-workspace-terminal"
      : "printf codex-workspace-terminal";
    const result = await runWorkspaceTerminalCommand({
      projectPath: process.cwd(),
      command,
      terminalId: "workspace-test-success"
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("codex-workspace-terminal");
    expect(result.cwd).toBe(process.cwd());
  });

  it("publishes live terminal output before the command completes", async () => {
    const events: string[] = [];
    const unsubscribe = subscribeDashboardRealtime((message) => {
      if (message.type === "dashboard:terminal-output") events.push(message.output.chunk);
    });
    try {
      const command = process.platform === "win32"
        ? "Write-Output live-terminal-line"
        : "printf live-terminal-line";
      await runWorkspaceTerminalCommand({ projectPath: process.cwd(), command, terminalId: "workspace-test-live" });
      expect(events.join("")).toContain("live-terminal-line");
    } finally {
      unsubscribe();
    }
  });

  it("keeps duplicate terminal names distinct and rejects closed terminal IDs", () => {
    const original = vscode.window.terminals;
    const first = { name: "PowerShell", show: vi.fn() };
    const second = { name: "PowerShell", show: vi.fn() };
    Object.defineProperty(vscode.window, "terminals", { configurable: true, value: [first, second] });
    try {
      const terminals = listWorkspaceTerminals();
      expect(terminals[0].id).not.toBe(terminals[1].id);
      expect(terminals.map(item => item.name)).toEqual(["PowerShell (1)", "PowerShell (2)"]);
      expect(terminals.map(item => item.state)).toEqual(["unknown", "unknown"]);
      focusWorkspaceTerminal(terminals[1].id);
      expect(second.show).toHaveBeenCalled();
      expect(first.show).not.toHaveBeenCalled();
      Object.defineProperty(vscode.window, "terminals", { configurable: true, value: [first] });
      expect(() => focusWorkspaceTerminal(terminals[1].id)).toThrow(/no longer open/i);
    } finally { Object.defineProperty(vscode.window, "terminals", { configurable: true, value: original }); }
  });

  it("reserves a terminal while preparing integration and supports cancellation before execution", async () => {
    vi.useFakeTimers();
    const names = ["terminals", "createTerminal", "onDidChangeTerminalShellIntegration"] as const;
    const originals = names.map(name => vscode.window[name]);
    const terminal = { name: "Preparing terminal", show: vi.fn(), sendText: vi.fn() };
    const values = [[terminal], vi.fn(), () => ({ dispose: vi.fn() })];
    names.forEach((name, index) => Object.defineProperty(vscode.window, name, { configurable: true, value: values[index] }));
    try {
      const terminalId = listWorkspaceTerminals()[0].id;
      const pending = runWorkspaceTerminalCommand({ projectPath: process.cwd(), terminalId, command: "echo first" });
      const cancellation = expect(pending).rejects.toMatchObject({ result: { status: "cancelled" } });
      await expect(runWorkspaceTerminalCommand({ projectPath: process.cwd(), terminalId, command: "echo duplicate" })).rejects.toThrow(/already running/);
      expect(cancelWorkspaceTerminalCommand(terminalId)).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      await cancellation;
      expect(terminal.sendText).not.toHaveBeenCalled();
      expect(cancelWorkspaceTerminalCommand(terminalId)).toBe(false);
      expect(listWorkspaceTerminals()[0].state).toBe("unknown");
      Object.defineProperty(vscode.window, "terminals", { configurable: true, value: [] });
      await expect(runWorkspaceTerminalCommand({ projectPath: process.cwd(), terminalId, command: "echo stale" })).rejects.toThrow(/no longer open/);
    } finally {
      names.forEach((name, index) => Object.defineProperty(vscode.window, name, { configurable: true, value: originals[index] }));
      vi.useRealTimers();
    }
  });

  it("runs a command in the selected real VS Code terminal and streams its shell execution", async () => {
    const originalTerminals = vscode.window.terminals;
    const originalCreate = vscode.window.createTerminal;
    const originalEnd = vscode.window.onDidEndTerminalShellExecution;
    const callbacks: Array<(event: { execution: unknown; exitCode: number }) => void> = [];
    const execution = {
      commandLine: { value: "git status" },
      read: async function* () { yield "\u001b[32mreal-terminal-output\u001b[0m"; }
    };
    const terminal = {
      name: "Codex · test project",
      show: vi.fn(),
      sendText: vi.fn(),
      shellIntegration: { executeCommand: vi.fn(() => execution) }
    };
    Object.defineProperty(vscode.window, "terminals", { configurable: true, value: [terminal] });
    Object.defineProperty(vscode.window, "createTerminal", { configurable: true, value: vi.fn() });
    Object.defineProperty(vscode.window, "onDidEndTerminalShellExecution", {
      configurable: true,
      value: (callback: (event: { execution: unknown; exitCode: number }) => void) => {
        callbacks.push(callback);
        return { dispose: vi.fn() };
      }
    });
    const events: Array<{ type: string; output?: { chunk: string }; result?: { status: string; output: string } }> = [];
    const unsubscribe = subscribeDashboardRealtime((message) => events.push(message));
    try {
      const started = await runWorkspaceTerminalCommand({
        projectPath: process.cwd(), command: "git status", terminalId: terminal.name
      });
      expect(started).toMatchObject({ status: "running", terminalId: expect.stringMatching(/^native-terminal:/) });
      expect(terminal.shellIntegration.executeCommand).toHaveBeenCalledWith("git status");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events.some((event) => event.type === "dashboard:terminal-output" && event.output?.chunk.includes("real-terminal-output"))).toBe(true);
      callbacks[0]?.({ execution, exitCode: 0 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toContainEqual(expect.objectContaining({
        type: "dashboard:terminal-complete",
        result: expect.objectContaining({ id: started.id, status: "completed", output: "real-terminal-output" })
      }));
    } finally {
      unsubscribe();
      Object.defineProperty(vscode.window, "terminals", { configurable: true, value: originalTerminals });
      Object.defineProperty(vscode.window, "createTerminal", { configurable: true, value: originalCreate });
      Object.defineProperty(vscode.window, "onDidEndTerminalShellExecution", { configurable: true, value: originalEnd });
    }
  });

  it.each(["closed", "cancelled", "timedOut", "ended"] as const)("settles a stalled native stream when %s without a duplicate completion", async (reason) => {
    vi.useFakeTimers();
    const names = ["terminals", "createTerminal", "onDidEndTerminalShellExecution", "onDidCloseTerminal"] as const;
    const originals = names.map((name) => vscode.window[name]);
    let end: ((event: { execution: unknown; exitCode: number }) => void) | undefined;
    let close: ((terminal: unknown) => void) | undefined;
    let release: (() => void) | undefined;
    const execution = { read: async function* () { yield "partial output"; await new Promise<void>((resolve) => { release = resolve; }); } };
    const terminal = { name: "bounded-native-test", show: vi.fn(), sendText: vi.fn(), shellIntegration: { executeCommand: () => execution } };
    const disposed = vi.fn();
    const values = [[terminal], vi.fn(), (callback: typeof end) => { end = callback; return { dispose: disposed }; }, (callback: typeof close) => { close = callback; return { dispose: disposed }; }];
    names.forEach((name, index) => Object.defineProperty(vscode.window, name, { configurable: true, value: values[index] }));
    const events: Array<{ type: string; result?: { id: string; status: string; output: string } }> = [];
    const unsubscribe = subscribeDashboardRealtime((message) => events.push(message));
    try {
      const started = await runWorkspaceTerminalCommand({ projectPath: process.cwd(), terminalId: terminal.name, command: "echo partial" });
      await Promise.resolve();
      if (reason === "closed") close?.(terminal);
      else if (reason === "cancelled") {
        expect(cancelWorkspaceTerminalCommand(terminal.name)).toBe(true);
        await vi.advanceTimersByTimeAsync(5_000);
      } else if (reason === "timedOut") await vi.advanceTimersByTimeAsync(120_000);
      else { end?.({ execution, exitCode: 0 }); await vi.advanceTimersByTimeAsync(1_000); }
      expect(events.filter((event) => event.type === "dashboard:terminal-complete")).toEqual([
        expect.objectContaining({ result: expect.objectContaining({ id: started.id, status: reason === "ended" ? "completed" : reason === "closed" ? "cancelled" : reason === "cancelled" ? "untracked" : reason, output: expect.stringContaining("partial output") }) })
      ]);
      if (reason === "cancelled") expect(events.find((event) => event.type === "dashboard:terminal-complete")?.result?.output).toContain("did not confirm completion");
      if (reason === "ended") expect(events.find((event) => event.type === "dashboard:terminal-complete")?.result?.output).toContain("only captured output");
      if (reason === "cancelled" || reason === "timedOut") await expect(runWorkspaceTerminalCommand({ projectPath: process.cwd(), terminalId: started.terminalId, command: "echo duplicate" })).rejects.toThrow(/not confirmed completion/);
      expect(cancelWorkspaceTerminalCommand(terminal.name)).toBe(false);
      expect(disposed).toHaveBeenCalledTimes(2);
      release?.();
      end?.({ execution, exitCode: 0 });
      close?.(terminal);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(events.filter((event) => event.type === "dashboard:terminal-complete")).toHaveLength(1);
    } finally {
      release?.();
      unsubscribe();
      names.forEach((name, index) => Object.defineProperty(vscode.window, name, { configurable: true, value: originals[index] }));
      vi.useRealTimers();
    }
  });

  it("mirrors commands typed directly in VS Code into the dashboard terminal feed", async () => {
    const originalStart = vscode.window.onDidStartTerminalShellExecution;
    const originalEnd = vscode.window.onDidEndTerminalShellExecution;
    let start: ((event: unknown) => void) | undefined;
    let end: ((event: unknown) => void) | undefined;
    Object.defineProperty(vscode.window, "onDidStartTerminalShellExecution", {
      configurable: true,
      value: (callback: (event: unknown) => void) => { start = callback; return { dispose: vi.fn() }; }
    });
    Object.defineProperty(vscode.window, "onDidEndTerminalShellExecution", {
      configurable: true,
      value: (callback: (event: unknown) => void) => { end = callback; return { dispose: vi.fn() }; }
    });
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const events: Array<{ type: string; result?: { command: string; status: string } }> = [];
    const unsubscribe = subscribeDashboardRealtime((message) => events.push(message));
    try {
      registerWorkspaceTerminalMonitoring(context);
      const execution = { commandLine: { value: "echo typed-directly" }, read: async function* () { yield "typed-directly\n"; }, cwd: vscode.Uri.file(process.cwd()) };
      const terminal = { name: "User terminal" };
      start?.({ terminal, execution });
      await new Promise((resolve) => setTimeout(resolve, 0));
      end?.({ terminal, execution, exitCode: 0 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toContainEqual(expect.objectContaining({
        type: "dashboard:terminal-complete",
        result: expect.objectContaining({ command: "echo typed-directly", status: "completed" })
      }));
    } finally {
      unsubscribe();
      Object.defineProperty(vscode.window, "onDidStartTerminalShellExecution", { configurable: true, value: originalStart });
      Object.defineProperty(vscode.window, "onDidEndTerminalShellExecution", { configurable: true, value: originalEnd });
    }
  });

  it("preserves output and exit code when a terminal command fails", async () => {
    const command = process.platform === "win32"
      ? "echo workspace-terminal-failure 1>&2 & exit /b 7"
      : "printf workspace-terminal-failure >&2; exit 7";

    await expect(runWorkspaceTerminalCommand({
      projectPath: process.cwd(),
      command,
      terminalId: "workspace-test-failure"
    })).rejects.toMatchObject({
      name: "WorkspaceTerminalCommandError",
      result: expect.objectContaining({
        status: "failed",
        exitCode: 7,
        output: expect.stringContaining("workspace-terminal-failure")
      })
    } satisfies Partial<WorkspaceTerminalCommandError>);
  });

  it("returns false when cancellation has no active terminal command", () => {
    expect(cancelWorkspaceTerminalCommand("workspace-test-idle")).toBe(false);
  });

  it("cancels a running terminal command with a truthful terminal result", async () => {
    const terminalId = "workspace-test-cancel";
    const command = process.platform === "win32"
      ? "Start-Sleep -Seconds 10"
      : "sleep 10";
    const pending = runWorkspaceTerminalCommand({
      projectPath: process.cwd(),
      command,
      terminalId
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(cancelWorkspaceTerminalCommand(terminalId)).toBe(true);
    await expect(pending).rejects.toMatchObject({
      result: expect.objectContaining({ status: "cancelled" })
    });
  });

  it("requires explicit confirmation before commit or push", async () => {
    await expect(commitWorkspaceChanges(process.cwd(), "test commit", false))
      .rejects.toThrow("Confirm committing all workspace changes");
    await expect(pushWorkspaceBranch(process.cwd(), false))
      .rejects.toThrow("Confirm pushing the current branch");
  });

  it("lists, reads, and saves files inside a project without escaping it", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "codex-workspace-files-"));
    const restoreWorkspace = exposeWorkspaceRoot(projectPath);
    try {
      await mkdir(join(projectPath, "src"));
      await writeFile(join(projectPath, "src", "app.ts"), "export const value = 1;\n", "utf8");
      await writeFile(join(projectPath, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
      await writeFile(join(projectPath, "sample.mp3"), Buffer.from("media"));
      await writeFile(join(projectPath, "sample.mp4"), Buffer.from("media"));
      const entries = await listWorkspaceFiles(projectPath);
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "src", type: "directory" }),
        expect.objectContaining({ path: "src/app.ts", type: "file" })
      ]));
      const opened = await readWorkspaceFile(projectPath, "src/app.ts");
      expect(opened).toMatchObject({ language: "ts", kind: "text", mimeType: "text/plain", content: "export const value = 1;\n" });
      await expect(readWorkspaceFile(projectPath, "pixel.png")).resolves.toMatchObject({ kind: "image", mimeType: "image/png", dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
      await expect(readWorkspaceFile(projectPath, "sample.mp3")).resolves.toMatchObject({ kind: "audio", mimeType: "audio/mpeg", dataUrl: expect.stringMatching(/^data:audio\/mpeg;base64,/) });
      await expect(readWorkspaceFile(projectPath, "sample.mp4")).resolves.toMatchObject({ kind: "video", mimeType: "video/mp4", dataUrl: expect.stringMatching(/^data:video\/mp4;base64,/) });
      await expect(saveWorkspaceFile(projectPath, "src/app.ts", "export const value = 2;\n", opened.revision)).resolves.toMatchObject({ kind: "text", content: "export const value = 2;\n" });
      await expect(readFile(join(projectPath, "src", "app.ts"), "utf8")).resolves.toBe("export const value = 2;\n");
      await expect(readWorkspaceFile(projectPath, "../outside.txt")).rejects.toThrow(/outside the project/i);
    } finally {
      restoreWorkspace();
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects an arbitrary project path when VS Code has no open workspace", () => {
    const previous = vscode.workspace.workspaceFolders;
    Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: undefined });
    try {
      expect(() => resolveWorkspaceProjectPath(join(tmpdir(), "unopened-project"))).toThrow(/open workspace folder/i);
    } finally {
      Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: previous });
    }
  });

  it("keeps a dashboard draft from overwriting a file changed after it was opened", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "codex-workspace-stale-save-"));
    const restoreWorkspace = exposeWorkspaceRoot(projectPath);
    try {
      await writeFile(join(projectPath, "app.ts"), "opened version\n", "utf8");
      const opened = await readWorkspaceFile(projectPath, "app.ts");
      await writeFile(join(projectPath, "app.ts"), "new external version\n", "utf8");

      await expect(saveWorkspaceFile(projectPath, "app.ts", "stale dashboard draft\n", opened.revision))
        .rejects.toThrow(/changed after it was opened/i);
      await expect(readFile(join(projectPath, "app.ts"), "utf8")).resolves.toBe("new external version\n");
    } finally {
      restoreWorkspace();
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects deletion through a directory link that resolves outside the project", async () => {
    const parent = await mkdtemp(join(tmpdir(), "codex-workspace-delete-link-"));
    const projectPath = join(parent, "project");
    const outsidePath = join(parent, "outside");
    const restoreWorkspace = exposeWorkspaceRoot(projectPath);
    try {
      await mkdir(projectPath);
      await mkdir(outsidePath);
      await writeFile(join(outsidePath, "keep.txt"), "keep\n", "utf8");
      await import("fs/promises").then(({ symlink }) =>
        symlink(outsidePath, join(projectPath, "linked"), process.platform === "win32" ? "junction" : "dir")
      );

      await expect(deleteWorkspaceFile(projectPath, "linked/keep.txt"))
        .rejects.toThrow(/resolves outside the project/i);
      await expect(readFile(join(outsidePath, "keep.txt"), "utf8")).resolves.toBe("keep\n");
    } finally {
      restoreWorkspace();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("cleans a partial temporary save after storage failure while preserving the original", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "codex-workspace-full-"));
    const restoreWorkspace = exposeWorkspaceRoot(projectPath);
    const originalWrite = fs.writeFile;
    let temporaryPath = "";
    try {
      await writeFile(join(projectPath, "keep.txt"), "original\n");
      const opened = await readWorkspaceFile(projectPath, "keep.txt");
      const write = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        temporaryPath = String(args[0]);
        await originalWrite(args[0], "partial");
        throw Object.assign(new Error("Storage is full"), { code: "ENOSPC" });
      });
      try { await expect(saveWorkspaceFile(projectPath, "keep.txt", "replacement", opened.revision)).rejects.toThrow("Storage is full"); }
      finally { write.mockRestore(); }
      expect(await readFile(join(projectPath, "keep.txt"), "utf8")).toBe("original\n");
      await expect(readFile(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restoreWorkspace();
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("commits all changes in the selected Git workspace after confirmation", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "codex-workspace-tools-"));
    const restoreWorkspace = exposeWorkspaceRoot(projectPath);
    try {
      execFileSync("git", ["init"], { cwd: projectPath, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "workspace-test@example.invalid"], { cwd: projectPath });
      execFileSync("git", ["config", "user.name", "Workspace Test"], { cwd: projectPath });
      await writeFile(join(projectPath, "proof.txt"), "workspace commit proof\n", "utf8");

      const environment = await commitWorkspaceChanges(projectPath, "Verify workspace commit", true);

      expect(environment.isGitRepository).toBe(true);
      expect(environment.changes).toBe(0);
      expect(execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: projectPath, encoding: "utf8" }).trim())
        .toBe("Verify workspace commit");
    } finally {
      restoreWorkspace();
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});

function exposeWorkspaceRoot(projectPath: string): () => void {
  const previous = vscode.workspace.workspaceFolders;
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    value: [{ uri: { fsPath: projectPath } }]
  });
  return () => Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: previous });
}
