import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { fetch } from "undici";
import type { WorkspaceGitHubItem, WorkspaceGitHubRequest, WorkspaceGitHubState } from "../domain/dashboard/types";
import { resolveWorkspaceProjectPathAsync } from "./workspaceTools";
import { workspaceGitCommand } from "./workspaceGit";
import { runCrossWindowExclusive, runCrossWindowOnce, sharedResourceKey } from "../utils/crossWindowOperations";
import { waitWithin } from "../utils/concurrency";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const array = (value: unknown): Json[] => (Array.isArray(value) ? value.map(object) : []);
const string = (value: unknown, max = 20_000): string => (typeof value === "string" ? value.slice(0, max) : "");
const positive = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;

export function parseGitHubRemote(remote: string): string {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim()
    );
  if (!match || match[2] === "." || match[2] === ".." || match[2]!.length > 100) {
    throw new Error(
      "Select a project with a github.com origin remote. Embedded credentials, custom hosts and redirect URLs are not accepted."
    );
  }
  return `${match[1]}/${match[2]}`;
}
async function credential(cwd: string): Promise<string | undefined> {
  const session = await waitWithin(
    Promise.resolve(vscode.authentication.getSession("github", ["repo"], { silent: true })),
    3000,
    "GitHub sign-in did not respond. Try Connect GitHub."
  ).catch(() => undefined);
  if (session?.accessToken) {
    return session.accessToken;
  }
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "credential.interactive=false", "credential", "fill"], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      windowsHide: true
    });
    let output = "",
      settled = false;
    const finish = (value?: string) => {
      if (settled) {
        return;
      }
      settled = true;
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
    child.stdin.end("protocol=https\nhost=github.com\n\n");
  });
}
async function api(
  repository: string,
  token: string | undefined,
  route = "",
  method = "GET",
  body?: Json
): Promise<unknown> {
  if (token !== undefined && (typeof token !== "string" || token.length > 8192 || /[^\x21-\x7e]/.test(token)))
    throw new Error("The GitHub credential format is invalid. Sign in again on the selected system.");
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20_000);
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
      method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Codex-Manager",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    let text = "";
    const decoder = new TextDecoder();
    for await (const data of response.body ?? []) {
      const chunk: unknown = data;
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("GitHub returned an invalid response stream.");
      }
      if (Buffer.byteLength(text) + chunk.length > 1024 * 1024) {
        controller.abort();
        throw new Error("GitHub response exceeded 1 MB. Open this item on GitHub for the full result.");
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("GitHub returned an unreadable response. Refresh to retry.");
    }
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("GitHub sign-in expired or was rejected. Connect GitHub on this system and retry.");
      }
      if (
        (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") ||
        response.status === 429
      ) {
        throw new Error("GitHub rate limit reached. Wait for the limit to reset, then refresh.");
      }
      if (response.status === 404) {
        throw new Error(
          "This repository or item is unavailable. It may be private, removed, or outside this GitHub account’s permissions."
        );
      }
      const message = string(object(value)["message"], 300).replace(
        /(?:gh[pousr]_[a-zA-Z0-9]+|github_pat_[a-zA-Z0-9_]+)/g,
        "[redacted]"
      );
      throw new Error(`GitHub ${response.status}: ${message || "The operation was rejected."}`);
    }
    return value;
  } catch (error) {
    if (timedOut) {
      throw new Error(
        method === "GET"
          ? "GitHub timed out. Refresh to retry."
          : "GitHub confirmation timed out. The action may have completed. Refresh and check its status before retrying; it was not replayed."
      );
    }
    throw error instanceof Error ? error : new Error("GitHub could not be reached. Reconnect and refresh.");
  } finally {
    clearTimeout(timeout);
  }
}
function item(row: Json, section: WorkspaceGitHubRequest["section"], repository: string): WorkspaceGitHubItem {
  const id = positive(row["id"]),
    number = positive(row["number"]);
  const prefix = `https://github.com/${repository}/`;
  const url = string(row["html_url"]);
  return {
    id,
    number: number || undefined,
    title: string(row["title"] || row["display_title"] || row["name"] || row["tag_name"], 1000),
    state: string(
      row["conclusion"] ||
        row["status"] ||
        (row["merged_at"] ? "merged" : row["draft"] && row["state"] !== "closed" ? "draft" : row["state"]) ||
        (section === "releases" ? "published" : ""),
      100
    ),
    url: url.startsWith(prefix) ? url : prefix,
    author: string(object(row["user"] || row["actor"])["login"], 100),
    updatedAt: string(row["updated_at"] || row["published_at"] || row["created_at"], 100),
    body: string(row["body"]),
    head: string(object(row["head"])["ref"], 256),
    base: string(object(row["base"])["ref"], 256),
    headSha: string(object(row["head"])["sha"], 64),
    draft: row["draft"] === true,
    ref: string(row["tag_name"] || row["head_branch"], 256)
  };
}
function required(value: unknown, label: string, max = 20_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`Enter ${label} using at most ${max} characters.`);
  }
  return value.trim();
}
async function read(
  repository: string,
  token: string | undefined,
  request: WorkspaceGitHubRequest
): Promise<WorkspaceGitHubState> {
  const page = request.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) {
    throw new Error("Choose a GitHub page from 1 to 100.");
  }
  const repo = object(await api(repository, token));
  const state = ["open", "closed", "all"].includes(request.state ?? "") ? request.state! : "open";
  const route = request.section === "actions" ? "/actions/runs" : `/${request.section}`;
  const result = await api(
    repository,
    token,
    `${route}?per_page=30&page=${page}${["pulls", "issues"].includes(request.section) ? `&state=${state}&sort=updated&direction=desc` : ""}`
  );
  const rows = request.section === "actions" ? array(object(result)["workflow_runs"]) : array(result);
  const entries = request.section === "issues" ? rows.filter((row) => !row["pull_request"]) : rows;
  const value: WorkspaceGitHubState = {
    repository,
    url: `https://github.com/${repository}`,
    authenticated: Boolean(token),
    canWrite: object(repo["permissions"])["push"] === true,
    defaultBranch: string(repo["default_branch"], 256),
    items: entries.map((row) => item(row, request.section, repository)),
    page,
    hasMore: rows.length === 30
  };
  if (request.section === "actions") {
    try {
      value.workflows = array(object(await api(repository, token, "/actions/workflows?per_page=100"))["workflows"]).map(
        (row) => ({ id: positive(row["id"]), name: string(row["name"], 256), state: string(row["state"], 100) })
      );
    } catch (error) {
      value.warning = `Runs loaded, but workflows could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (request.operation !== "detail") {
    return value;
  }
  const id = positive(request.number);
  if (!id) {
    throw new Error("Choose a valid GitHub item.");
  }
  const detailRoute = request.section === "actions" ? `/actions/runs/${id}` : `/${request.section}/${id}`;
  const detail = object(await api(repository, token, detailRoute));
  value.detail = item(detail, request.section, repository);
  const reads: Array<Promise<void>> = [];
  if (request.section === "pulls" || request.section === "issues") {
    reads.push(
      api(repository, token, `/issues/${id}/comments?per_page=100`).then((result) => {
        value.comments = array(result).map((row) => ({
          id: positive(row["id"]),
          author: string(object(row["user"])["login"], 100),
          body: string(row["body"]),
          createdAt: string(row["created_at"], 100)
        }));
      })
    );
  }
  if (request.section === "pulls") {
    reads.push(
      api(repository, token, `/pulls/${id}/files?per_page=100`).then((result) => {
        value.files = array(result).map((row) => ({
          path: string(row["filename"], 4096),
          status: string(row["status"], 100),
          additions: positive(row["additions"]),
          deletions: positive(row["deletions"]),
          patch: string(row["patch"], 32_768)
        }));
      })
    );
    if (/^[a-f0-9]{40,64}$/i.test(value.detail.headSha ?? "")) {
      reads.push(
        api(repository, token, `/commits/${value.detail.headSha}/check-runs?per_page=100`).then((result) => {
          value.checks = array(object(result)["check_runs"]).map((row) => ({
            id: positive(row["id"]),
            name: string(row["name"], 256),
            status: string(row["conclusion"] || row["status"], 100)
          }));
        })
      );
    }
  } else if (request.section === "actions") {
    reads.push(
      api(repository, token, `/actions/runs/${id}/jobs?per_page=100`).then((result) => {
        value.checks = array(object(result)["jobs"]).flatMap((row) => [
          {
            id: positive(row["id"]),
            name: string(row["name"], 256),
            status: string(row["conclusion"] || row["status"], 100)
          },
          ...array(row["steps"]).map((step) => ({
            id: positive(step["number"]),
            name: `  ${string(step["name"], 256)}`,
            status: string(step["conclusion"] || step["status"], 100)
          }))
        ]);
      })
    );
  }
  const outcomes = await Promise.allSettled(reads);
  const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) {
    value.warning = `Item loaded with partial details: ${failures.map((result) => (result.reason instanceof Error ? result.reason.message : "A detail read failed.")).join(" ")}`;
  }
  return value;
}

export async function workspaceGitHub(
  project: string | undefined,
  request: WorkspaceGitHubRequest | undefined,
  confirmed: boolean
): Promise<WorkspaceGitHubState> {
  if (vscode.workspace?.isTrusted === false) {
    throw new Error("Trust this workspace in VS Code before using authenticated GitHub tools.");
  }
  const cwd = await resolveWorkspaceProjectPathAsync(project);
  if (
    !request ||
    !["pulls", "issues", "actions", "releases"].includes(request.section) ||
    ![
      "read",
      "connect",
      "detail",
      "create",
      "comment",
      "close",
      "reopen",
      "merge",
      "review",
      "cancelRun",
      "rerun",
      "dispatch",
      "publishRelease",
      "deleteRelease"
    ].includes(request.operation)
  ) {
    throw new Error("Choose a supported GitHub action.");
  }
  const repository = parseGitHubRemote(await workspaceGitCommand(cwd, ["remote", "get-url", "origin"]));
  let token: string | undefined;
  if (request.operation === "connect") {
    const session = await waitWithin(
      Promise.resolve(vscode.authentication.getSession("github", ["repo"], { createIfNone: true })),
      90_000,
      "GitHub sign-in was not completed. Finish it in VS Code on the selected system, then retry."
    );
    token = session?.accessToken;
    if (!token) {
      throw new Error("GitHub sign-in was cancelled.");
    }
  } else {
    token = await credential(cwd);
  }
  if (["read", "detail", "connect"].includes(request.operation)) {
    return read(repository, token, request);
  }
  if (!confirmed) {
    throw new Error("Confirm this GitHub action before continuing.");
  }
  if (!token) {
    throw new Error("Connect GitHub on this system before changing a repository.");
  }
  if (
    request.body !== undefined &&
    (typeof request.body !== "string" || request.body.length > 20_000 || request.body.includes("\0"))
  ) {
    throw new Error("Use at most 20,000 characters for the description or comment.");
  }
  if (!request.operationId || !/^[a-zA-Z0-9-]{8,100}$/.test(request.operationId)) {
    throw new Error("A unique GitHub operation ID is required.");
  }
  const id = positive(request.number);
  let route: string,
    method = "POST",
    body: Json | undefined;
  if (request.operation === "create" && ["pulls", "issues"].includes(request.section)) {
    route = `/${request.section}`;
    body = { title: required(request.title, "a title", 256), body: string(request.body) };
    if (request.section === "pulls") {
      Object.assign(body, {
        head: required(request.head, "a source branch", 256),
        base: required(request.base, "a target branch", 256),
        draft: request.draft === true
      });
    }
  } else if (request.operation === "create" && request.section === "releases") {
    route = "/releases";
    body = {
      tag_name: required(request.tag, "a release tag", 256),
      name: required(request.title, "a release title", 256),
      body: string(request.body),
      draft: request.draft === true,
      prerelease: request.prerelease === true
    };
  } else if (request.operation === "dispatch" && request.section === "actions" && id) {
    if (
      request.inputs &&
      (Object.keys(request.inputs).length > 25 ||
        Object.entries(request.inputs).some(
          ([key, value]) => key.length > 100 || typeof value !== "string" || value.length > 1000
        ))
    ) {
      throw new Error("Workflow inputs must contain at most 25 short text values.");
    }
    route = `/actions/workflows/${id}/dispatches`;
    body = { ref: required(request.ref, "a workflow branch or tag", 256), inputs: request.inputs ?? {} };
  } else if (id && ["pulls", "issues"].includes(request.section) && request.operation === "comment") {
    route = `/issues/${id}/comments`;
    body = { body: required(request.body, "a comment") };
  } else if (id && ["pulls", "issues"].includes(request.section) && ["close", "reopen"].includes(request.operation)) {
    route = `/${request.section}/${id}`;
    method = "PATCH";
    body = { state: request.operation === "close" ? "closed" : "open" };
  } else if (id && request.section === "pulls" && request.operation === "merge") {
    if (
      !/^[a-f0-9]{40,64}$/i.test(request.expectedHead ?? "") ||
      !["merge", "squash", "rebase"].includes(request.method ?? "")
    ) {
      throw new Error("Refresh the pull request and choose a merge method.");
    }
    route = `/pulls/${id}/merge`;
    method = "PUT";
    body = { sha: request.expectedHead, merge_method: request.method };
  } else if (id && request.section === "pulls" && request.operation === "review") {
    if (
      !/^[a-f0-9]{40,64}$/i.test(request.expectedHead ?? "") ||
      !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(request.review ?? "")
    ) {
      throw new Error("Refresh the pull request and choose a review decision.");
    }
    route = `/pulls/${id}/reviews`;
    body = { event: request.review, body: string(request.body), commit_id: request.expectedHead };
    if (request.review === "REQUEST_CHANGES") {
      required(request.body, "a reason for the requested changes");
    }
  } else if (id && request.section === "actions" && ["cancelRun", "rerun"].includes(request.operation)) {
    route = `/actions/runs/${id}/${request.operation === "cancelRun" ? "cancel" : "rerun"}`;
  } else if (id && request.section === "releases" && ["publishRelease", "deleteRelease"].includes(request.operation)) {
    if (!request.expectedUpdatedAt) {
      throw new Error("Refresh this release before changing it.");
    }
    route = `/releases/${id}`;
    method = request.operation === "deleteRelease" ? "DELETE" : "PATCH";
    body = request.operation === "publishRelease" ? { draft: false } : undefined;
  } else {
    throw new Error("This GitHub operation is not available for the selected item.");
  }
  const lock = sharedResourceKey("workspace-github", repository);
  return runCrossWindowOnce(
    sharedResourceKey("workspace-github-action", [repository, request.operationId]),
    "GitHub action",
    () =>
      runCrossWindowExclusive(lock, "GitHub action", async (signal) => {
        signal.throwIfAborted();
        if (request.section === "releases" && ["publishRelease", "deleteRelease"].includes(request.operation)) {
          const current = object(await api(repository, token, `/releases/${id}`));
          if (current["updated_at"] !== request.expectedUpdatedAt) {
            throw new Error("This release changed on GitHub. Refresh and review it before retrying.");
          }
        }
        const result = object(await api(repository, token, route, method, body));
        if (request.operation === "merge" && result["merged"] !== true) {
          throw new Error(
            string(result["message"], 300) ||
              "GitHub did not merge this pull request. Refresh its checks and resolve conflicts."
          );
        }
        try {
          return await read(repository, token, { ...request, operation: "read" });
        } catch (error) {
          return {
            repository,
            url: `https://github.com/${repository}`,
            authenticated: true,
            canWrite: true,
            items: [],
            page: 1,
            hasMore: false,
            refreshFailed: true,
            warning: `The action completed, but the updated list could not be read: ${error instanceof Error ? error.message : String(error)}. Refresh before another action.`
          };
        }
      })
  );
}
