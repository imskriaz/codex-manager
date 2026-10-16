import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SqliteStateStore } = require("../out/storage/sqliteState.js");
const { saveAccountIndex, readAccountIndex, readAccountRow } = require("../out/storage/sqliteAccounts.js");
const { initializeSessionStorage, saveSessionLive, readAccountSessionStats } = require("../out/storage/sqliteSessions.js");
const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-benchmark-"));
const stores = [];
const timed = task => { const start = performance.now(); task(); return +(performance.now() - start).toFixed(2); };
try {
  const store = await SqliteStateStore.open(path.join(root, "accounts.sqlite")); stores.push(store);
  saveAccountIndex(store, { accounts: Array.from({ length: 100 }, (_, n) => ({ id: String(n), email: `account-${n}@example.com`, createdAt: 1, updatedAt: 1 })) });
  const fullReadMs = timed(() => { for (let n = 0; n < 1000; n++) assert.equal(readAccountIndex(store).accounts.find(account => account.id === "50")?.id, "50"); });
  const indexedReadMs = timed(() => { for (let n = 0; n < 1000; n++) assert.equal(readAccountRow(store, "50", "home")?.id, "50"); });
  const writes = [];
  for (const batched of [false, true]) {
    const turns = await SqliteStateStore.open(path.join(root, `${batched ? "batched" : "individual"}.sqlite`)); stores.push(turns);
    initializeSessionStorage(turns);
    const states = Array.from({ length: 128 }, () => ({ sessionId: randomUUID(), streamId: randomUUID(), sequence: 1, updatedAt: Date.now(), status: "completed", messages: [], tokenUsage: { total: 10 } }));
    const milliseconds = timed(() => {
      if (batched) {
        for (let n = 0; n < states.length; n += 32) turns.transaction(() => { for (const state of states.slice(n, n + 32)) saveSessionLive(turns, root, state, "benchmark"); });
      } else for (const state of states) saveSessionLive(turns, root, state, "benchmark");
    });
    assert.deepEqual({ ...readAccountSessionStats(turns, "benchmark") }, { turns: 128, input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 1280 });
    assert.equal(turns.database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    writes.push({ batched, milliseconds, commits: batched ? 4 : 128 });
  }
  console.log(JSON.stringify({ accountLookups: 1000, accounts: 100, fullReadMs, indexedReadMs, writes, durability: "WAL + synchronous FULL for both write modes" }, null, 2));
} finally {
  for (const store of stores) store.close();
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "codex-manager-benchmark-"));
  await rm(root, { recursive: true, force: true });
}
