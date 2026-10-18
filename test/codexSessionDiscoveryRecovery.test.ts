import { mkdtemp, mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/services/codexAppServerRpc", () => ({ CodexAppServerRpc: { open: mocks.open }, CodexAppServerTurnInterruptedError: class extends Error {}, CodexAppServerDisconnectedError: class extends Error {} }));
import { getCodexSessionReadNotice, readCodexCliSessions, readCodexCliSessionMessages, SESSION_DISCOVERY_RETRY_GAP_MS } from "../src/services/codexSessionResume";
import { readCodexCliSessionRecoveryMetadata, readCodexCliSessionSummary, readCodexSessionMaintenanceCandidates } from "../src/services/codexSessionResume";
import * as fs from "fs/promises";
vi.mock("fs/promises", { spy: true });
import { DatabaseSync } from "node:sqlite";

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
  it("keeps older sessions inside each project beyond both previous metadata limits", async () => {
    const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
    const oldest = "00000000-0000-0000-0000-000000000000";
    try {
      db.exec("CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, archived INTEGER); BEGIN");
      const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, 0)");
      for (let i = 0; i < 2_100; i++) insert.run(`${i.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`, `Project task ${i}`, path.join(root, i % 2 ? "second" : "first"), i + 1);
      db.exec("COMMIT");
      const sessions = await readCodexCliSessions(root);
      expect(sessions.find(session => session.id === oldest)).toMatchObject({ title: "Project task 0", projectPath: path.join(root, "first") });
      expect(sessions.filter(session => session.projectPath === path.join(root, "first"))).toHaveLength(1_050);
      expect(sessions.filter(session => session.projectPath === path.join(root, "second"))).toHaveLength(1_050);
    } finally { db.close(); }
  });
  it("uses the native restored flag and current title even while the transcript remains in archives", async () => {
    const folder = path.join(root, "archived_sessions"); await mkdir(folder);
    const transcript = path.join(folder, `rollout-${id}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n");
    const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, rollout_path TEXT, archived INTEGER)");
      db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, 0)").run(id, "Current native title", root, transcript);
      expect(await readCodexCliSessionSummary(id)).toMatchObject({ title: "Current native title", archived: false });
      expect((await readCodexCliSessions(root)).find(row => row.id === id)).toMatchObject({ title: "Current native title", archived: false });
      db.exec("UPDATE threads SET title = NULL");
      expect((await readCodexCliSessionRecoveryMetadata([id], root))[id]?.title).toBe("Recovered chat");
      await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id, thread_name: `Codex session ${id.slice(0, 8)}` }) + "\n");
      expect((await readCodexCliSessionRecoveryMetadata([id], root))[id]?.title).toBe("Untitled conversation");
      db.exec("ALTER TABLE threads DROP COLUMN archived");
      expect((await readCodexCliSessionSummary(id))?.archived).toBe(true);
      expect((await readCodexSessionMaintenanceCandidates(root)).find(row => row.id === id)?.archived).toBe(true);
    } finally { db.close(); }
  });
  it("captures title and project in one local batch without running-state inspection or transcript scans", async () => {
    const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT)");
      db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(id, "Database title", process.platform === "win32" ? `\\\\?\\${root}` : root);
    } finally { db.close(); }
    const read = vi.spyOn(fs, "readdir").mockClear();
    const index = vi.spyOn(fs,"open").mockClear();
    expect(await readCodexCliSessionRecoveryMetadata([id], root)).toEqual({ [id]: { title: "Database title", projectPath: root, updatedAt: expect.any(Number) } });
    expect(read.mock.calls.every(([folder]) => String(folder) === root)).toBe(true);
    expect(index.mock.calls.some(([file]) => String(file).endsWith("session_index.jsonl"))).toBe(false);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("reads a database-only session directly without launching App Server or walking unrelated history", async () => {
    await writeFile(path.join(root,"session_index.jsonl"),"x".repeat(6*1024*1024));
    const transcript = path.join(root, "sessions", `rollout-${id}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id, cwd: root, source: "vscode" } }) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n");
    const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, rollout_path TEXT, source TEXT, archived INTEGER)");
      const nativePath = (value: string) => process.platform === "win32" ? `\\\\?\\${value}` : value;
      db.prepare("INSERT INTO threads VALUES (?, 'Database-only task', ?, ?, 'vscode', 0)").run(id, nativePath(root), nativePath(transcript));
      const original = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).readdir;
      const directories = vi.spyOn(fs, "readdir").mockImplementation(((file: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if ([path.join(root, "sessions"), path.join(root, "archived_sessions")].includes(String(file))) throw new Error("Unrelated history must stay unopened");
        return (original as Function)(file, ...args);
      }) as typeof fs.readdir);
      try { expect(await readCodexCliSessionSummary(id)).toMatchObject({ id, title: "Database-only task", projectPath: root, status: "idle" }); }
      finally { directories.mockRestore(); }
      expect(mocks.open).not.toHaveBeenCalled();
      db.prepare("UPDATE threads SET rollout_path = ?").run(path.join(root, "sessions", "missing.jsonl"));
      expect(await readCodexCliSessionSummary(id)).toMatchObject({ id, title: "Database-only task", projectPath: root });
      db.exec("UPDATE threads SET archived = 1");
      expect((await readCodexCliSessionSummary(id))?.archived).toBe(true);
    } finally { db.close(); }
  });
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
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n");
    const sessions = await readCodexCliSessions();
    expect(sessions[0]?.title).toBe("Recovered chat");
    expect((await readCodexCliSessions())[0]?.id).toBe(id);
    expect(getCodexSessionReadNotice(sessions)).toBeUndefined();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("coalesces local startup while history stays accessible", async () => {
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n");
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
  it("resolves each transcript path once per read and keeps unchanged message polls byte-free",async()=>{
    const transcript=path.join(root,"sessions",`rollout-${id}.jsonl`);
    await writeFile(transcript,JSON.stringify({type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text:"Stable messages"}]}})+"\n");
    const directories=vi.spyOn(fs,"readdir").mockClear();
    expect((await readCodexCliSessionMessages(id))[0]?.text).toBe("Stable messages");
    expect(directories.mock.calls.filter(([folder])=>String(folder)===root)).toHaveLength(1);
    directories.mockClear();
    expect((await readCodexCliSessionMessages(id))[0]?.text).toBe("Stable messages");
    expect(directories.mock.calls.filter(([folder])=>String(folder)===root)).toHaveLength(1);
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
