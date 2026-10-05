import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
describe("browser cache recovery", () => {
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
      const transaction = { onabort: undefined as undefined | (() => void), objectStore: () => ({ put: () => undefined, delete: () => undefined }) };
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
