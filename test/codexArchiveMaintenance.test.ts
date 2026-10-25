import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeTestDirectory } from "./testFilesystem";
const mocks = vi.hoisted(() => ({ held: false, beforeProbe: undefined as (() => void) | undefined, open: vi.fn() }));
vi.mock("child_process", async original => ({ ...await original<typeof import("child_process")>(), execFile: vi.fn((_command, args, _options, callback) => {
  mocks.beforeProbe?.();
  const lock = path.join(process.env.CODEX_HOME!, "thread-writer-locks", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.lock");
  callback(null, process.platform === "win32" ? JSON.stringify(mocks.held ? [lock] : []) : mocks.held ? `n${lock}` : "");
}) }));
vi.mock("../src/services/codexAppServerRpc", () => ({ CodexAppServerRpc: { open: mocks.open }, CodexAppServerDisconnectedError: class extends Error {}, CodexAppServerTurnInterruptedError: class extends Error {} }));
import { readCodexArchiveMaintenanceState, deleteCodexCliSession } from "../src/services/codexSessionResume";
import { getNativeCodexSessionRunning, readNativeCodexSessionRunning } from "../src/services/codexNativeSessionStatus";
let folder: string, previousHome: string | undefined, db: DatabaseSync;
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "codex-archive-state-"));
  previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = folder;
  db = new DatabaseSync(path.join(folder, "state_1.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,archived INTEGER,rollout_path TEXT)");
  db.prepare("INSERT INTO threads VALUES(?,?,?,?)").run(id, "Archived chat", 1, path.join(folder, "unreadable-large-transcript.jsonl"));
  mocks.held = false; mocks.beforeProbe = undefined; mocks.open.mockReset();
  vi.mocked(getNativeCodexSessionRunning).mockReturnValue(undefined); vi.mocked(readNativeCodexSessionRunning).mockClear();
});
afterEach(async () => {
  db.close(); vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  await removeTestDirectory(folder);
});
it("checks an archive using native metadata without transcript reads or native renderer IPC", async () => {
  expect(await readCodexArchiveMaintenanceState(id)).toEqual({ archived: true, status: "idle" });
  expect(readNativeCodexSessionRunning).not.toHaveBeenCalled();
});
it("protects a running native owner and an actual writer lock", async () => {
  vi.mocked(getNativeCodexSessionRunning).mockReturnValue(true);
  expect((await readCodexArchiveMaintenanceState(id))?.status).toBe("running");
  vi.mocked(getNativeCodexSessionRunning).mockReturnValue(undefined);
  await mkdir(path.join(folder, "thread-writer-locks"));
  await writeFile(path.join(folder, "thread-writer-locks", `${id}.lock`), "");
  mocks.held = true;
  expect((await readCodexArchiveMaintenanceState(id))?.status).toBe("running");
});
it("keeps a conversation unarchived while its writer lock was being inspected", async () => {
  await mkdir(path.join(folder, "thread-writer-locks"));
  await writeFile(path.join(folder, "thread-writer-locks", `${id}.lock`), "");
  mocks.beforeProbe = () => db.prepare("UPDATE threads SET archived=0 WHERE id=?").run(id);
  await expect(deleteCodexCliSession(id, { archivedOnly: true })).rejects.toThrow("no longer archived");
  expect(mocks.open).not.toHaveBeenCalled();
});
it("keeps missing threads and invalid writer locks", async () => {
  db.prepare("DELETE FROM threads").run();
  await expect(deleteCodexCliSession(id, { archivedOnly: true })).rejects.toThrow("no longer archived");
  db.prepare("INSERT INTO threads(id,archived) VALUES(?,1)").run(id);
  await mkdir(path.join(folder, "thread-writer-locks", `${id}.lock`), { recursive: true });
  await expect(readCodexArchiveMaintenanceState(id)).rejects.toThrow("lock is invalid");
  expect(mocks.open).not.toHaveBeenCalled();
});
