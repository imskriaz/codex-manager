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
  ["/offline.html", "text/html"],
  ["/assets/pwaRecovery.js", "javascript"]
]);
const warmPaths = [...staticTypes.keys()].map((path) =>
  path === "/offline.html" ? path : `${path}?v=${encodeURIComponent(version)}`
);

function isCacheable(response, expectedType) {
  if (!response || !response.ok || response.redirected || response.type === "opaque") return false;
  const type = response.headers.get("content-type")?.toLowerCase() || "";
  return type.includes(expectedType);
}

async function fetchWithDeadline(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try { return await fetch(request, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function fetchAndCache(request, expectedType) {
  const response = await fetchWithDeadline(request);
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
    const names = await caches.keys().catch(() => []);
    await Promise.all(names.filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
      .map((name) => caches.delete(name).catch(() => false)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetchWithDeadline(request).then((response) => {
      if (response.status >= 500) throw new Error("Host restarting");
      return response;
    }).catch(async () => {
      const offline = await caches.match("/offline.html").catch(() => undefined);
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
    const cached = await caches.match(request, { ignoreSearch: true }).catch(() => undefined);
    return cached || fetchAndCache(request, expectedType);
  })());
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data?.json(); } catch { /* Malformed pushes still produce a visible generic notification. */ }
    const body = typeof payload?.body === "string" ? payload.body.slice(0, 900) : "A major dashboard update is available. Open the app to review it.";
    const actions = typeof payload?.notificationId === "string" && Array.isArray(payload?.actions)
      ? payload.actions.filter((action) => typeof action === "string").slice(0, 2).map((title) => ({ action: title, title })) : [];
    await self.registration.showNotification("Codex Manager", {
      body, icon: "/assets/icon-192.png", badge: "/assets/icon-192.png",
      tag: typeof payload?.tag === "string" ? payload.tag : "codex-manager-update", actions,
      data: { notificationId: payload?.notificationId, actions: actions.map((action) => action.action), createdAt: payload?.createdAt }
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data || {};
    if (event.action) {
      let feedback;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        if (!data.actions?.includes(event.action) || typeof data.createdAt !== "number" || Date.now() - data.createdAt > 120000) throw new Error("This action has expired. Open the dashboard to review current actions.");
        const response = await fetch("/api/push/action", { method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: { "Content-Type": "application/json", "X-Codex-Dashboard": "1" }, body: JSON.stringify({ notificationId: data.notificationId, action: event.action }) });
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to act on this notification." : "This action could not be confirmed. Open the dashboard to check its outcome before retrying.");
        feedback = "Your choice was accepted. Open the dashboard to see the result.";
      } catch (error) { feedback = error.message || "The host is unavailable. Open the dashboard and retry when connected."; }
      finally { clearTimeout(timer); }
      await self.registration.showNotification("Codex Manager", { body: feedback, tag: "codex-manager-action-result" });
    }
    const target = new URL("/dash", self.location.origin).href;
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(target); await existing.focus(); }
    else await self.clients.openWindow(target);
  })());
});
