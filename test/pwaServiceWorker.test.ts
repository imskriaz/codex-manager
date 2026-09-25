import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkerEvent = { waitUntil?: (work: Promise<unknown>) => void; request?: { method: string; mode: string; url: string }; respondWith?: (response: Promise<Response>) => void };

function createWorker(fetchMock: (request: { url: string }) => Promise<Response>) {
  const origin = "https://dashboard.example";
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const entries = new Map<string, Response>();
  const key = (request: string | { url: string }): string => new URL(typeof request === "string" ? request : request.url, origin).href;
  const caches = {
    open: vi.fn(async () => ({ put: async (request: { url: string }, response: Response) => { entries.set(key(request), response); } })),
    match: vi.fn(async (request: string | { url: string }) => entries.get(key(request))),
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
    clients: { claim: vi.fn(async () => undefined) }
  };
  runInNewContext(readFileSync("media/webview/pwaServiceWorker.js", "utf8"), {
    self, caches, fetch: fetchMock, Request: TestRequest, Response, URL, Promise, Map,
    encodeURIComponent
  });
  return { handlers, entries, caches, key };
}

describe("browser PWA cache boundary", () => {
  it("preloads only static UI assets and serves the generic offline page on navigation failure", async () => {
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
    let navigation: Promise<Response> | undefined;
    worker.handlers.get("fetch")?.({
      request: { method: "GET", mode: "navigate", url: "https://dashboard.example/01a04882-d037-7a42-ad24-9afb61901188" },
      respondWith: (response) => { navigation = response; }
    });
    expect(await navigation?.then((response) => response.text())).toBe("/offline.html");
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
