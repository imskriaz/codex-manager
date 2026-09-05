import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  cancelWorkspaceTerminalCommand,
  commitWorkspaceChanges,
  deleteWorkspaceFile,
  pushWorkspaceBranch,
  listWorkspaceFiles,
  readWorkspaceFile,
  readWorkspaceEnvironment,
  resolveWorkspaceProjectPath,
  runWorkspaceTerminalCommand,
  saveWorkspaceFile,
  WorkspaceTerminalCommandError
} from "../src/services/workspaceTools";

describe("workspace tools", () => {
  it("reads the selected project Git environment", async () => {
    const environment = await readWorkspaceEnvironment(process.cwd());

    expect(environment.projectPath).toBe(process.cwd());
    expect(environment.projectName).toBe("codex-manager");
    expect(environment.isGitRepository).toBe(true);
    expect(environment.changes).toBeGreaterThanOrEqual(0);
    expect(environment.additions).toBeGreaterThanOrEqual(0);
    expect(environment.deletions).toBeGreaterThanOrEqual(0);
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
