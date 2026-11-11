import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, access, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import {
  CrossWindowOperationCoordinator,
  configureCrossWindowOperationCoordinator,
  runCrossWindowSharedRead,
  runCrossWindowOnce,
  sharedResourceKey
} from "../src/utils/crossWindowOperations";
import { removeTestDirectory } from "./testFilesystem";
import { writeManagerCacheEntry } from '../src/storage/managerCache';

let root: string;
let store: SqliteStateStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "manager-shared-operations-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
  await configureCrossWindowOperationCoordinator(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  configureSqliteStateStore(undefined);
  store.close();
  await removeTestDirectory(root);
});

async function children(kinds: string[], body: string, control?: () => Promise<void>): Promise<string[]> {
  const modulePath = path.resolve(__dirname, "../out/utils/crossWindowOperations.js");
  const script = `
    const fs = require('node:fs/promises'), path = require('node:path');
    const [root, id, modulePath, kind] = process.argv.slice(1);
    const { CrossWindowOperationCoordinator } = require(modulePath);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    (async () => {
      const coordinator = new CrossWindowOperationCoordinator(root);
      await coordinator.initialize();
      await fs.writeFile(path.join(root, 'ready-' + id), 'ready');
      while (!(await fs.access(path.join(root, 'start')).then(() => true, () => false))) await delay(10);
      ${body}
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  const pending = kinds.map((kind, index) =>
    promisify(execFile)(process.execPath, ["-e", script, root, String(index), modulePath, kind], {
      timeout: 15_000,
      windowsHide: true
    })
  );
  let barrierError: unknown;
  try {
    await vi.waitFor(
      async () => {
        for (let i = 0; i < kinds.length; i++) await access(path.join(root, `ready-${i}`));
      },
      { timeout: 10_000 }
    );
  } catch (error) {
    barrierError = error;
  } finally {
    await writeFile(path.join(root, "start"), "start");
  }
  try { if (!barrierError) await control?.(); }
  catch (error) { barrierError = error; }
  const results = await Promise.allSettled(pending);
  if (barrierError) throw barrierError;
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value.stdout.trim();
  });
}

describe("shared operations across extension hosts", () => {
  it("runs one compatible read across separate Node processes", async () => {
    const values = await children(
      ["read", "read"],
      `
      const result = await coordinator.shareRead('same-read', 'Snapshot', async () => {
        await fs.appendFile(path.join(root, 'read-calls'), 'x');
        await delay(200);
        return { value: 42 };
      }, AbortSignal.timeout(5000), 0);
      console.log(JSON.stringify(result));
    `
    );
    expect(values.map((value) => JSON.parse(value))).toEqual([{ value: 42 }, { value: 42 }]);
    expect(await readFile(path.join(root, "read-calls"), "utf8")).toBe("x");
  });

  it("shares the two provider slots and reserves foreground capacity across processes", async () => {
    // Record admissions inside their transaction; task callbacks may be descheduled after admission.
    store.database.exec(`
      CREATE TABLE test_provider_admissions (
        sequence INTEGER PRIMARY KEY, admittedAt INTEGER NOT NULL, nextAt INTEGER NOT NULL,
        slots INTEGER NOT NULL, bulkSlots INTEGER NOT NULL
      );
      CREATE TRIGGER test_provider_insert AFTER INSERT ON state
      WHEN NEW.namespace = 'provider-budget' AND NEW.key = 'timing'
      BEGIN
        INSERT INTO test_provider_admissions (admittedAt, nextAt, slots, bulkSlots)
        SELECT json_extract(NEW.value, '$.observedAt'), json_extract(NEW.value, '$.nextAt'),
          count(*), coalesce(sum(json_extract(value, '$.background') = 1), 0)
        FROM state WHERE namespace = 'provider-budget' AND key IN ('0', '1');
      END;
      CREATE TRIGGER test_provider_update AFTER UPDATE ON state
      WHEN NEW.namespace = 'provider-budget' AND NEW.key = 'timing'
      BEGIN
        INSERT INTO test_provider_admissions (admittedAt, nextAt, slots, bulkSlots)
        SELECT json_extract(NEW.value, '$.observedAt'), json_extract(NEW.value, '$.nextAt'),
          count(*), coalesce(sum(json_extract(value, '$.background') = 1), 0)
        FROM state WHERE namespace = 'provider-budget' AND key IN ('0', '1');
      END;
    `);
    await children(
      ["bulk", "bulk", "foreground"],
      `
      await coordinator.providerRequest(AbortSignal.timeout(10000), kind === 'bulk', async () => {
        await fs.writeFile(path.join(root, 'request-start-' + id), kind);
        while (!(await fs.access(path.join(root, 'release-requests')).then(() => true, () => false))) await delay(10);
      });
      console.log('done');
    `,
      async () => {
        try {
          await vi.waitFor(async () => {
            const started = (await readdir(root)).filter(name => name.startsWith('request-start-'));
            expect(started).toHaveLength(2);
          }, { timeout: 5_000 });
          const started = (await readdir(root)).filter(name => name.startsWith('request-start-'));
          expect((await Promise.all(started.map(name => readFile(path.join(root, name), 'utf8')))).sort())
            .toEqual(['bulk', 'foreground']);
          expect(store.prepare('SELECT count(*) AS n FROM test_provider_admissions').get()?.['n']).toBe(2);
        } finally {
          await writeFile(path.join(root, 'release-requests'), 'release');
        }
      }
    );
    const admissions = store.prepare('SELECT admittedAt, nextAt, slots, bulkSlots FROM test_provider_admissions ORDER BY sequence').all() as Array<{ admittedAt: number; nextAt: number; slots: number; bulkSlots: number }>;
    expect(admissions).toHaveLength(3);
    expect(Math.max(...admissions.map(row => row.slots))).toBe(2);
    expect(Math.max(...admissions.map(row => row.bulkSlots))).toBe(1);
    expect(admissions.every((row, index) => row.nextAt - row.admittedAt === 250 &&
      (index === 0 || row.admittedAt >= admissions[index - 1]!.nextAt))).toBe(true);
    expect(store.get("provider-budget", "0")).toBeUndefined();
    expect(store.get("provider-budget", "1")).toBeUndefined();
  });

  it("shares cooldown, cancels queued work, and retries after recovery", async () => {
    const first = new CrossWindowOperationCoordinator(root),
      second = new CrossWindowOperationCoordinator(root);
    await first.noteProviderCooldown(Date.now() + 250);
    const task = vi.fn(async () => "ready");
    await expect(second.providerRequest(AbortSignal.timeout(50), false, task)).rejects.toThrow();
    expect(task).not.toHaveBeenCalled();
    await expect(second.providerRequest(AbortSignal.timeout(2000), false, task)).resolves.toBe("ready");
    expect(task).toHaveBeenCalledOnce();
  });

  it("recovers expired provider slots and a backwards clock without stealing writer leases", async () => {
    store.set("provider-budget", "0", {
      pid: process.pid,
      token: "expired",
      startedAt: Date.now() - 60_000,
      heartbeatAt: Date.now() - 60_000
    });
    store.set("provider-budget", "timing", {
      nextAt: Date.now() + 3_600_000,
      cooldownUntil: Date.now() + 3_600_000,
      observedAt: Date.now() + 3_600_000
    });
    await expect(
      new CrossWindowOperationCoordinator(root).providerRequest(
        AbortSignal.timeout(1000),
        false,
        async () => "recovered"
      )
    ).resolves.toBe("recovered");
    expect(store.get("provider-budget", "0")).toBeUndefined();
  });

  it("keeps cancellation local to a read consumer and starts no work for an already cancelled caller", async () => {
    let finish!: (value: number) => void;
    const inspect = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        })
    );
    const controller = new AbortController();
    const first = runCrossWindowSharedRead("consumer-read", "Read", inspect, { signal: controller.signal });
    const checked = expect(first).rejects.toThrow();
    const second = runCrossWindowSharedRead("consumer-read", "Read", inspect);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    controller.abort();
    await checked;
    finish(42);
    await expect(second).resolves.toBe(42);
    await expect(
      runCrossWindowSharedRead("cancelled-read", "Read", inspect, { signal: controller.signal })
    ).rejects.toThrow();
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("does not reuse a completed forced read or cache a failed read", async () => {
    const reader = new CrossWindowOperationCoordinator(root);
    const signal = new AbortController().signal;
    await expect(reader.shareRead("fresh", "Read", async () => 1, signal, 0)).resolves.toBe(1);
    await expect(reader.shareRead("fresh", "Read", async () => 2, signal, 0)).resolves.toBe(2);
    await expect(
      reader.shareRead(
        "failed",
        "Read",
        async () => {
          throw new Error("offline");
        },
        signal,
        0
      )
    ).rejects.toThrow("offline");
    await expect(reader.shareRead("failed", "Read", async () => "reconnected", signal, 0)).resolves.toBe("reconnected");
  });

  it("retains single-use protection after another host or a restarted host retries", async () => {
    const task = vi.fn(async () => "authorized");
    await expect(runCrossWindowOnce("oauth-once", "OAuth", task)).resolves.toBe("authorized");
    await expect(runCrossWindowOnce("oauth-once", "OAuth", task)).resolves.toBe("authorized");
    expect(task).toHaveBeenCalledOnce();
    await expect(new CrossWindowOperationCoordinator(root).once("oauth-once", "OAuth", task)).rejects.toThrow(
      "already attempted"
    );
    expect(task).toHaveBeenCalledOnce();
  });

  it("evicts a full read cache and preserves a completed response after cache storage fails", async () => {
    for (let i = 0; i < 128; i++)
      writeManagerCacheEntry(store, String(i), { id: String(i), completedAt: Date.now(), value: i });
    const reader = new CrossWindowOperationCoordinator(root),
      signal = new AbortController().signal;
    await expect(reader.shareRead("overflow", "Read", async () => 1, signal, 0)).resolves.toBe(1);
    expect(store.prepare('SELECT COUNT(*) AS n FROM manager_cache').get()?.['n']).toBe(128);
    const prepare = store.prepare.bind(store);
    const failure = vi.spyOn(store, "prepare").mockImplementation(sql => {
      if (sql.startsWith("INSERT INTO manager_cache")) throw new Error("storage full");
      return prepare(sql);
    });
    await expect(reader.shareRead("storage", "Read", async () => 2, signal, 0)).resolves.toBe(2);
    failure.mockRestore();
    await expect(reader.shareRead("storage", "Read", async () => 3, signal, 0)).resolves.toBe(3);
  });

  it('returns fresh source data when cache reads fail and retries caching on a later operation', async () => {
    const prepare = store.prepare.bind(store), reader = new CrossWindowOperationCoordinator(root);
    const failure = vi.spyOn(store, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('SELECT id FROM manager_cache')) throw new Error('cache unavailable');
      return prepare(sql);
    });
    const source = vi.fn(async () => 42), signal = new AbortController().signal;
    await expect(reader.shareRead('cache-failure', 'Read', source, signal, 1000)).resolves.toBe(42);
    failure.mockRestore();
    await expect(reader.shareRead('cache-failure', 'Read', source, signal, 1000)).resolves.toBe(42);
    await expect(reader.shareRead('cache-failure', 'Read', source, signal, 1000)).resolves.toBe(42);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('does not store a cancelled read or fail a successful oversized source response', async () => {
    const reader = new CrossWindowOperationCoordinator(root), controller = new AbortController();
    await expect(reader.shareRead('cancel-cache', 'Read', async () => { controller.abort(); return 1; }, controller.signal, 1000)).rejects.toThrow();
    const large = 'x'.repeat(2 * 1024 * 1024), source = vi.fn(async () => large);
    await expect(reader.shareRead('large-cache', 'Read', source, new AbortController().signal, 1000)).resolves.toBe(large);
    await expect(reader.shareRead('large-cache', 'Read', source, new AbortController().signal, 1000)).resolves.toBe(large);
    expect(source).toHaveBeenCalledTimes(2);
    expect(store.prepare('SELECT COUNT(*) AS n FROM manager_cache').get()?.['n']).toBe(0);
  });

  it('uses source data when the optional cache schema cannot be initialized', async () => {
    const exec = store.database.exec.bind(store.database);
    vi.spyOn(store.database, 'exec').mockImplementation(sql => {
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS manager_cache')) throw new Error('cache schema unavailable');
      exec(sql);
    });
    await expect(new CrossWindowOperationCoordinator(root).shareRead('schema-failure', 'Read', async () => 42, new AbortController().signal, 1000)).resolves.toBe(42);
  });

  it("canonicalizes compatible keys without exposing credentials", () => {
    const first = sharedResourceKey("request", { accessToken: "private-token", force: true });
    expect(first).toBe(sharedResourceKey("request", { force: true, accessToken: "private-token" }));
    expect(first).not.toContain("private-token");
  });
});
