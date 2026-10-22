import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { parseGitHubRemote, workspaceGitHub } from "../src/services/workspaceGitHub";
import type { WorkspaceGitHubRequest } from "../src/domain/dashboard/types";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), auth: vi.fn(), remote: vi.fn() }));
vi.mock("undici", () => ({ fetch: mocks.fetch }));
vi.mock("vscode", () => ({ authentication: { getSession: mocks.auth }, workspace: {} }));
vi.mock("../src/services/workspaceTools", () => ({ resolveWorkspaceProjectPathAsync: vi.fn(async (value) => value) }));
vi.mock("../src/services/workspaceGit", () => ({ workspaceGitCommand: mocks.remote }));
const secret = "private-token-never-sent-to-browser";
const sha = "a".repeat(40);
const updated = "2026-10-22T00:00:00Z";
const pull = {
  id: 101,
  number: 12,
  title: "Review changes",
  state: "open",
  html_url: "https://github.com/example/project/pull/12",
  user: { login: "author" },
  updated_at: updated,
  head: { sha, ref: "feature" },
  base: { ref: "main" },
  body: "Description"
};
const release = {
  id: 22,
  name: "Release",
  tag_name: "v1",
  draft: true,
  updated_at: updated,
  html_url: "https://github.com/example/project/releases/tag/v1"
};
const api = (value: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
const writes = () => mocks.fetch.mock.calls.filter(([, options]) => options.method !== "GET");
const execute = (input: WorkspaceGitHubRequest, confirmed = true) =>
  workspaceGitHub("D:/fixture", { ...input, operationId: randomUUID() }, confirmed);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ accessToken: secret });
  mocks.remote.mockResolvedValue("git@github.com:example/project.git");
  mocks.fetch.mockImplementation(async (url: string, options: { method: string }) => {
    const route = new URL(url).pathname.replace("/repos/example/project", "");
    if (options.method !== "GET") return api(route.endsWith("/merge") ? { merged: true } : { id: 201 });
    if (!route) return api({ default_branch: "main", permissions: { push: true } });
    if (route === "/pulls" || route === "/issues") return api([pull]);
    if (route === "/pulls/12" || route === "/issues/12") return api(pull);
    if (route.includes("/comments"))
      return api([{ id: 1, body: "Comment", user: { login: "reviewer" }, created_at: updated }]);
    if (route.endsWith("/files"))
      return api([
        { filename: "src/app.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }
      ]);
    if (route.endsWith("/check-runs")) return api({ check_runs: [{ id: 9, name: "CI", conclusion: "success" }] });
    if (route === "/releases") return api([release]);
    if (route === "/releases/22") return api(release);
    if (route === "/actions/runs")
      return api({
        workflow_runs: [
          {
            id: 45,
            display_title: "Build",
            status: "in_progress",
            html_url: "https://github.com/example/project/actions/runs/45"
          }
        ]
      });
    if (route === "/actions/workflows") return api({ workflows: [{ id: 7, name: "Build", state: "active" }] });
    if (route === "/actions/runs/45")
      return api({ id: 45, display_title: "Build", status: "completed", conclusion: "success" });
    if (route.endsWith("/jobs"))
      return api({
        jobs: [
          { id: 8, name: "Tests", conclusion: "success", steps: [{ number: 1, name: "Verify", conclusion: "success" }] }
        ]
      });
    return api([]);
  });
});

describe("GitHub workspace tools", () => {
  it("accepts canonical GitHub remotes and rejects injected hosts, paths and embedded credentials", () => {
    for (const remote of [
      "https://github.com/example/project.git",
      "git@github.com:example/project.git",
      "ssh://git@github.com/example/project"
    ])
      expect(parseGitHubRemote(remote)).toBe("example/project");
    for (const remote of [
      "https://token@github.com/example/project",
      "https://github.com.evil.test/example/project",
      "https://github.com/example/../secret",
      "git@elsewhere:example/project",
      "https://github.com/example/project?token=x"
    ])
      expect(() => parseGitHubRemote(remote)).toThrow("github.com origin");
  });
  it("loads PR activity, file diffs and checks without returning credentials", async () => {
    const result = await execute({ section: "pulls", operation: "detail", number: 12 });
    expect(result).toMatchObject({
      repository: "example/project",
      authenticated: true,
      canWrite: true,
      detail: { headSha: sha },
      comments: [{ body: "Comment" }],
      files: [{ path: "src/app.ts" }],
      checks: [{ name: "CI", status: "success" }]
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(writes()).toHaveLength(0);
    for (const [url, options] of mocks.fetch.mock.calls) {
      expect(url).toMatch(/^https:\/\/api.github.com\/repos\/example\/project/);
      expect(options.redirect).toBe("error");
      expect(options.headers.Authorization).toBe(`Bearer ${secret}`);
    }
  });
  it.each([
    [
      { section: "pulls", operation: "create", title: "PR", head: "feature", base: "main", draft: true },
      "/pulls",
      "POST"
    ],
    [{ section: "issues", operation: "create", title: "Issue", body: "Details" }, "/issues", "POST"],
    [{ section: "issues", operation: "comment", number: 12, body: "Comment" }, "/issues/12/comments", "POST"],
    [{ section: "pulls", operation: "close", number: 12 }, "/pulls/12", "PATCH"],
    [{ section: "issues", operation: "reopen", number: 12 }, "/issues/12", "PATCH"],
    [
      { section: "pulls", operation: "merge", number: 12, expectedHead: sha, method: "squash" },
      "/pulls/12/merge",
      "PUT"
    ],
    [
      { section: "pulls", operation: "review", number: 12, expectedHead: sha, review: "APPROVE" },
      "/pulls/12/reviews",
      "POST"
    ],
    [{ section: "actions", operation: "cancelRun", number: 45 }, "/actions/runs/45/cancel", "POST"],
    [{ section: "actions", operation: "rerun", number: 45 }, "/actions/runs/45/rerun", "POST"],
    [
      { section: "actions", operation: "dispatch", number: 7, ref: "main", inputs: { target: "test" } },
      "/actions/workflows/7/dispatches",
      "POST"
    ],
    [{ section: "releases", operation: "create", title: "Release", tag: "v2", draft: true }, "/releases", "POST"],
    [
      { section: "releases", operation: "publishRelease", number: 22, expectedUpdatedAt: updated },
      "/releases/22",
      "PATCH"
    ],
    [
      { section: "releases", operation: "deleteRelease", number: 22, expectedUpdatedAt: updated },
      "/releases/22",
      "DELETE"
    ]
  ])("routes a confirmed action to its bounded repository endpoint: %j", async (input, route, method) => {
    await execute(input as WorkspaceGitHubRequest);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]![0]).toBe(`https://api.github.com/repos/example/project${route}`);
    expect(writes()[0]![1].method).toBe(method);
    if (input.operation === "merge")
      expect(JSON.parse(writes()[0]![1].body)).toMatchObject({ sha, merge_method: "squash" });
  });
  it("rejects unconfirmed, invalid, stale-release and missing-head mutations without an API write", async () => {
    await expect(execute({ section: "issues", operation: "create", title: "Issue" }, false)).rejects.toThrow("Confirm");
    await expect(execute({ section: "pulls", operation: "merge", number: 12, method: "merge" })).rejects.toThrow(
      "Refresh"
    );
    await expect(
      execute({ section: "pulls", operation: "review", number: 12, expectedHead: sha, review: "REQUEST_CHANGES" })
    ).rejects.toThrow("reason");
    await expect(
      execute({ section: "releases", operation: "deleteRelease", number: 22, expectedUpdatedAt: "old" })
    ).rejects.toThrow("changed on GitHub");
    await expect(
      execute({ section: "actions", operation: "dispatch", number: 7, ref: "main", inputs: { x: 2 } as never })
    ).rejects.toThrow("text values");
    expect(writes()).toHaveLength(0);
  });
  it("reports sign-in cancellation, authorization failures, rate limits, missing repos and malformed responses", async () => {
    mocks.auth.mockResolvedValueOnce({ accessToken: "private\ninvalid-token" });
    await expect(execute({ section: "issues", operation: "read" })).rejects.toThrow("credential format is invalid");
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValueOnce(undefined);
    await expect(execute({ section: "issues", operation: "connect" })).rejects.toThrow("cancelled");
    for (const [status, expected, headers] of [
      [401, "sign-in expired", {}],
      [403, "rate limit", { "x-ratelimit-remaining": "0" }],
      [404, "unavailable", {}],
      [429, "rate limit", {}]
    ] as const) {
      mocks.fetch.mockResolvedValueOnce(api({ message: "Failure" }, status, headers));
      await expect(execute({ section: "issues", operation: "read" })).rejects.toThrow(expected);
    }
    mocks.fetch.mockResolvedValueOnce(new Response("{", { status: 200 }));
    await expect(execute({ section: "issues", operation: "read" })).rejects.toThrow("unreadable");
  });
  it("keeps partial detail failures visible and lists workflow job steps", async () => {
    const run = await execute({ section: "actions", operation: "detail", number: 45 });
    expect(run.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Tests" }),
        expect.objectContaining({ name: "  Verify" })
      ])
    );
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation((url, options) =>
      url.includes("/comments") ? Promise.resolve(api({ message: "unavailable" }, 503)) : original(url, options)
    );
    const partial = await execute({ section: "pulls", operation: "detail", number: 12 });
    expect(partial.detail?.title).toBe(pull.title);
    expect(partial.warning).toContain("partial");
  });
  it("never replays a confirmed write after retry or after refresh failure", async () => {
    const input: WorkspaceGitHubRequest = {
      section: "issues",
      operation: "comment",
      number: 12,
      body: "Once",
      operationId: randomUUID()
    };
    const original = mocks.fetch.getMockImplementation()!;
    let wrote = false;
    mocks.fetch.mockImplementation((url, options) => {
      if (options.method !== "GET") {
        wrote = true;
        return Promise.resolve(api({ id: 201 }));
      }
      return wrote ? Promise.resolve(api({ message: "status failed" }, 503)) : original(url, options);
    });
    const first = await workspaceGitHub("D:/fixture", input, true);
    const second = await workspaceGitHub("D:/fixture", input, true);
    expect(first.warning).toContain("action completed");
    expect(first.refreshFailed).toBe(true);
    expect(second.warning).toBe(first.warning);
    expect(writes()).toHaveLength(1);
  });
});
