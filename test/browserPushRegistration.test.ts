import { afterEach, beforeEach, expect, it, vi } from "vitest";

let api: typeof import("../webview-src/dashboard/browserNotifications");
const fetchMock = vi.fn();
const key = new Uint8Array(65).fill(4);
function subscription(name: string, serverKey = key) {
  return { endpoint: `https://fcm.googleapis.com/${name}`, options: { applicationServerKey: serverKey.buffer },
    unsubscribe: vi.fn(async () => true), toJSON: () => ({ endpoint: `https://fcm.googleapis.com/${name}`, keys: { auth: name, p256dh: name } }) };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(async () => {
  vi.resetModules(); fetchMock.mockReset();
  vi.stubGlobal("window", { setTimeout, clearTimeout }); vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string) => response(url.endsWith("/key") ? { publicKey: Buffer.from(key).toString("base64url") } : { ok: true }));
  api = await import("../webview-src/dashboard/browserNotifications");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("coalesces startup renewal without requesting permission or rotating a valid browser subscription", async () => {
  const current = subscription("current");
  const worker = { pushManager: { getSubscription: vi.fn(async () => current), subscribe: vi.fn() } };
  const first = api.registerBrowserPush(worker as never);
  expect(api.registerBrowserPush(worker as never)).toBe(first);
  expect(await first).toBe(current);
  expect(current.unsubscribe).not.toHaveBeenCalled(); expect(worker.pushManager.subscribe).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("repairs a login conflict by rotating only this browser and retrying registration once", async () => {
  const current = subscription("old"), fresh = subscription("new"); let posts = 0;
  fetchMock.mockImplementation(async (url: string) => url.endsWith("/key") ? response({ publicKey: Buffer.from(key).toString("base64url") }) : ++posts === 1 ? response({ code: "push-registration-conflict", error: "Needs refreshing" }, 409) : response({ ok: true }));
  const worker = { pushManager: { getSubscription: async () => current, subscribe: vi.fn(async () => fresh) } };
  expect(await api.registerBrowserPush(worker as never)).toBe(fresh);
  expect(current.unsubscribe).toHaveBeenCalledOnce(); expect(worker.pushManager.subscribe).toHaveBeenCalledOnce();
  expect(posts).toBe(2); expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/unsubscribe"))).toBe(false);
});
it("rotates a changed VAPID key and reports a browser that refuses rotation", async () => {
  const current = subscription("old", new Uint8Array(65).fill(5)), fresh = subscription("new");
  const worker = { pushManager: { getSubscription: async () => current, subscribe: vi.fn(async () => fresh) } };
  expect(await api.registerBrowserPush(worker as never)).toBe(fresh);
  expect(current.unsubscribe).toHaveBeenCalledOnce();
  current.unsubscribe.mockResolvedValue(false);
  await expect(api.registerBrowserPush(worker as never)).rejects.toThrow("could not refresh");
});
it("keeps the browser subscription on offline or expired-login failures", async () => {
  const current = subscription("current"), worker = { pushManager: { getSubscription: async () => current, subscribe: vi.fn() } };
  fetchMock.mockRejectedValueOnce(new TypeError("offline"));
  await expect(api.registerBrowserPush(worker as never)).rejects.toThrow("offline");
  fetchMock.mockResolvedValueOnce(new Response("Sign in", { status: 401 }));
  await expect(api.registerBrowserPush(worker as never)).rejects.toThrow("session expired");
  expect(current.unsubscribe).not.toHaveBeenCalled(); expect(worker.pushManager.subscribe).not.toHaveBeenCalled();
});
it("does not repeat a registration after an uncertain storage failure", async () => {
  const current = subscription("current"), worker = { pushManager: { getSubscription: async () => current, subscribe: vi.fn() } };
  fetchMock.mockResolvedValueOnce(response({ publicKey: Buffer.from(key).toString("base64url") })).mockResolvedValueOnce(response({ error: "Storage unavailable" }, 500));
  await expect(api.registerBrowserPush(worker as never)).rejects.toThrow("Storage unavailable");
  expect(fetchMock).toHaveBeenCalledTimes(2); expect(current.unsubscribe).not.toHaveBeenCalled();
  expect(await api.registerBrowserPush(worker as never)).toBe(current);
});
