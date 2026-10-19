import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkerEvent = { data?: { json(): unknown }; action?: string; notification?: { data: any; close(): void }; waitUntil?: (work: Promise<unknown>) => void; request?: { method: string; mode: string; url: string }; respondWith?: (response: Promise<Response>) => void };

function createWorker(fetchMock: (request: { url: string }) => Promise<Response>) {
  const origin = "https://dashboard.example";
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const entries = new Map<string, Response>();
  const key = (request: string | { url: string }): string => new URL(typeof request === "string" ? request : request.url, origin).href;
  const caches = {
    open: vi.fn(async () => ({ put: async (request: { url: string }, response: Response) => { entries.set(key(request), response); } })),
    match: vi.fn(async (request: string | { url: string }, options?: { ignoreSearch?: boolean }) => {
      const url = key(request);
      if (options?.ignoreSearch) return [...entries].find(([cached]) => new URL(cached).pathname === new URL(url).pathname)?.[1];
      return entries.get(url);
    }),
    keys: vi.fn(async () => ["codex-manager-static-test"]),
    delete: vi.fn(async () => true)
  };
  class TestRequest {
    readonly url: string;
    constructor(path: string) { this.url = key(path); }
  }
  const self = {
    location: { href: `${origin}/service-worker.js?v=test`, origin },
    addEventListener: (type: string, listener: (event: WorkerEvent) => void) => handlers.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    registration: { showNotification: vi.fn(async () => undefined) },
    clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => undefined) }
  };
  runInNewContext(readFileSync("media/webview/pwaServiceWorker.js", "utf8"), {
    self, caches, fetch: fetchMock, Request: TestRequest, Response, URL, Promise, Map,
    encodeURIComponent, AbortController, setTimeout, clearTimeout
  });
  return { handlers, entries, caches, key, self };
}

describe("browser PWA cache boundary", () => {
  it("returns live assets despite unavailable or full cache storage", async () => {
    const worker = createWorker(async () => new Response("live-css", { headers: { "content-type": "text/css" } }));
    worker.caches.match.mockRejectedValueOnce(new Error("Storage disabled"));
    worker.caches.open.mockRejectedValueOnce(new Error("Storage full"));
    let work: Promise<Response> | undefined;
    worker.handlers.get("fetch")?.({ request: { method: "GET", mode: "cors", url: "https://dashboard.example/assets/dashboard.css" }, respondWith: (promise) => { work = promise; } });
    expect(await work?.then((response) => response.text())).toBe("live-css");
  });

  it("handles mobile push and confirms an authenticated action before opening the dashboard", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    const worker = createWorker(fetchMock);
    let work: Promise<unknown> | undefined;
    const payload = { body: "Switch account?", notificationId: "notice", actions: ["Switch"], createdAt: Date.now() };
    worker.handlers.get("push")?.({ data: { json: () => payload }, waitUntil: (promise) => { work = promise; } });
    await work;
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith("Codex Manager", expect.objectContaining({ actions: [{ action: "Switch", title: "Switch" }] }));
    worker.handlers.get("notificationclick")?.({ action: "Switch", notification: { data: payload, close: vi.fn() }, waitUntil: (promise) => { work = promise; } });
    await work;
    expect(fetchMock).toHaveBeenCalledWith("/api/push/action", expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify({ notificationId: "notice", action: "Switch" }) }));
    expect(worker.self.registration.showNotification).toHaveBeenLastCalledWith("Codex Manager", expect.objectContaining({ body: expect.stringContaining("accepted") }));
    expect(worker.self.clients.openWindow).toHaveBeenCalledWith("https://dashboard.example/");
  });

  it("makes expired, failed, offline, and unauthorized push actions visible without retrying them", async () => {
    for (const status of [401, 409, 503]) {
      const worker = createWorker(async () => new Response("{}", { status }));
      let work: Promise<unknown> | undefined;
      worker.handlers.get("notificationclick")?.({ action: "Switch", notification: { data: { notificationId: "notice", actions: ["Switch"], createdAt: Date.now() }, close: vi.fn() }, waitUntil: (promise) => { work = promise; } });
      await work;
      expect(worker.self.registration.showNotification).toHaveBeenCalledWith("Codex Manager", expect.objectContaining({ body: expect.stringMatching(/Sign in|could not be confirmed/) }));
    }
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    const worker = createWorker(fetchMock);
    let work: Promise<unknown> | undefined;
    worker.handlers.get("notificationclick")?.({ action: "Switch", notification: { data: { notificationId: "notice", actions: ["Switch"], createdAt: Date.now() - 130000 }, close: vi.fn() }, waitUntil: (promise) => { work = promise; } });
    await work;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith("Codex Manager", expect.objectContaining({ body: expect.stringContaining("expired") }));
  });

  it("keeps live assets usable when cache storage is full and shows recovery on host restart", async () => {
    const worker = createWorker(async () => new Response("busy", { status: 503 }));
    worker.entries.set(worker.key("/offline.html"), new Response("Recovery screen"));
    let work: Promise<Response> | undefined;
    worker.handlers.get("fetch")?.({ request: { method: "GET", mode: "navigate", url: "https://dashboard.example/" }, respondWith: (promise) => { work = promise; } });
    expect(await work?.then((response) => response.text())).toBe("Recovery screen");
  });

  it("preloads data-free assets and restores the dashboard shell offline without caching APIs", async () => {
    let offline = false;
    const fetchMock = vi.fn(async (request: { url: string }) => {
      if (offline) throw new Error("host down");
      const path = new URL(request.url).pathname;
      const type = path.endsWith(".css") ? "text/css"
        : path.endsWith(".js") ? "text/javascript"
          : path.endsWith(".png") ? "image/png"
            : path.endsWith(".svg") ? "image/svg+xml"
              : path.endsWith(".webmanifest") ? "application/manifest+json" : "text/html";
      return new Response(path, { headers: { "content-type": type } });
    });
    const worker = createWorker(fetchMock);
    let install: Promise<unknown> | undefined;
    worker.handlers.get("install")?.({ waitUntil: (work) => { install = work; } });
    await install;
    expect([...worker.entries.keys()]).toContain("https://dashboard.example/offline.html");
    expect([...worker.entries.keys()].every((url) => !url.includes("/api/") && !url.includes("/ws") && !url.endsWith("/"))).toBe(true);

    const before = fetchMock.mock.calls.length;
    let staticResponse: Promise<Response> | undefined;
    worker.handlers.get("fetch")?.({
      request: { method: "GET", mode: "cors", url: "https://dashboard.example/assets/dashboard.js?v=test" },
      respondWith: (response) => { staticResponse = response; }
    });
    expect(await staticResponse?.then((response) => response.text())).toBe("/assets/dashboard.js");
    expect(fetchMock).toHaveBeenCalledTimes(before);

    let privateResponse: Promise<Response> | undefined;
    worker.handlers.get("fetch")?.({
      request: { method: "GET", mode: "cors", url: "https://dashboard.example/api/state" },
      respondWith: (response) => { privateResponse = response; }
    });
    expect(privateResponse).toBeUndefined();

    offline = true;
    let recovery: Promise<Response> | undefined;
    worker.handlers.get("fetch")?.({
      request: { method: "GET", mode: "cors", url: "https://dashboard.example/assets/pwaRecovery.js" },
      respondWith: (response) => { recovery = response; }
    });
    expect(await recovery?.then((response) => response.text())).toBe("/assets/pwaRecovery.js");
    expect(fetchMock).toHaveBeenCalledTimes(before);
    let navigation: Promise<Response> | undefined;
    worker.handlers.get("fetch")?.({
      request: { method: "GET", mode: "navigate", url: "https://dashboard.example/workspace/01a04882-d037-7a42-ad24-9afb61901188" },
      respondWith: (response) => { navigation = response; }
    });
    expect(await navigation?.then((response) => response.text())).toBe("/offline-dashboard.html");
  });

  it("does not cache a login page returned for a private script", async () => {
    const worker = createWorker(async (request) => {
      const path = new URL(request.url).pathname;
      return new Response("login", { headers: { "content-type": path.endsWith(".js") ? "text/html" : "text/css" } });
    });
    let response: Promise<Response> | undefined;
    worker.handlers.get("fetch")?.({
      request: { method: "GET", mode: "cors", url: "https://dashboard.example/assets/dashboard.js?v=test" },
      respondWith: (work) => { response = work; }
    });
    await response;
    expect(worker.entries.has("https://dashboard.example/assets/dashboard.js?v=test")).toBe(false);
  });
});
