import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { inspectNativeStorage } from "../src/services/codexStorageInspection";
import { removeTestDirectory } from "./testFilesystem";

vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return { ...actual, Worker: vi.fn(function (...args: ConstructorParameters<typeof actual.Worker>) { return new actual.Worker(...args); }) };
});
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "codex-storage-inspect-")); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await removeTestDirectory(directory); });

it("reads all versioned native databases, reusable pages and sidecars without changing data or blocking the event loop", async () => {
  const file = path.join(directory, "thread_history_1.sqlite");
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE history(data BLOB); INSERT INTO history VALUES(zeroblob(2097152)); DELETE FROM history");
  database.close();
  const queue = new DatabaseSync(path.join(directory, "queue_1.sqlite"));
  queue.exec("PRAGMA journal_mode=WAL; CREATE TABLE queued(id TEXT); INSERT INTO queued VALUES('retained')");
  const before = await readFile(file);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const result = await inspectNativeStorage(directory);
    expect(ticks).toBeGreaterThan(0);
    expect(result.complete).toBe(true);
    expect(result.databases.map(row => row.name)).toEqual(["queue_1.sqlite", "thread_history_1.sqlite"]);
    expect(result.reusableBytes).toBeGreaterThan(1024 * 1024);
    expect(result.liveBytes + result.reusableBytes).toBe(result.allocatedBytes);
    expect(result.walBytes).toBeGreaterThan(0);
    expect(result.sharedMemoryBytes).toBeGreaterThan(0);
    expect(result.totalBytes).toBe(result.databases.reduce((sum, row) => sum + row.bytes + row.walBytes + row.sharedMemoryBytes, 0));
    expect(await readFile(file)).toEqual(before);
    expect(queue.prepare("SELECT id FROM queued").get()?.id).toBe("retained");
  } finally { clearInterval(timer); queue.close(); }
});

it("reports corrupt files as partial while retaining healthy and empty inventories", async () => {
  expect(await inspectNativeStorage(directory)).toMatchObject({ complete: true, totalBytes: 0, databases: [] });
  await writeFile(path.join(directory, "memories_1.sqlite"), "corrupt");
  const healthy = new DatabaseSync(path.join(directory, "state_1.sqlite")); healthy.exec("CREATE TABLE retained(id TEXT)"); healthy.close();
  const result = await inspectNativeStorage(directory);
  expect(result).toMatchObject({ complete: false, databases: [{ name: "memories_1.sqlite", status: "Unavailable", error: expect.any(String) }, { name: "state_1.sqlite", status: "Healthy" }] });
  expect(await readFile(path.join(directory, "memories_1.sqlite"), "utf8")).toBe("corrupt");
  await expect(inspectNativeStorage(path.join(directory, "missing"))).rejects.toThrow();
});

it("bounds stalled workers, returns partial results, and leaves a second consumer running when one cancels", async () => {
  vi.useFakeTimers();
  const workers: Array<EventEmitter & { terminate: ReturnType<typeof vi.fn>; unref: () => void }> = [];
  const constructor = vi.mocked(Worker).mockImplementation((function () {
    const worker = Object.assign(new EventEmitter(), { unref: () => undefined, terminate: vi.fn(async () => { worker.emit("exit", 0); return 0; }) });
    workers.push(worker); return worker;
  }) as never);
  try {
    const controller = new AbortController();
    const first = inspectNativeStorage(directory, controller.signal), second = inspectNativeStorage(directory);
    const cancelled = expect(first).rejects.toThrow(/cancelled|aborted/i);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers).toHaveLength(1);
    controller.abort(); await cancelled;
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    const partial = { databases: [], totalBytes: 10, complete: true };
    workers[0]!.emit("message", { type: "progress", report: partial });
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(second).resolves.toMatchObject({ totalBytes: 10, complete: false });
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();

    const held = inspectNativeStorage(directory), other = inspectNativeStorage(directory + "-other");
    const heldFailure = expect(held).rejects.toThrow(/timed out/i), otherFailure = expect(other).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1);
    await expect(inspectNativeStorage(directory + "-third")).rejects.toThrow(/busy/i);
    await vi.advanceTimersByTimeAsync(12_000); await heldFailure; await otherFailure;
    const crashed = inspectNativeStorage(directory);
    const crashFailure = expect(crashed).rejects.toThrow(/before completion/i);
    await vi.advanceTimersByTimeAsync(1);
    workers.at(-1)!.emit("exit", 1);
    await crashFailure;
  } finally { constructor.mockRestore(); }
});
