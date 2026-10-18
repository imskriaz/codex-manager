import { Worker } from "node:worker_threads";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logRetentionCutoff, managerLogCleanupStatements } from "./logRetention";

const active = new Map<string, { work: Promise<"completed" | "deferred">; policy?: string }>();

export async function waitForManagerDatabaseMaintenance(file: string): Promise<void> {
  await active.get(path.resolve(file))?.work.catch(() => undefined);
}

/** SQLite owns its files throughout compaction; never replace a live database or its WAL. */
export function compactManagerDatabase(file: string, logRetention?: { days: number; now: Date }): Promise<"completed" | "deferred"> {
  const target = path.resolve(file);
  if (!["manager.sqlite", "manager_logs.sqlite"].includes(path.basename(target))) return Promise.reject(new Error("Only Manager databases can be compacted."));
  if (logRetention && path.basename(target) !== "manager_logs.sqlite") return Promise.reject(new Error("Diagnostic retention only applies to Manager logs."));
  const policy = logRetention ? logRetentionCutoff(logRetention.days, logRetention.now) : undefined;
  const pending = active.get(target);
  if (pending) return policy && pending.policy !== policy ? Promise.resolve("deferred") : pending.work;
  let started = false;
  const work = (async () => {
    const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info || !info.isFile() || info.isSymbolicLink()) return "deferred" as const;
    return new Promise<"completed" | "deferred">((resolve, reject) => {
      const worker = new Worker(`
        const {parentPort,workerData}=require('node:worker_threads');
        let db,result;
        try {
          const {DatabaseSync}=require('node:sqlite');
          db=new DatabaseSync(workerData.file);
          db.exec('PRAGMA busy_timeout=0; PRAGMA cache_size=-1024; PRAGMA temp_store=FILE');
          db.exec('BEGIN IMMEDIATE; ROLLBACK');
          if(workerData.cleanup.length) {
            db.exec('BEGIN IMMEDIATE');
            try { for(const {sql,params} of workerData.cleanup) db.prepare(sql).run(...params); db.exec('COMMIT'); }
            catch(error) { try{db.exec('ROLLBACK');}catch{} throw error; }
          }
          const n=name=>Number(Object.values(db.prepare('PRAGMA '+name).get())[0]);
          const pages=n('page_count'), free=n('freelist_count'), bytes=n('page_size');
          if (n('auto_vacuum')===2) db.exec('PRAGMA incremental_vacuum(128)');
          else if (free*bytes>=2097152 && free>=pages/5 && (pages-free)*bytes<=67108864) {
            db.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM');
          }
          db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA shrink_memory');
          result={status:'completed'};
        } catch(error) {
          if (/busy|locked/i.test(error.message)) result={status:'deferred'};
          else result={error:error.message};
        } finally { if(db) db.close(); parentPort.postMessage(result); }
      `, { eval: true, workerData: { file: target, cleanup: logRetention ? managerLogCleanupStatements(logRetention.days, logRetention.now) : [] }, resourceLimits: { maxOldGenerationSizeMb: 16 } });
      started = true;
      // A slow or busy disk is retried by the next maintenance pass.
      const timeout = setTimeout(() => { void worker.terminate(); resolve("deferred"); }, logRetention ? 20_000 : 5_000);
      timeout.unref?.();
      worker.once("message", (result: { status?: "completed" | "deferred"; error?: string }) => {
        clearTimeout(timeout);
        if (result.error) reject(new Error(result.error)); else resolve(result.status ?? "deferred");
      });
      worker.once("error", reject);
      worker.once("exit", () => { clearTimeout(timeout); active.delete(target); resolve("deferred"); });
      worker.unref();
    });
  })();
  active.set(target, { work, policy });
  void work.catch(() => undefined).finally(() => { if (!started && active.get(target)?.work === work) active.delete(target); });
  return work;
}
