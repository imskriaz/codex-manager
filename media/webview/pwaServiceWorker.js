/* The dashboard is authenticated. Cache only versioned, non-sensitive UI
 * assets; never cache a navigation, API response, WebSocket, or user data. */
const version = new URL(self.location.href).searchParams.get("v") || "dev";
const cacheName = `codex-manager-static-${version}`;
const cachePrefix = "codex-manager-static-";
const staticTypes = new Map([
  ["/assets/shared.css", "text/css"],
  ["/assets/dashboard.css", "text/css"],
  ["/assets/browserHost.js", "javascript"],
  ["/assets/dashboard.js", "javascript"],
  ["/assets/codex.svg", "image/svg+xml"],
  ["/assets/icon-192.png", "image/png"],
  ["/assets/icon-512.png", "image/png"],
  ["/manifest.webmanifest", "application/manifest+json"],
  ["/offline.html", "text/html"]
]);
const warmPaths = [...staticTypes.keys()].map((path) =>
  path === "/offline.html" ? path : `${path}?v=${encodeURIComponent(version)}`
);

function isCacheable(response, expectedType) {
  if (!response || !response.ok || response.redirected || response.type === "opaque") return false;
  const type = response.headers.get("content-type")?.toLowerCase() || "";
  return type.includes(expectedType);
}

async function fetchAndCache(request, expectedType) {
  const response = await fetch(request);
  if (isCacheable(response, expectedType)) {
    try {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
    } catch {
      // Storage can be disabled or full. A live response must still work.
    }
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    await Promise.allSettled(warmPaths.map(async (path) => {
      const expectedType = staticTypes.get(new URL(path, self.location.origin).pathname);
      if (!expectedType) return;
      await fetchAndCache(new Request(path, { credentials: "same-origin", cache: "reload" }), expectedType);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => {
      const offline = await caches.match("/offline.html");
      return offline || new Response("The dashboard host is unavailable. Reopen this page when VS Code is running.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }));
    return;
  }

  const expectedType = staticTypes.get(url.pathname);
  if (!expectedType) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    return cached || fetchAndCache(request, expectedType);
  })());
});
