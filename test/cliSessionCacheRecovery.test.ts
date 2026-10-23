import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
describe("browser cache recovery", () => {
  it('keeps a bounded, system-scoped visible list when browser storage is unavailable', async()=>{
    vi.useFakeTimers();vi.setSystemTime(10000);
    vi.stubGlobal('indexedDB',{open:()=>{throw Error('Storage unavailable');}});
    const cache=await import('../webview-src/dashboard/cliSessionCache');cache.bindBrowserCacheSystem('host-a');
    const composerConfig={models:[],defaultSandboxMode:'read-only' as const};
    const pending=cache.writeCliSessionListCache({sessions:[{id:'same',title:'Local',status:'running'}],composerConfig});
    expect(cache.peekCliSessionListCache()?.sessions[0]?.title).toBe('Local');await pending;
    await cache.writeCliSessionListCache({sessions:[{id:'same',title:'Remote',status:'idle',deviceId:'remote'}],composerConfig},'remote');
    expect(cache.peekCliSessionListCache()?.sessions[0]?.title).toBe('Local');
    expect(cache.peekCliSessionListCache('remote')?.sessions[0]?.title).toBe('Remote');
    vi.advanceTimersByTime(5001);
    expect(cache.peekCliSessionListCache()?.sessions[0]).toMatchObject({status:'unknown',canStop:false,locked:true});
    await cache.invalidateCliSessionCache('same','remote');expect(cache.peekCliSessionListCache('remote')).toBeUndefined();
    cache.bindBrowserCacheSystem('host-b');expect(cache.peekCliSessionListCache()).toBeUndefined();
    for(let index=0;index<9;index++)await cache.writeCliSessionListCache({sessions:[],composerConfig},`pc-${index}`);
    expect(cache.peekCliSessionListCache('pc-0')).toBeUndefined();expect(cache.peekCliSessionListCache('pc-8')).toBeDefined();
    vi.advanceTimersByTime(31*24*60*60*1000);expect(cache.peekCliSessionListCache('pc-8')).toBeUndefined();
  });
  it('ignores a late database read after invalidation and handles a full store without an uncaught error', async()=>{
    let completeRead:()=>void=()=>undefined,readStarted=false;
    const db={transaction:()=>{
      const tx={oncomplete:undefined as undefined|(()=>void),onabort:undefined as undefined|(()=>void),abort:()=>queueMicrotask(()=>tx.onabort?.()),objectStore:()=>({
        get:()=>{readStarted=true;const request={result:{updatedAt:Date.now(),value:{sessions:[{id:'old',title:'Old',status:'idle'}]}},onsuccess:undefined as undefined|(()=>void)};completeRead=()=>request.onsuccess?.();return request;},
        delete:()=>queueMicrotask(()=>tx.oncomplete?.()),
        openCursor:()=>{const request={result:undefined,onsuccess:undefined as undefined|(()=>void)};queueMicrotask(()=>request.onsuccess?.());return request;},
        put:()=>{throw new DOMException('Full','QuotaExceededError');}
      })};return tx;
    }};
    vi.stubGlobal('indexedDB',{open:()=>{const request={result:db,onsuccess:undefined as undefined|(()=>void)};queueMicrotask(()=>request.onsuccess?.());return request;}});
    const cache=await import('../webview-src/dashboard/cliSessionCache');cache.bindBrowserCacheSystem('host');
    const read=cache.readCliSessionListCache();await vi.waitFor(()=>expect(readStarted).toBe(true));
    await cache.invalidateCliSessionCache();completeRead();expect(await read).toBeUndefined();expect(cache.peekCliSessionListCache()).toBeUndefined();
    await cache.writeCliSessionListCache({sessions:[{id:'new',title:'New',status:'idle'}],composerConfig:{models:[],defaultSandboxMode:'read-only'}});
    expect(cache.peekCliSessionListCache()?.sessions[0]?.title).toBe('New');
  });
  it('reads only the outbox key range and keeps old unsynced entries available', async () => {
    const range = {}, bound = vi.fn(() => range);
    vi.stubGlobal('IDBKeyRange', { bound });
    const openCursor = vi.fn((requestedRange: unknown) => {
      expect(requestedRange).toBe(range);
      const row = { key: 'browser:outbox:old', updatedAt: 1, value: { task: { title: 'Keep unsynced' } } };
      const request = { result: undefined as undefined | { value: unknown; continue(): void }, onsuccess: undefined as undefined | (() => void) };
      request.result = { value: row, continue: () => queueMicrotask(() => { request.result = undefined; request.onsuccess?.(); transaction.oncomplete?.(); }) };
      queueMicrotask(() => request.onsuccess?.()); return request;
    });
    const transaction = { oncomplete: undefined as undefined | (() => void), objectStore: () => ({ openCursor }) };
    vi.stubGlobal('indexedDB', { open: () => {
      const request = { result: { transaction: () => transaction }, onsuccess: undefined as undefined | (() => void) };
      queueMicrotask(() => request.onsuccess?.()); return request;
    } });
    const cache = await import('../webview-src/dashboard/cliSessionCache');
    await expect(cache.listBrowserOutbox()).resolves.toEqual([{ key: 'outbox:old', value: { task: { title: 'Keep unsynced' } } }]);
    expect(bound).toHaveBeenCalledWith('browser:outbox:', 'browser:outbox:\uffff');
    expect(openCursor).toHaveBeenCalledOnce();
  });

  it('skips malformed cache rows and prunes invalid read timestamps without deleting drafts', async () => {
    const now = Date.now(), removed: string[] = [], put = vi.fn();
    const values = [{ key: ['unknown'] }, { key: 'future', updatedAt: now + 60_000 }, { key: 'invalid', updatedAt: NaN },
      { key: 'browser:outbox:keep', updatedAt: 1 }, { key: 'composer:keep', updatedAt: 1 }];
    const transaction = { oncomplete: undefined as undefined | (() => void), objectStore: () => ({
      put: (record: unknown) => { put(record); queueMicrotask(() => transaction.oncomplete?.()); },
      openCursor: () => {
        let index = 0;
        const request = { result: undefined as undefined | { value: unknown; delete(): void; continue(): void }, onsuccess: undefined as undefined | (() => void) };
        const next = () => {
          const value = values[index++];
          request.result = value ? { value, delete: () => { removed.push(String(value.key)); }, continue: () => queueMicrotask(next) } : undefined;
          request.onsuccess?.();
        };
        queueMicrotask(next); return request;
      }
    }) };
    vi.stubGlobal('indexedDB', { open: () => {
      const request = { result: { transaction: () => transaction }, onsuccess: undefined as undefined | (() => void) };
      queueMicrotask(() => request.onsuccess?.()); return request;
    } });
    const cache = await import('../webview-src/dashboard/cliSessionCache');
    await cache.writeCliSessionMessagesCache('one', []);
    expect(removed).toEqual(['future', 'invalid']);
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ key: 'messages:["local","one"]' }));
  });

  it("keeps recovery metadata while omitting graph histories from saved and restored dashboard caches", async () => {
    const records = new Map<string, unknown>();
    const db = { transaction: () => {
      const transaction = { oncomplete: undefined as undefined | (() => void), objectStore: () => ({
        openCursor: () => { const request = { result: undefined, onsuccess: undefined as undefined | (() => void) }; queueMicrotask(() => request.onsuccess?.()); return request; },
        put: (record: { key: string }) => { records.set(record.key, record); queueMicrotask(() => transaction.oncomplete?.()); },
        get: (key: string) => { const request = { result: records.get(key), onsuccess: undefined as undefined | (() => void) }; queueMicrotask(() => request.onsuccess?.()); return request; }
      }) };
      return transaction;
    } };
    vi.stubGlobal("indexedDB", { open: () => {
      const request = { result: db, onsuccess: undefined as undefined | (() => void) };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } });
    const cache = await import("../webview-src/dashboard/cliSessionCache");
    await cache.writeDashboardStateCache({ accounts: [], settings: {}, brandSub: "saved metadata", usageHistory: [{ at: 1 }], dailyUsageCache: [{ accountId: "a" }] } as never);
    const result = await cache.readDashboardStateCache();
    expect(result?.brandSub).toBe("saved metadata");
    expect(result).not.toHaveProperty("usageHistory");
    expect(result).not.toHaveProperty("dailyUsageCache");
    const record = records.get("dashboard-state") as { value: { state: Record<string, unknown> } };
    record.value.state["usageHistory"] = [{ at: 1 }];
    expect(await cache.readDashboardStateCache()).not.toHaveProperty("usageHistory");
    const a = [{ id: "same", email: "a@example.test" }], b = [{ id: "same", email: "b@example.test" }];
    await cache.writeDashboardStateCache({ accounts: a, connectedPeers: [{ id: "local-pc", local: true }], peerAccounts: { a, b }, settings: {} } as never);
    expect((await cache.readDashboardStateCache())?.peerAccounts).toEqual({});
    expect(await cache.readDashboardAccountsCache("local-pc")).toEqual(a);
    expect(await cache.readDashboardAccountsCache("a")).toEqual(a);
    expect(await cache.readDashboardAccountsCache("b")).toEqual(b);
    await cache.writeDashboardStateCache({ accounts: a, peerAccounts: { a: [] }, settings: {} } as never);
    expect(await cache.readDashboardAccountsCache("a")).toEqual([]);
    expect(await cache.readDashboardAccountsCache("b")).toEqual(b);
  });
  it("bounds stalled cache writes and invalidations and allows a later write", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    let complete = false;
    const abort = vi.fn();
    const db = { transaction: () => {
      const transaction = { abort, oncomplete: undefined as undefined | (() => void), objectStore: () => ({ openCursor: () => ({}), put: () => undefined, delete: () => undefined }) };
      if (complete) queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    } };
    vi.stubGlobal("indexedDB", { open: () => {
      const request = { result: db, onsuccess: undefined as undefined | (() => void) };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } });
    const cache = await import("../webview-src/dashboard/cliSessionCache");
    const writes = Promise.all([
      cache.writeCliSessionMessagesCache("session", []),
      cache.invalidateCliSessionCache("session"),
      cache.writeDashboardStateCache({ usageHistory: [] } as never)
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(writes).resolves.toHaveLength(3);
    expect(abort).toHaveBeenCalledTimes(3);
    complete = true;
    await expect(cache.writeDashboardStateCache({ usageHistory: [] } as never)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a stalled draft read and reports failed draft writes", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const db = { transaction: () => ({ abort, objectStore: () => ({ get: () => ({}), openCursor: () => ({}) }) }) };
    vi.stubGlobal("indexedDB", { open: () => {
      const request = { result: db, onsuccess: undefined as undefined | (() => void) };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } });
    const cache = await import("../webview-src/dashboard/cliSessionCache");
    const read = cache.readCliComposerDraft("draft");
    await vi.advanceTimersByTimeAsync(3000);
    await expect(read).resolves.toBeUndefined();
    const write = cache.writeCliComposerDraft("draft", { text: "preserve me", attachments: [] });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(write).resolves.toBe(false);
    expect(abort).toHaveBeenCalledTimes(2);
  });
  it("restores device-scoped composer text and settings after module reload", async () => {
    const records = new Map<string, unknown>();
    const db = { transaction: () => {
      const transaction = { oncomplete: undefined as undefined | (() => void), onabort: undefined as undefined | (() => void), abort: () => queueMicrotask(() => transaction.onabort?.()), objectStore: () => ({
        get: (key: string) => { const request = { result: records.get(key), onsuccess: undefined as undefined | (() => void) }; queueMicrotask(() => request.onsuccess?.()); return request; },
        openCursor: () => {
          const values = [...records.values()];
          let index = 0;
          const request = { result: undefined as undefined | { value: unknown; delete: () => void; continue: () => void }, onsuccess: undefined as undefined | (() => void) };
          const next = () => { request.result = index < values.length ? { value: values[index++], delete: () => undefined, continue: () => queueMicrotask(next) } : undefined; request.onsuccess?.(); };
          queueMicrotask(next);
          return request;
        },
        put: (record: { key: string }) => { records.set(record.key, record); queueMicrotask(() => transaction.oncomplete?.()); }
      }) };
      return transaction;
    } };
    vi.stubGlobal("indexedDB", { open: () => {
      const request = { result: db, onsuccess: undefined as undefined | (() => void) };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } });
    const cache = await import("../webview-src/dashboard/cliSessionCache");
    const draft = { text: "unsent", attachments: [], model: "model-a", sandboxMode: "read-only" as const };
    await expect(cache.writeCliComposerDraft("pc-a:chat", draft)).resolves.toBe(true);
    vi.resetModules();
    const reopened = await import("../webview-src/dashboard/cliSessionCache");
    await expect(reopened.readCliComposerDraft("pc-a:chat")).resolves.toEqual(draft);
    await expect(reopened.readCliComposerDraft("pc-b:chat")).resolves.toBeUndefined();
    const list = { sessions: [{ id: 'remote', title: 'Remote', status: 'idle' as const, deviceId: 'pc-a', remote: true }],
      composerConfig: { models: [], projects: [{ id: 'project', label: 'Remote project', path: 'E:/remote' }] } };
    await reopened.writeCliSessionListCache({ ...list, sessions: [...list.sessions,
      { id: 'local', title: 'Local', status: 'idle' }, { ...list.sessions[0], deviceId: 'pc-b' }] }, 'pc-a');
    await expect(reopened.readCliSessionListCache('pc-a')).resolves.toMatchObject(list);
    await expect(reopened.readCliSessionListCache('pc-b')).resolves.toBeUndefined();
    await expect(reopened.readCliSessionListCache()).resolves.toBeUndefined();
    const old = reopened.writeCliSessionListCache({ sessions: [{ ...list.sessions[0]!, title: "Stale" }] }, "pc-a");
    const newest = reopened.writeCliSessionListCache({ ...list, sessions: [{ ...list.sessions[0]!, title: "Newest" }] }, "pc-a");
    await Promise.all([old, newest]);
    expect((await reopened.readCliSessionListCache("pc-a"))?.sessions[0]?.title).toBe("Newest");
    await reopened.writeCliSessionListCache({ sessions: [{ ...list.sessions[0]!, title: "Event update" }] }, "pc-a");
    expect((await reopened.readCliSessionListCache("pc-a"))?.composerConfig).toEqual(list.composerConfig);
    reopened.bindBrowserCacheSystem('host-a');
    await reopened.writeCliSessionListCache({ sessions: [{ id: 'native', title: 'Host A', status: 'idle' }] });
    await reopened.writeCliSessionMessagesCache('native', [{ id: 'a', kind: 'message', role: 'user', text: 'Host A text' }]);
    reopened.bindBrowserCacheSystem('host-b');
    expect(await reopened.readCliSessionListCache()).toBeUndefined();
    expect(await reopened.readCliSessionMessagesCache('native')).toBeUndefined();
    await reopened.writeCliSessionListCache({ sessions: [{ id: 'native', title: 'Host B', status: 'idle' }] });
    reopened.bindBrowserCacheSystem('host-a');
    expect((await reopened.readCliSessionListCache())?.sessions[0]?.title).toBe('Host A');
    expect((await reopened.readCliSessionMessagesCache('native'))?.[0]?.text).toBe('Host A text');
    reopened.bindBrowserCacheSystem(undefined);
    expect(await reopened.readCliSessionListCache()).toBeUndefined();
    const legacyKey = 'composer:["local","new","D:/work"]';
    records.set(legacyKey, { key: legacyKey, updatedAt: Date.now(), value: draft });
    expect(await reopened.readCliComposerDraft('["host-b","new","D:/work"]')).toBeUndefined();
    expect(await reopened.readLegacyCliComposerDraft('["host-b","new","D:/work"]')).toEqual(draft);
    expect(records.has(legacyKey)).toBe(true);
    records.delete(legacyKey);
    const stored = records.get("composer:pc-a:chat") as { updatedAt: number };
    stored.updatedAt = Date.now() + 60_000;
    await expect(reopened.readCliComposerDraft("pc-a:chat")).resolves.toBeUndefined();
    stored.updatedAt = Date.now();
    await reopened.writeCliComposerDraft("pc-a:chat", { ...draft, text: "first edit" }).then(() => reopened.writeCliComposerDraft("pc-a:chat", { ...draft, text: "latest edit" }));
    await expect(reopened.readCliComposerDraft("pc-a:chat")).resolves.toMatchObject({ text: "latest edit" });
    for (let index = 0; index < 19; index++) records.set(`composer:pending-${index}`, { key: `composer:pending-${index}`, updatedAt: Date.now(), value: { text: `Unsent ${index}`, attachments: [] } });
    await expect(reopened.writeCliComposerDraft("new-chat", draft)).resolves.toBe(false);
    expect(records.has("composer:new-chat")).toBe(false);
    await expect(reopened.readCliComposerDraft("pending-18")).resolves.toMatchObject({ text: "Unsent 18" });
  });
  it("falls back when storage access throws and retries later", async () => {
    vi.resetModules();
    const open = vi.fn(() => { throw new Error("Storage access denied"); });
    vi.stubGlobal("indexedDB", { open });
    const cache = await import("../webview-src/dashboard/cliSessionCache");
    await expect(cache.readCliSessionMessagesCache("session")).resolves.toBeUndefined();
    await expect(cache.writeCliSessionMessagesCache("session", [])).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledTimes(2);
  });
  it("finishes aborted writes and invalidations without hanging", async () => {
    vi.resetModules();
    const db = { transaction: () => {
      const transaction = { onabort: undefined as undefined | (() => void), objectStore: () => ({ openCursor: () => ({}), put: () => undefined, delete: () => undefined }) };
      queueMicrotask(() => transaction.onabort?.());
      return transaction;
    } };
    vi.stubGlobal("indexedDB", { open: () => {
      const request = { result: db, onsuccess: undefined as undefined | (() => void) };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } });
    const cache = await import("../webview-src/dashboard/cliSessionCache");
    await expect(cache.writeCliSessionMessagesCache("session", [], "pc-a")).resolves.toBeUndefined();
    await expect(cache.invalidateCliSessionCache("session", "pc-a")).resolves.toBeUndefined();
  });
  it("bounds an unresponsive database open so cache cannot block live chat", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("indexedDB", { open: () => ({}) });
    const cache = await import("../webview-src/dashboard/cliSessionCache");
    const read = cache.readCliSessionMessagesCache("session");
    await vi.advanceTimersByTimeAsync(2000);
    await expect(read).resolves.toBeUndefined();
  });
});
