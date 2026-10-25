import { mkdtemp, mkdir, writeFile, readFile, utimes, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTestDirectory } from "./testFilesystem";

const mocks = vi.hoisted(() => ({ home: "", sessions: vi.fn(), summary: vi.fn(), goals: vi.fn(), clear: vi.fn(), remove: vi.fn(), restore: vi.fn() }));
vi.mock("../src/services/codexSessionResume", () => ({ resolveCodexHome: () => mocks.home, SESSION_ID_PATTERN: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, readCodexSessionMaintenanceCandidates: mocks.sessions, readCodexCliSessionSummary: mocks.summary, readCodexArchiveMaintenanceState: mocks.summary, clearCodexSessionGoal: mocks.clear, deleteCodexCliSession: mocks.remove, unarchiveCodexCliSession: mocks.restore, withCodexSessionMaintenance: async (_ids: string[], task: () => Promise<unknown>) => task() }));
vi.mock("../src/services/codexSessionGoals", () => ({ readCodexSessionGoals: mocks.goals }));
vi.mock("../src/utils/persistentLog", () => ({ recordPersistentEvent: vi.fn() }));
vi.mock("../src/utils/crossWindowOperations", () => ({ runCrossWindowExclusive: async (_key: string, _label: string, task: (signal: AbortSignal) => Promise<void>) => task(new AbortController().signal) }));
let api: typeof import("../src/services/maintenance");
const ids = ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "cccccccc-cccc-cccc-cccc-cccccccccccc"];
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.home = await mkdtemp(path.join(os.tmpdir(), "codex-maintenance-"));
  mocks.sessions.mockResolvedValue(ids.map((id, index) => ({ id, title: `Chat ${index}`, archived: index !== 2 })));
  mocks.summary.mockImplementation(async id => ({ id, title: id, status: "idle", archived: id !== ids[2] }));
  mocks.goals.mockResolvedValue(new Map()); mocks.remove.mockResolvedValue(undefined); mocks.clear.mockResolvedValue(undefined); mocks.restore.mockResolvedValue(undefined);
  api = await import("../src/services/maintenance");
});
afterEach(async () => { vi.useRealTimers(); await removeTestDirectory(mocks.home); });
const finish = async (id: string) => { await vi.waitFor(() => expect(api.getMaintenanceJob(id).status).not.toBe("running")); return api.getMaintenanceJob(id); };

describe("Codex maintenance safety", () => {
  it('publishes bounded immutable progress and recovers an accepted job by preview without replaying writes', async () => {
    const { subscribeDashboardRealtime } = await import('../src/services/dashboardRealtime');
    const { isMaintenanceJob } = await import('../src/domain/maintenance');
    const events: import('../src/domain/maintenance').MaintenanceJob[] = [];
    const dispose = subscribeDashboardRealtime(message => { if (message.type === 'dashboard:maintenance-progress') events.push(message.job); });
    try {
      mocks.goals.mockResolvedValue(new Map(Array.from({ length: 1000 }, (_, index) => [`${index.toString(16).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, { objective: 'Clean goal', status: 'paused' }])));
      const preview = await api.previewMaintenance('goals');
      expect(() => api.getMaintenanceJob('', false, preview.token)).toThrow('No operation');
      const job = api.runMaintenance(preview.token, true);
      expect(api.getMaintenanceJob('', false, preview.token).id).toBe(job.id);
      expect(() => api.getMaintenanceJob('', true, preview.token)).toThrow('no longer available');
      await finish(job.id);
      expect(events.length).toBeLessThanOrEqual(102);
      expect(events[0]).toMatchObject({ processed: 0, status: 'running', previewToken: preview.token });
      expect(events.at(-1)).toMatchObject({ processed: 1000, cleared: 1000, status: 'completed' });
      expect(events.every(isMaintenanceJob)).toBe(true);
      expect(events.every((event, index) => !index || event.revision! > events[index - 1]!.revision!)).toBe(true);
      expect(mocks.clear).toHaveBeenCalledTimes(1000);
      const home = mocks.home; mocks.home = home + '-other';
      try { expect(() => api.getMaintenanceJob('', false, preview.token)).toThrow('no longer available'); } finally { mocks.home = home; }
    } finally { dispose(); }
  });
  it("previews archives without waiting for unavailable goal storage", async () => {
    await writeFile(path.join(mocks.home, "goals_1.sqlite"), "unavailable");
    mocks.goals.mockImplementation(() => new Promise(() => {}));
    expect((await api.previewMaintenance("archives")).count).toBe(2);
    expect(mocks.goals).not.toHaveBeenCalled();
  });
  it("coalesces simultaneous previews without starting duplicate storage reads", async () => {
    const first = api.previewMaintenance("archives"), second = api.previewMaintenance("archives");
    expect(first).toBe(second); expect((await first).count).toBe(2); expect(mocks.sessions).toHaveBeenCalledOnce();
  });
  it("previews and searches archives before confirming selected deletion and coalesces duplicate requests", async () => {
    const preview = await api.previewMaintenance("archives");
    expect(preview.count).toBe(2); expect(mocks.remove).not.toHaveBeenCalled();
    expect(api.readMaintenancePage(preview.token, "Chat 1").items.map(item => item.id)).toEqual([ids[1]]);
    expect(() => api.runMaintenance(preview.token, false)).toThrow("confirm");
    expect(() => api.runMaintenance(preview.token, true, [ids[2]!])).toThrow("Choose items");
    const job = api.runMaintenance(preview.token, true, [ids[0]!]);
    expect(api.runMaintenance(preview.token, true, [ids[0]!]).id).toBe(job.id);
    expect(() => api.runMaintenance(preview.token, true, [ids[1]!])).toThrow("another operation");
    expect(await finish(job.id)).toMatchObject({ total: 1, cleared: 1, failed: 0 });
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(ids[0], { archivedOnly: true });
  });
  it("restores selected archived conversations without deleting their goals or chats", async () => {
    const preview = await api.previewMaintenance("archives");
    const job = api.runMaintenance(preview.token, true, [ids[1]!], "restore");
    expect(await finish(job.id)).toMatchObject({ operation: "restore", cleared: 1 });
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith(ids[1]); expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled();
  });
  it("keeps running, missing, unknown, and newly unarchived items and reports failures", async () => {
    mocks.summary.mockImplementation(async id => id === ids[0] ? { status: "running", archived: true } : { status: "unknown", archived: true });
    const job = api.runMaintenance((await api.previewMaintenance("archives")).token, true);
    expect(await finish(job.id)).toMatchObject({ cleared: 0, skipped: 1, failed: 1, status: "failed" });
    expect(mocks.remove).not.toHaveBeenCalled();
    mocks.summary.mockResolvedValue({ status: "idle", archived: false });
    const next = api.runMaintenance((await api.previewMaintenance("archives")).token, true);
    expect(await finish(next.id)).toMatchObject({ cleared: 0, skipped: 2 });
  });
  it("clears goals without deleting conversations and preserves failures", async () => {
    mocks.goals.mockResolvedValue(new Map([[ids[0], { objective: "Finish project", status: "active" }], [ids[1], { objective: "Another goal", status: "paused" }]]));
    mocks.clear.mockRejectedValueOnce(new Error("Storage full"));
    const job = api.runMaintenance((await api.previewMaintenance("goals")).token, true);
    expect(await finish(job.id)).toMatchObject({ cleared: 1, failed: 1 });
    expect(api.getMaintenanceJob(job.id).errors.join()).toContain("Storage full"); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("rejects unavailable goal storage, expired previews, foreign homes, and malformed selection", async () => {
    await writeFile(path.join(mocks.home, "goals_1.sqlite"), "broken"); mocks.goals.mockResolvedValue(undefined);
    await expect(api.previewMaintenance("goals")).rejects.toThrow("Goal storage");
    mocks.goals.mockResolvedValue(new Map());
    const preview = await api.previewMaintenance("archives");
    expect(() => api.runMaintenance(preview.token, true, "bad" as never)).toThrow("Choose items");
    const home = mocks.home; mocks.home = path.join(home, "other");
    expect(() => api.runMaintenance(preview.token, true)).toThrow("confirm"); mocks.home = home;
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(() => api.runMaintenance(preview.token, true)).toThrow(); expect(() => api.readMaintenancePage(preview.token)).toThrow("expired");
  });
  it("cancels work before the next mutation and reports protected items", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.summary.mockImplementation(async () => { await gate; return { status: "idle", archived: true }; });
    const job = api.runMaintenance((await api.previewMaintenance("archives")).token, true);
    await vi.waitFor(() => expect(mocks.summary).toHaveBeenCalled());
    api.getMaintenanceJob(job.id, true); release();
    expect(await finish(job.id)).toMatchObject({ status: "cancelled", cleared: 0, failed: 0 }); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("does not cascade deletion into unselected or running child conversations", async () => {
    mocks.sessions.mockResolvedValue([{ id: ids[0], title: "Parent", archived: true }, { id: ids[1], title: "Child", archived: false, parentSessionId: ids[0] }]);
    const job = api.runMaintenance((await api.previewMaintenance("archives")).token, true);
    expect(await finish(job.id)).toMatchObject({ cleared: 0, skipped: 1 }); expect(mocks.remove).not.toHaveBeenCalled();
    const nextPreview = await api.previewMaintenance("sessions");
    mocks.summary.mockImplementation(async id => ({ status: id === ids[1] ? "running" : "idle", archived: true }));
    const next = api.runMaintenance(nextPreview.token, true);
    expect(await finish(next.id)).toMatchObject({ cleared: 0, skipped: 2 }); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("finishes selected children before deleting their parent", async () => {
    mocks.sessions.mockResolvedValue([{ id: ids[0], title: "Parent", archived: true }, { id: ids[1], title: "Child", archived: true, parentSessionId: ids[0] }]);
    const order: string[] = [];
    let release!: () => void;
    mocks.remove.mockImplementation(async id => { order.push(id); if (id === ids[1]) await new Promise<void>(resolve => { release = resolve; }); });
    const job = api.runMaintenance((await api.previewMaintenance("archives")).token, true);
    await vi.waitFor(() => expect(order).toEqual([ids[1]]));
    release();
    expect(await finish(job.id)).toMatchObject({ cleared: 2, failed: 0 });
    expect(order).toEqual([ids[1], ids[0]]);
  });
  it("keeps parents when a selected child was unarchived after preview", async () => {
    mocks.sessions.mockResolvedValue([{ id: ids[0], title: "Parent", archived: true }, { id: ids[1], title: "Child", archived: true, parentSessionId: ids[0] }]);
    const preview = await api.previewMaintenance("archives");
    mocks.summary.mockImplementation(async id => ({ status: "idle", archived: id !== ids[1] }));
    expect(await finish(api.runMaintenance(preview.token, true).id)).toMatchObject({ cleared: 0, skipped: 2 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("reports unavailable running state without deleting after a read timeout", async () => {
    vi.useFakeTimers(); mocks.summary.mockImplementation(() => new Promise(() => {}));
    const job = api.runMaintenance((await api.previewMaintenance("archives")).token, true);
    await vi.advanceTimersByTimeAsync(40_001);
    expect(api.getMaintenanceJob(job.id)).toMatchObject({ failed: 2, cleared: 0, status: "failed" }); expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe("additional Codex utilities", () => {
  it("removes only previewed old shell snapshots and keeps recent, changed, and active snapshots", async () => {
    const directory = path.join(mocks.home, "shell_snapshots"); await mkdir(directory);
    for (const id of ids) { const file = path.join(directory, `${id}.sh`); await writeFile(file, "snapshot"); await utimes(file, new Date(0), new Date(Date.now() - 9 * 86_400_000)); }
    await writeFile(path.join(directory, "unrelated.txt"), "keep");
    const preview = await api.previewMaintenance("snapshots"); expect(preview.count).toBe(3);
    await writeFile(path.join(directory, `${ids[1]}.sh`), "changed");
    mocks.summary.mockImplementation(async id => id === ids[2] ? { status: "running" } : undefined);
    const job = api.runMaintenance(preview.token, true);
    expect(await finish(job.id)).toMatchObject({ cleared: 1, skipped: 2, failed: 0 });
    await expect(readFile(path.join(directory, `${ids[0]}.sh`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(directory, "unrelated.txt"), "utf8")).toBe("keep"); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("rejects linked shell snapshot directories", async () => {
    const outside = path.join(mocks.home, "outside"); await mkdir(outside); await symlink(outside, path.join(mocks.home, "shell_snapshots"), "junction");
    await expect(api.previewMaintenance("snapshots")).rejects.toThrow("linked");
  });
  it("reports missing and unrecorded projects without changing data", async () => {
    mocks.sessions.mockResolvedValue([{ id: ids[0], projectPath: mocks.home }, { id: ids[1], projectPath: path.join(mocks.home, "missing") }, { id: ids[2] }]);
    const report = await api.inspectMaintenanceStorage("projects");
    expect(report.items).toContainEqual({ label: "Missing projects", value: "1" });
    expect(report.items).toContainEqual({ label: "Chats without a recorded project", value: "1" }); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("checks every native database health read-only and ranks contained conversation files", async () => {
    const db = new DatabaseSync(path.join(mocks.home, "state_5.sqlite")); db.exec("CREATE TABLE example(id TEXT)"); db.close();
    const history = new DatabaseSync(path.join(mocks.home, "thread_history_5.sqlite")); history.exec("CREATE TABLE example(id TEXT)"); history.close();
    await writeFile(path.join(mocks.home, "chat.jsonl"), "x".repeat(2048));
    mocks.sessions.mockResolvedValue([{ id: ids[0], title: "Large chat", transcriptPath: path.join(mocks.home, "chat.jsonl") }, { id: ids[1], title: "Missing chat" }]);
    const storageReport = await api.inspectMaintenanceStorage();
    expect(storageReport.items).toContainEqual({ label: "state_5.sqlite", value: expect.stringContaining("Healthy") });
    expect(storageReport.items).toContainEqual({ label: "thread_history_5.sqlite", value: expect.stringContaining("Healthy") });
    expect(storageReport.storage?.buckets.some(bucket => bucket.label === "Databases" && bucket.bytes > 0)).toBe(true);
    expect(storageReport.storage?.totalBytes).toBeGreaterThan(0);
    expect((await api.inspectMaintenanceStorage("large-sessions")).items).toContainEqual({ label: "Large chat", value: "2 KB" });
    expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled();
  });
});
