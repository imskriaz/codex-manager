import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteStateStore } from '../src/storage/sqliteState';
import { peekManagerCacheId, readManagerCacheEntry, writeManagerCacheEntry, pruneManagerCache } from '../src/storage/managerCache';
import { removeTestDirectory } from './testFilesystem';

let root: string, store: SqliteStateStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'manager-cache-'));
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite'));
});
afterEach(async () => { vi.restoreAllMocks(); store.close(); await removeTestDirectory(root); });
const put = (key: string, value: unknown, at = Date.now()) => writeManagerCacheEntry(store, key, { id: key + ':' + at, completedAt: at, value });

it('reads one indexed entry, reuses concurrent results, and preserves explicit fresh reads', () => {
  const now = Date.now(); put('one', { count: 1 }, now);
  const seen = peekManagerCacheId(store, 'one');
  expect(readManagerCacheEntry(store, 'one', seen, now, 100, now)?.value).toEqual({ count: 1 });
  expect(readManagerCacheEntry(store, 'one', seen, now, 0, now)).toBeUndefined();
  expect(readManagerCacheEntry(store, 'one', undefined, now, 0, now)?.value).toEqual({ count: 1 });
  expect(readManagerCacheEntry(store, 'missing', undefined, now, 100, now)).toBeUndefined();
  const query = store.prepare('EXPLAIN QUERY PLAN SELECT id,created_at,data FROM manager_cache WHERE key=?').all('one');
  expect(query.some(row => String(row['detail']).includes('SEARCH manager_cache USING INDEX'))).toBe(true);
});

it('expires results, rejects future timestamps and survives reopen without loading the entire cache', async () => {
  const now = Date.now(); put('one', 42, now);
  store.close(); store = await SqliteStateStore.open(path.join(root, 'manager.sqlite'));
  expect(readManagerCacheEntry(store, 'one', undefined, now, 100, now)?.value).toBe(42);
  expect(readManagerCacheEntry(store, 'one', undefined, now, 100, now - 1)).toBeUndefined();
  expect(readManagerCacheEntry(store, 'one', undefined, now, 120_000, now + 60_000)).toBeUndefined();
  pruneManagerCache(store, now + 60_000);
  expect(peekManagerCacheId(store, 'one')).toBeUndefined();
});

it('treats corrupt JSON and mismatched payload sizes as misses and retains valid empty results', () => {
  const now = Date.now(); put('one', 1, now);
  for (const data of ['{', 'null', '[]']) {
    store.prepare('UPDATE manager_cache SET data=?,byte_size=? WHERE key=?').run(data, Buffer.byteLength(data), 'one');
    expect(readManagerCacheEntry(store, 'one', undefined, now, 100, now)).toBeUndefined();
  }
  store.prepare('UPDATE manager_cache SET data=?,byte_size=1 WHERE key=?').run('{"value":42}', 'one');
  expect(readManagerCacheEntry(store, 'one', undefined, now, 100, now)).toBeUndefined();
  for (const value of [undefined, null, false, 0, '']) {
    put('one', value, now);
    expect(readManagerCacheEntry(store, 'one', undefined, now, 100, now)).toEqual({ id: 'one:' + now, completedAt: now, value });
  }
});

it('bounds entry count with equal timestamps and evicts metadata without bulk payload deserialization', () => {
  const now = Date.now();
  for (let n = 0; n < 129; n++) put(String(n), n, now);
  expect(Number(store.prepare('SELECT COUNT(*) AS n FROM manager_cache').get()?.['n'])).toBe(128);
  expect(readManagerCacheEntry(store, '128', undefined, now, 100, now)?.value).toBe(128);
  const prepare = vi.spyOn(store, 'prepare');
  pruneManagerCache(store, now);
  expect(prepare.mock.calls.every(([sql]) => !/SELECT[^;]*\bdata\b/i.test(sql))).toBe(true);
});

it('caps total serialized bytes, skips oversized entries, and removes their older cached result', () => {
  const now = Date.now(), large = 'é'.repeat(512 * 1024);
  for (let n = 0; n < 20; n++) put(String(n), large, now);
  expect(Number(store.prepare('SELECT SUM(byte_size) AS bytes FROM manager_cache').get()?.['bytes'])).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(peekManagerCacheId(store, '19')).toBeDefined();
  put('19', large + large, now);
  expect(peekManagerCacheId(store, '19')).toBeUndefined();
});

it('keeps settings, pending recovery, drafts, and authorization markers when all cache rows expire', () => {
  const now = Date.now();
  for (const namespace of ['settings:local', 'global', 'project-drafts', 'once-operations']) store.set(namespace, 'keep', { value: 'durable' });
  put('expired', 'expendable', now);
  pruneManagerCache(store, now + 60_000);
  for (const namespace of ['settings:local', 'global', 'project-drafts', 'once-operations']) expect(store.get(namespace, 'keep')).toEqual({ value: 'durable' });
  expect(store.prepare('SELECT COUNT(*) AS n FROM manager_cache').get()?.['n']).toBe(0);
});
