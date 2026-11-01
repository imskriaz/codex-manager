import { afterEach, expect, it, vi } from 'vitest';

// A bounded IndexedDB fixture with controllable reads and failed writes.
async function fixture() {
  vi.resetModules();
  const records = new Map<string, { key: string; value: unknown; updatedAt: number }>();
  const reads: Array<() => void> = [];
  let held = false, writes = 0, fail = false;
  const database = {
    close() {},
    transaction(_store: string, mode: string) {
      const tx = { oncomplete: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined,
        abort() { queueMicrotask(() => tx.onabort?.()); },
        objectStore() { return {
          get(key: string) {
            const result = structuredClone(records.get(key));
            const request = { result, onsuccess: undefined as (() => void) | undefined };
            const finish = () => request.onsuccess?.();
            if (held) reads.push(finish); else queueMicrotask(finish);
            return request;
          },
          put(record: { key: string; value: unknown; updatedAt: number }) {
            writes++; if (fail) throw new DOMException('Storage full', 'QuotaExceededError');
            records.set(record.key, structuredClone(record));
          },
          delete(key: string) { records.delete(key); },
          openCursor() {
            const entries = [...records.entries()]; let index = 0;
            const request = { result: undefined as unknown, onsuccess: undefined as (() => void) | undefined };
            const advance = () => {
              const entry = entries[index++];
              request.result = entry ? { value: entry[1], continue: () => queueMicrotask(advance), delete: () => records.delete(entry[0]) } : undefined;
              request.onsuccess?.(); if (!entry) queueMicrotask(() => fail ? tx.onabort?.() : tx.oncomplete?.());
            };
            queueMicrotask(advance); return request;
          }
        }; }
      };
      if (mode === 'readwrite') setTimeout(() => fail ? tx.onabort?.() : tx.oncomplete?.(), 0);
      return tx;
    }
  };
  vi.stubGlobal('indexedDB', { open() { const request = { result: database, onsuccess: undefined as (() => void) | undefined }; queueMicrotask(() => request.onsuccess?.()); return request; } });
  const cache = await import('../webview-src/dashboard/cliSessionCache');
  return { ...cache, records, reads, hold: () => { held = true; }, fail: () => { fail = true; }, writes: () => writes };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('reuses unchanged browser views and writes only changed entries', async () => {
  const cache = await fixture();
  expect(await cache.writeBrowserCache('board:pc:project', { rows: [1] })).toBe(true);
  const first = cache.writes();
  expect(await cache.writeBrowserCache('board:pc:project', { rows: [1] })).toBe(true);
  expect(cache.writes()).toBe(first);
  expect(await cache.writeBrowserCache('board:pc:project', { rows: [2] })).toBe(true);
  expect(cache.writes()).toBe(first + 1);
  const view = await cache.readBrowserCache<{ rows: number[] }>('board:pc:project');
  view!.rows.push(3);
  expect(await cache.readBrowserCache('board:pc:project')).toEqual({ rows: [2] });
  expect(await cache.readBrowserCache('board:other:project')).toBeUndefined();
});
it('coalesces disk reads and fences a late cached result after a fresh write or deletion', async () => {
  const cache = await fixture();
  cache.records.set('browser:files', { key: 'browser:files', value: ['old'], updatedAt: Date.now() });
  cache.hold();
  const first = cache.readBrowserCache('files'), second = cache.readBrowserCache('files');
  await vi.waitFor(() => expect(cache.reads).toHaveLength(1));
  await cache.writeBrowserCache('files', ['new']);
  cache.reads.shift()!();
  expect(await first).toEqual(['new']); expect(await second).toEqual(['new']);
  cache.records.set('browser:deleted', { key: 'browser:deleted', value: ['old'], updatedAt: Date.now() });
  const deleted = cache.readBrowserCache('deleted');
  await vi.waitFor(() => expect(cache.reads).toHaveLength(1));
  await cache.deleteBrowserCache('deleted'); cache.reads.shift()!();
  expect(await deleted).toBeUndefined();
});
it('keeps read-only views usable after storage failure without acknowledging unsaved outbox work', async () => {
  const cache = await fixture(); cache.fail();
  expect(await cache.writeBrowserCache('files', ['visible'])).toBe(false);
  expect(await cache.readBrowserCache('files')).toEqual(['visible']);
  expect(await cache.writeBrowserCache('outbox:pc:task', { draft: 'retain' })).toBe(false);
  expect(await cache.readBrowserCache('outbox:pc:task')).toBeUndefined();
});
it('bounds memory and rejects expired/future disk entries', async () => {
  const cache = await fixture();
  for (let index = 0; index < 45; index++) await cache.writeBrowserCache(`entry:${index}`, index);
  cache.records.delete('browser:entry:0');
  expect(await cache.readBrowserCache('entry:0')).toBeUndefined();
  expect(await cache.readBrowserCache('entry:44')).toBe(44);
  cache.records.set('browser:future', { key: 'browser:future', value: 'bad', updatedAt: Date.now() + 60_000 });
  cache.records.set('browser:expired', { key: 'browser:expired', value: 'bad', updatedAt: 1 });
  expect(await cache.readBrowserCache('future')).toBeUndefined();
  expect(await cache.readBrowserCache('expired')).toBeUndefined();
});
