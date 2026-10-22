import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { workspaceGit } from "../src/services/workspaceGit";
import { removeTestDirectory } from "./testFilesystem";
import type { WorkspaceGitRequest } from "../src/domain/dashboard/types";

async function fixture(task: (root: string, git: (...args: string[]) => string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-source-control-"));
  const folders = vscode.workspace.workspaceFolders;
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    value: [{ uri: { fsPath: root } }]
  });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--initial-branch=main");
    git("config", "core.autocrlf", "false");
    git("config", "user.name", "Source Control Test");
    git("config", "user.email", "test@example.invalid");
    await task(root, git);
  } finally {
    Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: folders });
    await removeTestDirectory(root);
  }
}
const read = (root: string) => workspaceGit(root, { operation: "read" }, false);
const change = async (root: string, request: WorkspaceGitRequest) =>
  workspaceGit(root, { ...request, operationId: randomUUID(), revision: (await read(root)).revision }, true);

describe("workspace source control", () => {
  it("stages and unstages an unborn repository without deleting work, then commits exactly staged changes", async () =>
    fixture(async (root, git) => {
      await writeFile(path.join(root, "first.txt"), "first");
      await change(root, { operation: "stage", path: "first.txt" });
      await change(root, { operation: "unstage", path: "first.txt" });
      expect(await readFile(path.join(root, "first.txt"), "utf8")).toBe("first");
      await change(root, { operation: "stage" });
      await writeFile(path.join(root, "not-staged.txt"), "keep");
      await change(root, { operation: "commit", staged: true, message: "First staged commit" });
      expect(git("show", "--format=", "--name-only", "HEAD")).toBe("first.txt");
      expect(git("status", "--porcelain")).toContain("not-staged.txt");
    }));
  it("rejects stale views, unconfirmed writes, escaping paths and invalid references", async () =>
    fixture(async (root) => {
      await writeFile(path.join(root, "file.txt"), "before");
      const before = await read(root);
      await writeFile(path.join(root, "file.txt"), "after-content-change");
      await expect(
        workspaceGit(root, { operation: "stage", operationId: randomUUID(), revision: before.revision }, true)
      ).rejects.toThrow("repository changed");
      await expect(workspaceGit(root, { operation: "stage" }, false)).rejects.toThrow("Confirm");
      for (const file of ["../outside.txt", ".git/config", "C:outside", "/outside", "a\0b"])
        await expect(change(root, { operation: "stage", path: file })).rejects.toThrow("inside");
      await expect(change(root, { operation: "createBranch", name: "--help" })).rejects.toThrow("valid Git branch");
      expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("after-content-change");
    }));
  it("reviews tracked diffs, discards only unstaged tracked edits and preserves staged work", async () =>
    fixture(async (root, git) => {
      await writeFile(path.join(root, "file.txt"), "original\n");
      git("add", ".");
      git("commit", "-m", "Initial");
      await writeFile(path.join(root, "file.txt"), "staged\n");
      await change(root, { operation: "stage" });
      await writeFile(path.join(root, "file.txt"), "working\n");
      const diff = await workspaceGit(root, { operation: "diff", path: "file.txt" }, false);
      expect(diff.diff).toContain("+working");
      await change(root, { operation: "discard", path: "file.txt" });
      expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("staged\n");
      expect(git("diff", "--cached")).toContain("+staged");
      await writeFile(path.join(root, "untracked.txt"), "keep");
      await expect(change(root, { operation: "discard", path: "untracked.txt" })).rejects.toThrow("Only tracked");
    }));
  it("creates, renames, switches and safely deletes branches; stashes are addressed by immutable hash", async () =>
    fixture(async (root, git) => {
      await writeFile(path.join(root, "file.txt"), "initial");
      git("add", ".");
      git("commit", "-m", "Initial");
      await change(root, { operation: "createBranch", name: "feature/original" });
      await change(root, { operation: "renameBranch", ref: "feature/original", name: "feature/renamed" });
      await change(root, { operation: "switch", ref: "main" });
      await change(root, { operation: "deleteBranch", ref: "feature/renamed" });
      await writeFile(path.join(root, "file.txt"), "saved work");
      const saved = await change(root, { operation: "stash", message: "Keep work" });
      const hash = saved.stashes[0]!.hash;
      expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("initial");
      await change(root, { operation: "applyStash", ref: hash });
      expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("saved work");
      await change(root, { operation: "dropStash", ref: hash });
      await expect(change(root, { operation: "popStash", ref: hash })).rejects.toThrow("no longer exists");
      expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("saved work");
    }));
  it("retains conflicts and rejects repo-wide operations from subprojects", async () =>
    fixture(async (root, git) => {
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "file.txt"), "initial\n");
      git("add", ".");
      git("commit", "-m", "Initial");
      await change(root, { operation: "createBranch", name: "conflict" });
      await writeFile(path.join(root, "file.txt"), "branch\n");
      git("add", ".");
      git("commit", "-m", "Branch");
      await change(root, { operation: "switch", ref: "main" });
      await writeFile(path.join(root, "file.txt"), "main\n");
      git("add", ".");
      git("commit", "-m", "Main");
      await expect(change(root, { operation: "merge", ref: "conflict" })).rejects.toThrow(
        "partial changes have been preserved"
      );
      expect(git("status", "--porcelain")).toContain("UU");
      await change(root, { operation: "abortMerge" });
      expect(git("status", "--porcelain")).toBe("");
      const nested = path.join(root, "nested");
      await expect(change(nested, { operation: "stash" })).rejects.toThrow("repository root");
    }));
  it("does not replay an acknowledged mutation with the same operation ID", async () =>
    fixture(async (root, git) => {
      await writeFile(path.join(root, "file.txt"), "one");
      git("add", ".");
      git("commit", "-m", "Initial");
      await writeFile(path.join(root, "file.txt"), "two");
      const input: WorkspaceGitRequest = {
        operation: "stage",
        operationId: randomUUID(),
        revision: (await read(root)).revision
      };
      const first = await workspaceGit(root, input, true);
      await writeFile(path.join(root, "file.txt"), "three");
      const second = await workspaceGit(root, input, true);
      expect(second.revision).toBe(first.revision);
      expect(git("show", ":file.txt")).toBe("two");
    }));
});
