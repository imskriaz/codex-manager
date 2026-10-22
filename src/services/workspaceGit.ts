import * as path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import type { WorkspaceGitRequest, WorkspaceGitState } from "../domain/dashboard/types";
import {
  readWorkspaceEnvironment,
  resolveWorkspaceProjectPathAsync,
  runProcess,
  invalidateWorkspaceEnvironment
} from "./workspaceTools";
import {
  runCrossWindowExclusive,
  runCrossWindowOnce,
  sharedPathKey,
  sharedResourceKey
} from "../utils/crossWindowOperations";
import { waitWithin } from "../utils/concurrency";
import * as vscode from "vscode";

const MUTATIONS = new Set([
  "stage",
  "unstage",
  "discard",
  "fetch",
  "pull",
  "push",
  "commit",
  "switch",
  "createBranch",
  "renameBranch",
  "deleteBranch",
  "merge",
  "abortMerge",
  "stash",
  "applyStash",
  "popStash",
  "dropStash"
]);
const REPOSITORY_OPERATIONS = new Set([
  "pull",
  "push",
  "commit",
  "switch",
  "createBranch",
  "renameBranch",
  "deleteBranch",
  "merge",
  "abortMerge",
  "stash",
  "applyStash",
  "popStash",
  "dropStash"
]);
const MAX_BYTES = 256 * 1024;
export async function workspaceGitCommand(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  const result = await runProcess(
    "git",
    ["--literal-pathspecs", "-c", "credential.interactive=false", ...args],
    cwd,
    timeout
  );
  if (result.timedOut) {
    throw new Error(
      "Git timed out. The operation may have partially finished; refresh the repository before retrying."
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      (result.stderr.trim() || result.stdout.trim() || "Git could not complete this operation.").slice(0, 4000)
    );
  }
  return result.stdout;
}
function relativeFile(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    /[\0\r\n]/.test(value) ||
    path.isAbsolute(value) ||
    /^[a-z]:/i.test(value) ||
    value.split(/[\\/]/).some((part) => part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error("Choose a file inside this project.");
  }
  return value.replace(/\\/g, "/");
}
function branch(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 240 ||
    value.startsWith("-") ||
    /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error("Enter a valid Git branch name.");
  }
  return value;
}
function text(value: unknown, label: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`Enter ${label} using at most ${max} characters.`);
  }
  return value.trim();
}
async function readState(cwd: string): Promise<WorkspaceGitState> {
  invalidateWorkspaceEnvironment(cwd);
  const [status, index, head, branches, stashes, environment] = await Promise.all([
    workspaceGitCommand(cwd, ["status", "--porcelain=v1", "-z", "--", "."]),
    workspaceGitCommand(cwd, ["ls-files", "--stage", "-z", "--", "."]),
    runProcess("git", ["rev-parse", "--verify", "HEAD"], cwd, 30_000),
    workspaceGitCommand(cwd, [
      "for-each-ref",
      "--count=501",
      "--format=%(refname:short)%00%(HEAD)%00%(refname)",
      "refs/heads",
      "refs/remotes"
    ]),
    workspaceGitCommand(cwd, ["stash", "list", "-50", "--format=%H%x00%gd%x00%gs"]),
    readWorkspaceEnvironment(cwd)
  ]);
  if (head.timedOut) {
    throw new Error("Git HEAD could not be verified. Refresh before changing this repository.");
  }
  if (
    Buffer.byteLength(status) >= MAX_BYTES ||
    Buffer.byteLength(index) >= MAX_BYTES ||
    environment.changedFilesTruncated ||
    (environment.changedFiles?.length ?? 0) > 1000
  ) {
    throw new Error(
      "This repository is too large for safe workspace changes. Use VS Code Source Control to finish this operation."
    );
  }
  const files = await waitWithin(
    Promise.all(
      (environment.changedFiles ?? []).map(async (file) => {
        try {
          const stat = await fs.lstat(path.join(cwd, file.path));
          return [file.path, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [file.path, "missing"];
          }
          throw error;
        }
      })
    ),
    5000,
    "Changed files did not respond. Reconnect the project before changing Git state."
  );
  const revision = createHash("sha256")
    .update(JSON.stringify([status, index, head.stdout, branches, stashes, files]))
    .digest("hex");
  return {
    revision,
    head: head.exitCode === 0 ? head.stdout.trim() : undefined,
    branch: environment.branch,
    branches: branches
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 500)
      .map((line) => {
        const [name, active, ref] = line.split("\0");
        return { name: name!, current: active === "*", remote: ref?.startsWith("refs/remotes/") === true };
      }),
    stashes: stashes
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, name, subject] = line.split("\0");
        return { hash: hash!, name: name!, subject: subject ?? "" };
      }),
    environment,
    truncated: branches.trim().split(/\r?\n/).length > 500
  };
}

export async function workspaceGit(
  project: string | undefined,
  request: WorkspaceGitRequest | undefined,
  confirmed: boolean
): Promise<WorkspaceGitState> {
  const cwd = await resolveWorkspaceProjectPathAsync(project);
  if (!request || !["read", "diff", ...MUTATIONS].includes(request.operation)) {
    throw new Error("Choose a supported Git operation.");
  }
  const root = (await workspaceGitCommand(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (request.operation === "read") {
    return readState(cwd);
  }
  if (request.operation === "diff") {
    const state = await readState(cwd);
    const args = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--relative",
      ...(request.staged ? ["--cached"] : []),
      "--",
      request.path ? relativeFile(request.path) : "."
    ];
    const diff = await workspaceGitCommand(cwd, args);
    return { ...state, diff, truncated: Buffer.byteLength(diff) >= MAX_BYTES };
  }
  if (!confirmed) {
    throw new Error("Confirm this Git operation before continuing.");
  }
  if (vscode.workspace.isTrusted === false) {
    throw new Error("Trust this workspace in VS Code before running Git mutations.");
  }
  if (!request.operationId || !/^[a-zA-Z0-9-]{8,100}$/.test(request.operationId)) {
    throw new Error("A unique Git operation ID is required.");
  }
  if (
    REPOSITORY_OPERATIONS.has(request.operation) &&
    path.relative(await fs.realpath(root), await fs.realpath(cwd)) !== ""
  ) {
    throw new Error(
      "This operation affects the entire repository. Select the repository root project before continuing."
    );
  }
  const common = await workspaceGitCommand(cwd, ["rev-parse", "--git-common-dir"]);
  const lock = sharedPathKey("workspace-git", await fs.realpath(path.resolve(cwd, common.trim())));
  const once = sharedResourceKey("workspace-git-action", [lock, request.operationId]);
  return runCrossWindowOnce(once, "Git operation", () =>
    runCrossWindowExclusive(lock, "Git operation", async (signal) => {
      const before = await readState(cwd);
      if (request.revision !== before.revision) {
        throw new Error(
          "The repository changed since this view was loaded. Refresh Git, review the changes, and retry."
        );
      }
      signal.throwIfAborted();
      let args: string[];
      switch (request.operation) {
        case "stage":
          args = ["add", "--all", "--", request.path ? relativeFile(request.path) : "."];
          break;
        case "unstage":
          args = before.head
            ? ["restore", "--staged", "--", request.path ? relativeFile(request.path) : "."]
            : ["rm", "--cached", "-r", "--", request.path ? relativeFile(request.path) : "."];
          break;
        case "discard": {
          const file = relativeFile(request.path);
          if (!before.environment?.changedFiles?.some((item) => item.path === file && item.index !== "?")) {
            throw new Error("Only tracked file changes can be discarded. Delete untracked files in the Files tab.");
          }
          args = ["restore", "--worktree", "--", file];
          break;
        }
        case "fetch":
          args = ["fetch", "--all", "--prune"];
          break;
        case "pull":
          args = ["pull", "--ff-only"];
          break;
        case "push":
          args = before.environment?.upstream ? ["push"] : ["push", "--set-upstream", "origin", branch(before.branch)];
          break;
        case "commit":
          args = request.staged
            ? ["commit", "-m", text(request.message, "a commit message")]
            : ["commit", "--only", "-m", text(request.message, "a commit message"), "--", "."];
          break;
        case "switch":
          args = ["switch", branch(request.ref)];
          break;
        case "createBranch":
          args = ["switch", "-c", branch(request.name), ...(request.ref ? [branch(request.ref)] : [])];
          break;
        case "renameBranch":
          args = ["branch", "-m", branch(request.ref), branch(request.name)];
          break;
        case "deleteBranch":
          args = ["branch", "-d", branch(request.ref)];
          break;
        case "merge":
          args = ["merge", "--no-edit", "--", branch(request.ref)];
          break;
        case "abortMerge":
          args = ["merge", "--abort"];
          break;
        case "stash":
          args = [
            "stash",
            "push",
            "--include-untracked",
            "-m",
            text(request.message || "Workspace changes", "a stash message")
          ];
          break;
        case "applyStash":
        case "popStash":
        case "dropStash": {
          const stash = before.stashes.find((item) => item.hash === request.ref);
          if (!stash) {
            throw new Error("This stash no longer exists. Refresh the stash list.");
          }
          args = [
            "stash",
            request.operation === "applyStash" ? "apply" : request.operation === "popStash" ? "pop" : "drop",
            request.operation === "applyStash" ? stash.hash : stash.name
          ];
          break;
        }
        default:
          throw new Error("Choose a supported Git operation.");
      }
      let output: string;
      try {
        output = await workspaceGitCommand(
          cwd,
          args,
          ["fetch", "pull", "push"].includes(request.operation) ? 120_000 : 30_000
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : "Git failed."} Refresh Git before retrying; conflicts or partial changes have been preserved.`
        );
      }
      try {
        return { ...(await readState(cwd)), output: output.trim() || "Git operation completed." };
      } catch (error) {
        return {
          ...before,
          output: output.trim() || "Git operation completed.",
          warning: `The operation finished, but status could not be refreshed: ${error instanceof Error ? error.message : String(error)}. Refresh before another change.`
        };
      }
    })
  );
}
