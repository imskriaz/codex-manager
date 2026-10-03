import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
describe("browser cache recovery", () => {
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
