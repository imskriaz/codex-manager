import { mkdtemp, mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/services/codexAppServerRpc", () => ({ CodexAppServerRpc: { open: mocks.open }, CodexAppServerTurnInterruptedError: class extends Error {}, CodexAppServerDisconnectedError: class extends Error {} }));
import { getCodexSessionReadNotice, readCodexCliSessions, readCodexCliSessionMessages, SESSION_DISCOVERY_RETRY_GAP_MS } from "../src/services/codexSessionResume";

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
  it("keeps live discovery retries at least 30 seconds apart", () => {
    expect(SESSION_DISCOVERY_RETRY_GAP_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("reads locally running parents without starting a second app-server", async () => {
    const second = "01a04882-d037-7a42-ad24-9afb61901189";
    const third = "01a04882-d037-7a42-ad24-9afb61901190";
    for (const sessionId of [id, second, third]) await writeFile(path.join(root, "sessions", `rollout-${sessionId}.jsonl`), JSON.stringify({ type: "session_meta", payload: { source: "vscode", cwd: root } }) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: sessionId } }) + "\n");
    expect(new Set((await readCodexCliSessions(root)).filter((row) => row.status === "running").map((row) => row.id))).toEqual(new Set([id, second, third]));
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("returns local sessions without initialize failure or retry work", async () => {
    const sessions = await readCodexCliSessions();
    expect(sessions[0]?.title).toBe("Recovered chat");
    expect((await readCodexCliSessions())[0]?.id).toBe(id);
    expect(getCodexSessionReadNotice(sessions)).toBeUndefined();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("coalesces local startup while history stays accessible", async () => {
    const lists = await Promise.all([readCodexCliSessions(), readCodexCliSessions()]);
    expect(lists.map((sessions) => sessions[0]?.id)).toEqual([id, id]);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("enriches complete live rows from child transcript metadata before showing them as parents", async () => {
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_nickname: "Reviewer" } } } } }) + "\n");
    expect((await readCodexCliSessions())[0]).toMatchObject({ subAgent: true, parentSessionId: "parent", agentName: "Reviewer" });
  });
  it("requests excluded child sources without letting them crowd out parents", async () => {
    const childId = "01a04882-d037-7a42-ad24-9afb61901189";
    const sessions = await readCodexCliSessions();
    expect(sessions.find(session => session.id === childId)).toBeUndefined();
    expect(mocks.open).not.toHaveBeenCalled();
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
