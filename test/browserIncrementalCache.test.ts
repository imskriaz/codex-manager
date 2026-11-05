import { afterEach, expect, it, vi } from 'vitest';

// A bounded IndexedDB fixture with controllable reads and failed writes.
async function fixture() {
  vi.resetModules();
  const records = new Map<string, { key: string; value: unknown; updatedAt: number }>();
  const reads: Array<() => void> = [];
  let held = false, writes = 0, fail = false;
  let transactionError: string | undefined, failuresLeft = 0, openMode = 'success';
  const connections: Array<{ close(): void; onclose?: () => void; onversionchange?: () => void }> = [];
  const opens: Array<{ result: unknown; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void }> = [];
  const database = {
    transaction(_store: string, mode: string) {
      if (failuresLeft-- > 0) throw new DOMException('Transaction unavailable', transactionError);
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
  vi.stubGlobal('IDBKeyRange', { bound: () => ({}) });
  vi.stubGlobal('indexedDB', { open() {
    if (openMode === 'throw') throw new DOMException('Unavailable', 'SecurityError');
    let closed = false;
    const connection = { ...database, onclose: undefined as (() => void) | undefined, onversionchange: undefined as (() => void) | undefined,
      close() { closed = true; },
      transaction(store: string, mode: string) { if (closed) throw new DOMException('The database connection is closing', 'InvalidStateError'); return database.transaction(store, mode); }
    };
    connections.push(connection);
    const request = { result: connection, onsuccess: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined, onblocked: undefined as (() => void) | undefined };
    opens.push(request);
    const mode = openMode;
    queueMicrotask(() => { if (mode === 'success') request.onsuccess?.(); else if (mode === 'error') request.onerror?.(); else if (mode === 'blocked') request.onblocked?.(); });
    return request;
  } });
  const cache = await import('../webview-src/dashboard/cliSessionCache');
  return { ...cache, records, reads, connections, opens,
    close: (notify = true) => { const connection = connections.at(-1)!; connection.close(); if (notify) connection.onclose?.(); },
    failTransactions: (name: string, count = 1) => { transactionError = name; failuresLeft = count; },
    opening: (mode: string) => { openMode = mode; },
    hold: () => { held = true; }, fail: () => { fail = true; }, writes: () => writes };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

it('persists large document queues and task outboxes without evicting either', async () => {
  const cache = await fixture(), data = 'A'.repeat(3 * 1024 * 1024);
  expect(await cache.writeBrowserCache('message-queue:large', { data })).toBe(true);
  expect(await cache.writeBrowserCache('outbox:large', { data })).toBe(true);
  expect(await cache.readBrowserCache('message-queue:large')).toEqual({ data });
  expect(cache.records.has('browser:outbox:large')).toBe(true);
});
it('refuses to replace unreadable or future-dated durable queues with an empty queue', async () => {
  const cache = await fixture();
  cache.records.set('browser:message-queue:future', { key: 'browser:message-queue:future', updatedAt: Date.now()+60000, value: [{ id: 'saved' }] });
  await expect(cache.readBrowserCache('message-queue:future')).rejects.toThrow('timing is invalid');
  expect(cache.records.get('browser:message-queue:future')?.value).toEqual([{ id: 'saved' }]);
  vi.resetModules(); vi.stubGlobal('indexedDB', { open() { throw new Error('Unavailable'); } });
  const unavailable = await import('../webview-src/dashboard/cliSessionCache');
  await expect(unavailable.readBrowserCache('message-queue:unavailable')).rejects.toThrow('storage is unavailable');
});

it('deletes empty queues directly and recovers capacity consumed by legacy empty records',async()=>{
  const cache=await fixture();
  for(let i=0;i<101;i++)cache.records.set(`browser:message-queue:empty-${i}`,{key:`browser:message-queue:empty-${i}`,value:[],updatedAt:Date.now()});
  expect(await cache.writeBrowserCache('message-queue:new',[{id:'keep'}])).toBe(true);
  expect([...cache.records.keys()].filter(key=>key.startsWith('browser:message-queue:empty-'))).toHaveLength(0);
  const writes=cache.writes();expect(await cache.writeBrowserCache('message-queue:new',[])).toBe(true);
  expect(cache.records.has('browser:message-queue:new')).toBe(false);expect(cache.writes()).toBe(writes);
});

it.each([false, true])('reopens a closed connection (close event: %s) and preserves the durable queue', async notify => {
  const cache = await fixture(), key = 'message-queue:pc:session', value = [{ id: 'keep', state: 'sending' }];
  expect(await cache.writeBrowserCache(key, value)).toBe(true);
  cache.close(notify);
  expect(await cache.readBrowserCache(key)).toEqual(value);
  expect(cache.connections).toHaveLength(2);
  expect(await cache.writeBrowserCache(key, [{ id: 'later' }])).toBe(true);
  expect(await cache.deleteBrowserCache(key)).toBe(true);
  expect(cache.records.has(`browser:${key}`)).toBe(false);
});

it('reopens the shared connection for drafts, cache writes, outbox reads and deletion', async () => {
  const cache = await fixture();
  const operations = [
    () => cache.writeBrowserCache('message-queue:one', [{ id: 'keep' }]),
    () => cache.writeCliComposerDraft('draft', { text: 'Keep this', attachments: [] }),
    () => cache.writeCliSessionMessagesCache('session', []),
    () => cache.invalidateCliSessionCache('session'),
    () => cache.listBrowserOutbox(),
    () => cache.deleteBrowserCache('message-queue:one')
  ];
  await cache.writeBrowserCache('prime', []);
  for (const operation of operations) {
    cache.close(false);
    const count = cache.connections.length;
    await operation();
    expect(cache.connections).toHaveLength(count + 1);
  }
  expect(await cache.readCliComposerDraft('draft')).toEqual({ text: 'Keep this', attachments: [] });
});

it('reads queues from disk across ownership changes and never acknowledges a failed queue write from memory', async () => {
  const cache = await fixture(), key = 'message-queue:one';
  expect(await cache.writeBrowserCache(key, [{ id: 'old' }])).toBe(true);
  cache.records.set(`browser:${key}`, { key: `browser:${key}`, value: [{ id: 'other-tab' }], updatedAt: Date.now() });
  expect(await cache.readBrowserCache(key)).toEqual([{ id: 'other-tab' }]);
  cache.fail();
  expect(await cache.writeBrowserCache(key, [{ id: 'unsaved' }])).toBe(false);
  expect(await cache.writeBrowserCache(key, [{ id: 'old' }])).toBe(false);
  expect(await cache.readBrowserCache(key)).toEqual([{ id: 'other-tab' }]);
});

it('bounds repeated closing failures and lets a later retry recover without overwriting saved work', async () => {
  const cache = await fixture(), key = 'message-queue:one';
  await cache.writeBrowserCache(key, [{ id: 'keep' }]);
  cache.failTransactions('InvalidStateError', 2);
  await expect(cache.readBrowserCache(key)).rejects.toThrow('storage is unavailable');
  expect(cache.connections).toHaveLength(2);
  expect(await cache.readBrowserCache(key)).toEqual([{ id: 'keep' }]);
  expect(cache.connections).toHaveLength(3);
});

it('does not replay transactions for permission errors or failed writes', async () => {
  const cache = await fixture();
  await cache.writeBrowserCache('prime', []);
  cache.failTransactions('SecurityError');
  await expect(cache.readBrowserCache('message-queue:one')).rejects.toThrow('storage is unavailable');
  cache.fail();
  expect(await cache.writeBrowserCache('message-queue:one', [{ id: 'keep' }])).toBe(false);
  expect(cache.connections).toHaveLength(1);
});

it.each(['throw', 'error', 'blocked', 'stalled'])('recovers after an unavailable database open (%s)', async mode => {
  const cache = await fixture();
  vi.useFakeTimers(); cache.opening(mode);
  const failed = expect(cache.readBrowserCache('message-queue:one')).rejects.toThrow('storage is unavailable');
  await vi.advanceTimersByTimeAsync(2000); await failed;
  const old = cache.connections.at(-1);
  cache.opening('success');
  expect(await cache.readBrowserCache('message-queue:one')).toBeUndefined();
  const count = cache.connections.length;
  if (mode === 'stalled') cache.opens[0].onsuccess?.();
  old?.onclose?.(); old?.onversionchange?.();
  expect(await cache.readBrowserCache('message-queue:one')).toBeUndefined();
  expect(cache.connections).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores close and version-change events from an obsolete connection', async () => {
  const cache = await fixture();
  await cache.readBrowserCache('message-queue:one');
  const old = cache.connections[0];
  cache.close(false);
  await cache.readBrowserCache('message-queue:one');
  old.onclose?.(); old.onversionchange?.();
  await cache.readBrowserCache('message-queue:one');
  expect(cache.connections).toHaveLength(2);
});
