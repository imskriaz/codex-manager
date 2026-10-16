import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
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

async function children(kinds: string[], body: string): Promise<string[]> {
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
    await children(
      ["bulk", "bulk", "foreground"],
      `
      const record = phase => fs.appendFile(path.join(root, 'requests'), JSON.stringify({ phase, id, bulk: kind === 'bulk', at: Date.now() }) + '\\n');
      await coordinator.providerRequest(AbortSignal.timeout(10000), kind === 'bulk', async () => {
        await record('start'); await delay(800); await record('end');
      });
      console.log('done');
    `
    );
    const events = (await readFile(path.join(root, "requests"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { phase: string; id: string; bulk: boolean; at: number });
    const active = new Map<string, boolean>();
    let maximum = 0,
      bulkMaximum = 0;
    const starts: number[] = [];
    for (const event of events) {
      if (event.phase === "start") {
        active.set(event.id, event.bulk);
        starts.push(event.at);
      } else active.delete(event.id);
      maximum = Math.max(maximum, active.size);
      bulkMaximum = Math.max(bulkMaximum, [...active.values()].filter(Boolean).length);
    }
    expect(maximum).toBe(2);
    expect(bulkMaximum).toBe(1);
    expect(starts.every((at, index) => index === 0 || at - starts[index - 1]! >= 200)).toBe(true);
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
    store.transaction(() => {
      for (let i = 0; i < 128; i++)
        store.set("shared-reads", String(i), { id: String(i), completedAt: Date.now(), value: i });
    });
    const reader = new CrossWindowOperationCoordinator(root),
      signal = new AbortController().signal;
    await expect(reader.shareRead("overflow", "Read", async () => 1, signal, 0)).resolves.toBe(1);
    expect(store.keys("shared-reads")).toHaveLength(128);
    store.transaction(() => {
      for (const key of store.keys("shared-reads")) store.set("shared-reads", key, undefined);
    });
    const set = store.set.bind(store);
    const failure = vi.spyOn(store, "set").mockImplementation((namespace, key, value) => {
      if (namespace === "shared-reads") throw new Error("storage full");
      set(namespace, key, value);
    });
    await expect(reader.shareRead("storage", "Read", async () => 2, signal, 0)).resolves.toBe(2);
    failure.mockRestore();
    await expect(reader.shareRead("storage", "Read", async () => 3, signal, 0)).resolves.toBe(3);
  });

  it("canonicalizes compatible keys without exposing credentials", () => {
    const first = sharedResourceKey("request", { accessToken: "private-token", force: true });
    expect(first).toBe(sharedResourceKey("request", { force: true, accessToken: "private-token" }));
    expect(first).not.toContain("private-token");
  });
});
