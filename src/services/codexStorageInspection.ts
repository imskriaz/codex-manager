import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { createSharedInspection } from "../utils/concurrency";

export type NativeStorageInspection = {
  databases: Array<{ name: string; bytes: number; allocatedBytes: number; liveBytes: number; reusableBytes: number; walBytes: number; sharedMemoryBytes: number; status: string; error?: string }>;
  totalBytes: number; allocatedBytes: number; liveBytes: number; reusableBytes: number; walBytes: number; sharedMemoryBytes: number;
  complete: boolean;
};
let activeWorkers = 0;

/** Only the disposable read-only worker can block on SQLite, never the extension host. */
export function inspectNativeStorage(home: string, signal?: AbortSignal): Promise<NativeStorageInspection> {
  return createSharedInspection(`native-storage:${path.resolve(home)}`, workerSignal => new Promise((resolve, reject) => {
    if (activeWorkers >= 2) { reject(new Error("Storage inspection is busy. Other operations remain available; retry shortly.")); return; }
    const worker = new Worker(path.join(__dirname, "..", "..", "tools", "inspect-codex-storage.cjs"), { workerData: { home }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
    activeWorkers++;
    let latest: NativeStorageInspection | undefined, settled = false;
    const finish = (error?: Error, result?: NativeStorageInspection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      workerSignal.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("Storage inspection returned no results. No data was changed."));
    };
    const abort = () => finish(new Error("Storage inspection cancelled. No data was changed."));
    const timer = setTimeout(() => latest
      ? finish(undefined, { ...latest, complete: false })
      : finish(new Error("Storage inspection timed out. No data was changed; other operations remain available.")), 12_000);
    timer.unref?.();
    workerSignal.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: { type: string; report?: NativeStorageInspection; error?: string }) => {
      if (message.type === "progress") latest = message.report;
      else if (message.type === "completed") finish(undefined, message.report);
      else if (message.type === "failed") finish(new Error(message.error ?? "Storage inspection failed. No data was changed."));
    });
    worker.once("error", error => finish(error));
    worker.once("exit", () => { activeWorkers--; finish(new Error("Storage inspection ended before completion. No data was changed.")); });
    worker.unref();
    if (workerSignal.aborted) abort();
  }), signal, 15_000);
}
