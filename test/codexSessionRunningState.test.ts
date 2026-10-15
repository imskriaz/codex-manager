import { appendFile, mkdtemp, mkdir, rm, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ heldLocks: new Set<string>(), nativeHeldLocks: new Set<string>(), nativeProbeError: false, lockError: undefined as string | undefined, openRpc: vi.fn() }));
vi.mock("fs/promises", async (original) => {
  const fs = await original<typeof import("fs/promises")>();
  return { ...fs, open: (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".lock")) {
      const code = mocks.lockError ?? (mocks.heldLocks.has(String(args[0])) ? "EBUSY" : undefined);
      if (code) return Promise.reject(Object.assign(new Error(code), { code }));
    }
    return fs.open(...args);
  } };
});
vi.mock("child_process", async (original) => {
  const child = await original<typeof import("child_process")>();
  return { ...child, execFile: (...args: any[]) => {
    if (args[0] === "powershell.exe") { args.at(-1)(mocks.nativeProbeError ? new Error("inspection timeout") : null, JSON.stringify([...mocks.nativeHeldLocks])); return {}; }
    if (args[0] === "lsof") { args.at(-1)(null, [...mocks.heldLocks].map((file) => `n${file}`).join("\n")); return {}; }
    return (child.execFile as any)(...args);
  } };
});
vi.mock("../src/services/codexAppServerRpc", () => ({ CodexAppServerRpc: { open: mocks.openRpc }, CodexAppServerTurnInterruptedError: class extends Error {}, CodexAppServerDisconnectedError: class extends Error {} }));
import { readCodexCliSessions, readCodexCliSessionSummary, readRunningCodexSessionIds } from "../src/services/codexSessionResume";
import { readAutoResumeCodexSessionIds } from "../src/services/codexSessionAutoResumeSelection";
import { readNativeCodexSessionRunning } from "../src/services/codexNativeSessionStatus";

const id = "01a04882-d037-7a42-ad24-9afb61901188";
let home: string;
let transcript: string;
let lock: string;
let previousHome: string | undefined;
const event = (type: string, turnId = "turn-1") => JSON.stringify({ type: "event_msg", payload: { type, turn_id: turnId } }) + "\n";
const select = () => readAutoResumeCodexSessionIds(home, [home], [], undefined, "running", false);

beforeEach(async () => {
  vi.mocked(readNativeCodexSessionRunning).mockReset().mockResolvedValue(undefined);
  home = await mkdtemp(path.join(os.tmpdir(), "codex-running-state-"));
  previousHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = home;
  transcript = path.join(home, "sessions", `rollout-${id}.jsonl`);
  lock = path.join(home, "thread-writer-locks", `${id}.lock`);
  await mkdir(path.dirname(transcript));
  await mkdir(path.dirname(lock));
  await writeFile(lock, "");
  await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Session" }));
  await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { source: "vscode", cwd: home } }) + "\n" + event("task_started"));
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback?: unknown) => key === "codexSessionTransport" ? "cli" : fallback } as vscode.WorkspaceConfiguration);
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = previousHome;
  mocks.heldLocks.clear(); mocks.nativeHeldLocks.clear(); mocks.nativeProbeError = false; mocks.lockError = undefined; mocks.openRpc.mockReset();
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback } as vscode.WorkspaceConfiguration);
  await rm(home, { recursive: true, force: true });
});

describe("shared running-session detection and auto resume", () => {
  it("shares concurrent running-session scans and keeps the remaining consumer alive after cancellation", async () => {
    let finish!: (running: boolean) => void;
    vi.mocked(readNativeCodexSessionRunning).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const first = readRunningCodexSessionIds(home, controller.signal);
    const checked = expect(first).rejects.toThrow("disabled");
    const second = readRunningCodexSessionIds(home);
    await vi.waitFor(() => expect(readNativeCodexSessionRunning).toHaveBeenCalledOnce());
    controller.abort(new Error("disabled"));
    await checked;
    finish(false);
    await expect(second).resolves.toEqual([]);
    expect(readNativeCodexSessionRunning).toHaveBeenCalledOnce();
  });
  it("excludes a native idle conversation with an unfinished transcript and retained writer handle", async () => {
    vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(false);
    mocks.heldLocks.add(lock);
    expect(await readRunningCodexSessionIds(home)).toEqual([]);
    expect(await select()).toEqual([]);
    expect(await readCodexCliSessionSummary(id, home)).toMatchObject({ status: "idle", locked: false });
    vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(true);
    expect(await readRunningCodexSessionIds(home)).toEqual([id]);
    expect(await select()).toEqual([id]);
  });
  it.each(["darwin", "linux"])("keeps a long running writer visible on %s and honors completion", async (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      const old = new Date(Date.now() - 15 * 60_000);
      await utimes(lock, old, old); await utimes(transcript, old, old);
      mocks.heldLocks.add(lock);
      Object.defineProperty(process, "platform", { value: platform });
      expect(await readRunningCodexSessionIds(home)).toEqual([id]);
      await appendFile(transcript, event("task_complete"));
      expect(await readRunningCodexSessionIds(home)).toEqual([]);
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });

  it("detects a long Windows writer even when Node can open its shared lock file", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      const old = new Date(Date.now() - 15 * 60_000);
      await utimes(lock, old, old); await utimes(transcript, old, old);
      mocks.nativeHeldLocks.add(lock);
      expect(await readRunningCodexSessionIds(home)).toEqual([id]);
      await appendFile(transcript, event("task_complete"));
      expect(await readRunningCodexSessionIds(home)).toEqual([]);
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });

  it("surfaces a Windows probe timeout and recovers from fresh transcript evidence", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      const old = new Date(Date.now() - 15 * 60_000);
      await utimes(lock, old, old); await utimes(transcript, old, old);
      mocks.nativeProbeError = true;
      await expect(readRunningCodexSessionIds(home)).rejects.toThrow("Windows session writer inspection failed");
      await appendFile(transcript, event("task_started", "fresh-turn"));
      expect(await readRunningCodexSessionIds(home)).toEqual([id]);
      await appendFile(transcript, event("task_complete", "fresh-turn"));
      expect(await readRunningCodexSessionIds(home)).toEqual([]);
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });

  it("selects the newest transcript when an older duplicate has already completed", async () => {
    await appendFile(transcript, event("task_complete"));
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(transcript, old, old);
    const newer = path.join(home, "sessions", `rollout-z-${id}.jsonl`);
    await writeFile(newer, JSON.stringify({ type: "session_meta", payload: { source: "vscode", cwd: home } }) + "\n" + event("task_started", "new-turn"));
    expect(await readRunningCodexSessionIds(home)).toEqual([id]);
    expect(await select()).toEqual([id]);
    await appendFile(newer, event("task_complete", "new-turn"));
    expect(await readRunningCodexSessionIds(home)).toEqual([]);
  });

  it("prefers the canonical state transcript over a newer stale duplicate", async () => {
    const duplicate = path.join(home, "sessions", `rollout-z-${id}.jsonl`);
    await writeFile(duplicate, event("task_complete"));
    const old = new Date(Date.now() - 1000);
    await utimes(transcript, old, old);
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE threads (id TEXT, title TEXT, updated_at INTEGER, archived INTEGER, source TEXT, cwd TEXT, rollout_path TEXT)");
      db.prepare("INSERT INTO threads VALUES (?, 'Canonical', 0, 0, 'vscode', ?, ?)").run(id, home, transcript);
      expect(await readRunningCodexSessionIds(home)).toEqual([id]);
      db.prepare("UPDATE threads SET rollout_path = ?").run(duplicate);
      expect(await readRunningCodexSessionIds(home)).toEqual([]);
    } finally { db.close(); }
  });

  it("finds three concurrent parent sessions even with missing locks and an incomplete index", async () => {
    const second = "01a04882-d037-7a42-ad24-9afb61901189";
    const third = "01a04882-d037-7a42-ad24-9afb61901190";
    for (const extra of [second, third]) {
      await writeFile(path.join(home, "sessions", `rollout-${extra}.jsonl`), JSON.stringify({ type: "session_meta", payload: { source: "vscode", cwd: home } }) + "\n" + event("task_started", extra));
    }
    expect(new Set(await readRunningCodexSessionIds(home))).toEqual(new Set([id, second, third]));
    const rows = await readCodexCliSessions(home, 1);
    expect(new Set(rows.filter((row) => row.status === "running").map((row) => row.id))).toEqual(new Set([id, second, third]));
    expect(new Set(await select())).toEqual(new Set([id, second, third]));
    await appendFile(path.join(home, "sessions", `rollout-${third}.jsonl`), event("task_complete", third));
    expect(new Set(await readRunningCodexSessionIds(home))).toEqual(new Set([id, second]));
  });

  it("does not revive stale or pre-reboot transcripts without locks", async () => {
    await rm(lock);
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(transcript, old, old);
    expect(await readRunningCodexSessionIds(home)).toEqual([]);
    await appendFile(transcript, event("task_started", "new-turn"));
    expect(await readRunningCodexSessionIds(home)).toEqual([id]);
  });

  it("keeps a long active turn running beyond the old tail window and after unchanged refreshes", async () => {
    await appendFile(transcript, JSON.stringify({ type: "response_item", payload: { type: "message", text: "x".repeat(800_000) } }) + "\n");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, old, old);
    for (let refresh = 0; refresh < 2; refresh++) {
      expect((await readCodexCliSessions(home))[0]).toMatchObject({ status: "running", locked: true });
      expect(await select()).toEqual([id]);
    }
    await appendFile(transcript, event("task_complete"));
    expect((await readCodexCliSessions(home))[0]).toMatchObject({ status: "idle", locked: false });
    expect(await select()).toEqual([]);
  });

  it.each(["task_complete", "task_completed", "task_failed", "turn_aborted", "turn_failed", "turn/completed"])(
    "honors %s even while an open conversation holds its writer lock", async (type) => {
      mocks.heldLocks.add(lock);
      await appendFile(transcript, event(type));
      expect(await readCodexCliSessionSummary(id, home)).toMatchObject({ status: "idle", locked: false });
      expect(await readRunningCodexSessionIds(home)).toEqual([]);
      expect(await select()).toEqual([]);
    }
  );

  it("ignores nested event names, partial records, and item starts after completion", async () => {
    await appendFile(transcript, JSON.stringify({ type: "response_item", payload: { type: "message", quoted: { type: "task_complete" } } }) + "\n");
    expect(await select()).toEqual([id]);
    const completed = event("task_complete");
    await appendFile(transcript, completed.slice(0, -4));
    expect(await select()).toEqual([id]);
    await appendFile(transcript, completed.slice(-4));
    await appendFile(transcript, event("item_started") + JSON.stringify({ type: "response_item", payload: { quoted: { type: "task_started" } } }) + "\n");
    expect(await select()).toEqual([]);
  });

  it("finds lifecycle events in a bounded tail of oversized transcripts", async () => {
    await truncate(transcript, 26 * 1024 * 1024);
    await appendFile(transcript, "\n" + event("task_started", "turn-2"));
    expect(await select()).toEqual([id]);
    await appendFile(transcript, event("turn_aborted", "turn-2"));
    expect(await select()).toEqual([]);
  });

  it("does not revive duplicate starts or let delayed completion stop a new turn", async () => {
    expect(await select()).toEqual([id]);
    await appendFile(transcript, event("task_complete") + event("task_started"));
    expect(await select()).toEqual([]);
    await appendFile(transcript, event("task_started", "turn-2") + event("task_complete"));
    expect(await select()).toEqual([id]);
    await appendFile(transcript, event("task_complete", "turn-2"));
    expect(await select()).toEqual([]);
  });

  it("replays a partial UTF-8 record from its original byte boundary", async () => {
    expect(await select()).toEqual([id]);
    const record = Buffer.from(JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", reason: "完成" } }) + "\n");
    const split = record.indexOf(Buffer.from("完成")) + 1;
    await appendFile(transcript, record.subarray(0, split));
    expect(await select()).toEqual([id]);
    await appendFile(transcript, record.subarray(split));
    expect(await select()).toEqual([]);
  });

  it("invalidates retained state when a transcript is truncated, replaced, or removed", async () => {
    expect(await readRunningCodexSessionIds(home)).toEqual([id]);
    await writeFile(transcript, event("task_complete"));
    expect(await readRunningCodexSessionIds(home)).toEqual([]);
    await writeFile(transcript, event("task_started"));
    expect(await readRunningCodexSessionIds(home)).toEqual([id]);
    await rm(transcript);
    expect(await readRunningCodexSessionIds(home)).toEqual([]);
    mocks.heldLocks.add(lock);
    expect(await readRunningCodexSessionIds(home)).toEqual([id]);
  });

  it("surfaces lock inspection failures for dashboard and reload callers to report", async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, old, old); await utimes(transcript, old, old);
    mocks.lockError = "EACCES";
    await expect(readCodexCliSessions(home)).rejects.toThrow("EACCES");
    await expect(select()).rejects.toThrow("EACCES");
    mocks.lockError = undefined;
    await appendFile(transcript, event("task_started", "recovered-turn"));
    expect(await select()).toEqual([id]);
  });

  it.each([true, false])("clears stale app-server running fields after completion (writer lock: %s)", async (held) => {
    if (held) mocks.heldLocks.add(lock); else await rm(lock);
    await appendFile(transcript, event("task_complete"));
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback?: unknown) => key === "codexSessionTransport" ? "app-server-stdio" : fallback } as vscode.WorkspaceConfiguration);
    mocks.openRpc.mockResolvedValue({ request: vi.fn(async (_method: string, params: { archived: boolean; sourceKinds?: string[] }) => ({ data: params.archived || params.sourceKinds ? [] : [{ id, name: "Session", cwd: home, source: "vscode", status: { type: "active" } }] })), close: vi.fn() });
    expect((await readCodexCliSessions(home))[0]).toMatchObject({ status: "idle", locked: false, canStop: false, runningBy: undefined });
    expect(await select()).toEqual([]);
  });
});
