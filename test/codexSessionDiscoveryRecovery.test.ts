import { mkdtemp, mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/services/codexAppServerRpc", () => ({ CodexAppServerRpc: { open: mocks.open }, CodexAppServerTurnInterruptedError: class extends Error {}, CodexAppServerDisconnectedError: class extends Error {} }));
import { readCodexCliSessions, readCodexCliSessionMessages } from "../src/services/codexSessionResume";

const id = "01a04882-d037-7a42-ad24-9afb61901188";
let root: string;
let previousHome: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-discovery-recovery-"));
  previousHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = root;
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback?: unknown) => key === "codexSessionTransport" ? "app-server-stdio" : fallback } as vscode.WorkspaceConfiguration);
  await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Recovered chat" }) + "\n");
  await mkdir(path.join(root, "sessions"));
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = previousHome;
  vi.restoreAllMocks();
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback } as vscode.WorkspaceConfiguration);
  mocks.open.mockReset();
  await rm(root, { recursive: true, force: true });
});

describe("session discovery recovery", () => {
  it("returns local sessions after initialize failure and backs off repeated refreshes", async () => {
    mocks.open.mockRejectedValue(new Error("initialize timed out"));
    expect((await readCodexCliSessions())[0]?.title).toBe("Recovered chat");
    expect((await readCodexCliSessions())[0]?.id).toBe(id);
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });
  it("coalesces slow startup while local history stays accessible", async () => {
    mocks.open.mockImplementation(() => new Promise(() => undefined));
    const lists = await Promise.all([readCodexCliSessions(), readCodexCliSessions()]);
    expect(lists.map((sessions) => sessions[0]?.id)).toEqual([id, id]);
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });
  it("enriches complete live rows from child transcript metadata before showing them as parents", async () => {
    mocks.open.mockResolvedValue({ request: vi.fn(async (_method: string, params: { archived: boolean }) => ({ data: params.archived ? [] : [{ id, name: "Inherited title", cwd: "D:/demo", source: "cli", status: { type: "idle" } }] })), close: vi.fn() });
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_nickname: "Reviewer" } } } } }) + "\n");
    expect((await readCodexCliSessions())[0]).toMatchObject({ subAgent: true, parentSessionId: "parent", agentName: "Reviewer" });
  });
  it("requests excluded child sources without letting them crowd out parents", async () => {
    const childId = "01a04882-d037-7a42-ad24-9afb61901189";
    const request = vi.fn(async (_method: string, params: { archived: boolean; sourceKinds?: string[] }) => ({ data: params.archived ? [] : params.sourceKinds ? [{ id: childId, name: "Inherited title", source: { subAgent: { threadSpawn: { parentThreadId: id, agentNickname: "Reviewer" } } }, status: { type: "active" } }] : [{ id, name: "Parent", cwd: "D:/demo", source: "cli" }] }));
    mocks.open.mockResolvedValue({ request, close: vi.fn() });
    const sessions = await readCodexCliSessions();
    expect(sessions.find(session => session.id === childId)).toMatchObject({ subAgent: true, parentSessionId: id, agentName: "Reviewer", status: "running" });
    expect(sessions.find(session => session.id === id)?.subAgent).not.toBe(true);
    expect(request).toHaveBeenCalledWith("thread/list", expect.objectContaining({ sourceKinds: expect.arrayContaining(["subAgentThreadSpawn"]), useStateDbOnly: true }));
  });
  it("reads appended messages directly even while the live server cannot initialize", async () => {
    mocks.open.mockRejectedValue(new Error("offline"));
    const transcript = path.join(root, "sessions", `rollout-${id}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "First update" }] } }) + "\n");
    expect((await readCodexCliSessionMessages(id)).map((message) => message.text)).toContain("First update");
    await appendFile(transcript, JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Live update" }] } }) + "\n");
    expect((await readCodexCliSessionMessages(id)).map((message) => message.text)).toContain("Live update");
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
