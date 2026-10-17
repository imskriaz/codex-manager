import { EventEmitter } from "events";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type * as http from "http";
import { describe, expect, it, vi } from "vitest";
import {
  isLocalWebDashboardRequest,
  getPeerActionTimeoutMs,
  getWebDashboardAssetVersion,
  getWebDashboardConnectSources,
  isCliSessionWatchPath,
  isTrustedWebDashboardOrigin,
  isWebDashboardPagePath,
  mergeFreshPeerAccountStates,
  normalizeWebDashboardReturnPath,
  readDashboardRequestBody,
  WebDashboardServer
} from "../src/services/webDashboardServer";

it("allows remote batches and sync to reach the same deadline as their local action", () => {
  expect(getPeerActionTimeoutMs("batchRefresh", 4)).toBe(960_000);
  expect(getPeerActionTimeoutMs("batchResyncProfile", 2)).toBe(600_000);
  expect(getPeerActionTimeoutMs("syncNow")).toBe(135_000);
  expect(getPeerActionTimeoutMs("refresh")).toBe(240_000);
});
import type { DashboardAccountViewModel } from "../src/domain/dashboard/types";
import { normalizeCloudflaredDomain } from "../src/presentation/dashboard/settings";

it("avoids rebuilding account snapshots for read-only graph, conversation, and workspace queries", async () => {
  const server = Object.create(WebDashboardServer.prototype) as {
    buildState: ReturnType<typeof vi.fn>;
    appendClientSnapshot: (messages: unknown[], request: unknown) => Promise<void>;
  };
  server.buildState = vi.fn().mockResolvedValue({ accounts: [] });
  for (const action of ["viewLogs", "downloadLogs", "getUsageGraph", "listCodexCliSessions", "getCodexCliSessionMessages", "getWorkspaceEnvironment", "listWorkspaceFiles", "readWorkspaceFile", "listWorkspaceTerminals"]) {
    const messages: unknown[] = [];
    await server.appendClientSnapshot(messages, { type: "dashboard:action", action });
    expect(messages).toEqual([]);
  }
  expect(server.buildState).not.toHaveBeenCalled();
  const messages: unknown[] = [];
  await server.appendClientSnapshot(messages, { type: "dashboard:action", action: "refreshView" });
  expect(messages).toEqual([{ type: "dashboard:snapshot", state: { accounts: [] } }]);
});

it("invalidates browser assets when a build changes within the requested release version", () => {
  const folder = mkdtempSync(join(tmpdir(), "codex-assets-"));
  try {
    mkdirSync(join(folder, "media", "webview"), { recursive: true });
    const file = join(folder, "media", "webview", "browserHost.js");
    writeFileSync(file, "first");
    const version = getWebDashboardAssetVersion(folder, "1.2.15");
    expect(getWebDashboardAssetVersion(folder, "1.2.15")).toBe(version);
    writeFileSync(file, "updated build");
    expect(getWebDashboardAssetVersion(folder, "1.2.15")).not.toBe(version);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

function createRequest(): http.IncomingMessage & EventEmitter {
  const request = new EventEmitter() as http.IncomingMessage & EventEmitter;
  request.setEncoding = vi.fn().mockReturnValue(request);
  return request;
}

it("permits dashboard WebSocket schemes through direct and rewritten proxy hosts without broadening CSP", () => {
  expect(getWebDashboardConnectSources({ headers: { host: "127.0.0.1:39875" } })).toBe("'self' ws://127.0.0.1:39875 wss://127.0.0.1:39875");
  expect(getWebDashboardConnectSources({ headers: { host: "localhost:39875", "x-forwarded-host": "dashboard.example.com" } })).toBe("'self' ws://dashboard.example.com wss://dashboard.example.com");
  expect(getWebDashboardConnectSources({ headers: { host: "localhost:39875" } }, "https://dashboard.example.com")).toContain("wss://dashboard.example.com");
  expect(getWebDashboardConnectSources({ headers: { host: "[::1]:39875" } })).toContain("ws://[::1]:39875");
  for (const host of ["bad; connect-src *", "user@host", "host/path", "host?query", "host#hash", "'unsafe-inline'", "*", "host:invalid"]) {
    expect(getWebDashboardConnectSources({ headers: { host } })).toBe("'self'");
  }
  expect(getWebDashboardConnectSources({ headers: {} }, "https://user:password@example.com")).toBe("'self'");
});

function account(id: string, lastQuotaAt: number, percentage: number, enabled = true): DashboardAccountViewModel {
  return {
    id,
    updatedAt: lastQuotaAt,
    displayName: id,
    email: `${id}@example.com`,
    tags: [],
    authProviderLabel: "",
    accountStructureLabel: "",
    workspaceLabel: "",
    isTeamWorkspace: false,
    subscriptionText: "Plus",
    subscriptionTitle: "Plus",
    addMethodLabel: "",
    addedAtLabel: "",
    isActive: false,
    switchQueued: false,
    isCurrentWindowAccount: false,
    enabled,
    queuePriority: false,
    tokenRefreshEnabled: false,
    canRefreshToken: true,
    showInStatusBar: false,
    canToggleStatusBar: true,
    statusToggleTitle: "",
    hasQuota402: false,
    healthKind: "healthy",
    healthLabel: "Healthy",
    dismissedHealth: false,
    lastQuotaAt,
    metrics: [{ key: "hourly", label: "5h", percentage, visible: true }]
  };
}

describe("mergeFreshPeerAccountStates", () => {
  it("uses a newer peer quota while preserving local device state", () => {
    const local = account("account-1", 100, 0, false);
    local.isActive = true;
    const peer = account("account-1", 200, 100, true);

    peer.displayName = "Updated peer name";
    const [merged] = mergeFreshPeerAccountStates([local], [{ accounts: [peer] }]);

    expect(merged.lastQuotaAt).toBe(200);
    expect(merged.metrics[0]?.percentage).toBe(100);
    expect(merged.displayName).toBe("Updated peer name");
    expect(merged.enabled).toBe(false);
    expect(merged.isActive).toBe(true);
  });

  it("does not replace a newer local quota with stale peer data", () => {
    const local = account("account-1", 300, 75);
    const peer = account("account-1", 200, 100);

    expect(mergeFreshPeerAccountStates([local], [{ accounts: [peer] }])[0]).toBe(local);
  });

  it("merges metadata and quota independently by their event timestamps", () => {
    const local = account("account-1", 300, 75);
    local.updatedAt = 100;
    const peer = account("account-1", 200, 10);
    peer.updatedAt = 400;
    peer.displayName = "New metadata";

    const [merged] = mergeFreshPeerAccountStates([local], [{ accounts: [peer] }]);

    expect(merged.displayName).toBe("New metadata");
    expect(merged.metrics[0]?.percentage).toBe(75);
    expect(merged.lastQuotaAt).toBe(300);
  });
});

describe("readDashboardRequestBody", () => {
  it("reads a request body within the configured limit", async () => {
    const request = createRequest();
    const pending = readDashboardRequestBody(request, 10);

    request.emit("data", "12345");
    request.emit("end");

    await expect(pending).resolves.toBe("12345");
  });

  it("rejects an oversized body without waiting for a close event", async () => {
    const request = createRequest();
    const pending = readDashboardRequestBody(request, 5);

    request.emit("data", "123456");

    await expect(pending).rejects.toThrow("Request body too large");
  });

  it("rejects an aborted request", async () => {
    const request = createRequest();
    const pending = readDashboardRequestBody(request, 10);

    request.emit("aborted");

    await expect(pending).rejects.toThrow("Request aborted");
  });

  it("counts streamed UTF-8 bytes against the limit", async () => {
    const request = createRequest();
    const pending = readDashboardRequestBody(request, 5);

    request.emit("data", "é");
    request.emit("data", "😀");

    await expect(pending).rejects.toThrow("Request body too large");
  });

  it("rejects when the request closes before its body ends", async () => {
    const request = createRequest();
    const pending = readDashboardRequestBody(request, 10);

    request.emit("data", "partial");
    request.emit("close");

    await expect(pending).rejects.toThrow("Request closed before body completed");
  });
});

describe("isWebDashboardPagePath", () => {
  it("serves the session workspace and direct session deep links", () => {
    expect(isWebDashboardPagePath("/")).toBe(true);
    expect(isWebDashboardPagePath("/dash")).toBe(true);
    expect(isWebDashboardPagePath("/workspace")).toBe(true);
    expect(isWebDashboardPagePath("/01a04882-d037-7a42-ad24-9afb61901188")).toBe(true);
    expect(isWebDashboardPagePath("/workspace/not-a-session")).toBe(false);
    expect(isWebDashboardPagePath("/workspace/01a04882-d037-7a42-ad24-9afb61901188")).toBe(true);
    expect(isWebDashboardPagePath("/------------------------------------")).toBe(false);
    expect(isWebDashboardPagePath("/workspace/01a04882-d037-7a42-ad24-9afb61901188/extra")).toBe(false);
  });

  it("preserves safe session routes after login and rejects redirect paths", () => {
    expect(normalizeWebDashboardReturnPath("/")).toBe("/");
    expect(normalizeWebDashboardReturnPath("/dash")).toBe("/");
    expect(normalizeWebDashboardReturnPath("/workspace")).toBe("/workspace");
    expect(normalizeWebDashboardReturnPath("/01a04882-d037-7a42-ad24-9afb61901188")).toBe(
      "/workspace/01a04882-d037-7a42-ad24-9afb61901188"
    );
    const session = "/workspace/01a04882-d037-7a42-ad24-9afb61901188";
    expect(normalizeWebDashboardReturnPath(`${session}?device=pc%3Aremote`)).toBe(`${session}?device=pc%3Aremote`);
    for (const unsafe of ["//example.com/steal", "/\\example.com/steal", "https://external.example", "http://localhost/workspace", "/workspace/not-a-session"]) {
      expect(normalizeWebDashboardReturnPath(unsafe)).toBe("/");
    }
  });
});

describe("browser PWA routes", () => {
  it("allows a public token to read only its snapshot while protecting creation and dashboard APIs", async () => {
    const stored = new Map<string, string>();
    const server = new WebDashboardServer({ extensionUri: { fsPath: process.cwd() },
      secrets: { get: async (key: string) => stored.get(key), store: async (key: string, value: string) => { stored.set(key, value); } }
    } as never, {} as never, { hasDashboardPassphrase: async () => true, setOnlineDeviceIds: vi.fn() } as never);
    const handle = (server as any).handle.bind(server);
    const call = async (url: string, method = "GET", input?: unknown, local = false) => {
      const headers = new Map<string, unknown>(); let body = "";
      const response = { statusCode: 200, setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value), end: (value?: string) => { body = value ?? ""; } };
      const request = createRequest();
      Object.assign(request, { method, url, headers: { host: "127.0.0.1:39875", origin: `${local ? "http" : "https"}://127.0.0.1:39875`, "x-codex-dashboard": "1", ...(local ? {} : { "x-forwarded-proto": "https" }) }, socket: { remoteAddress: "127.0.0.1" } });
      const pending = handle(request, response);
      if (input) setTimeout(() => { request.emit("data", JSON.stringify(input)); request.emit("end"); }, 0);
      await pending; return { ...response, body, headers };
    };
    try {
      const input = { sessionKey: "pc:conversation", title: "Example", messages: [{ role: "user", text: "Shared message" }] };
      expect((await call("/api/share/create", "POST", input)).statusCode).toBe(401);
      const created = await call("/api/share/create", "POST", input, true);
      expect(created.statusCode).toBe(200);
      const { token } = JSON.parse(created.body);
      const publicPage = await call(`/share/${token}`);
      expect(publicPage.statusCode).toBe(200); expect(publicPage.body).toContain("Shared message");
      const liveShare = await call(`/api/share/${token}`);
      expect(liveShare.statusCode).toBe(200);
      expect(liveShare.body).toContain("Shared message");
      expect(publicPage.headers.get("cache-control")).toBe("no-store");
      expect(publicPage.headers.get("referrer-policy")).toBe("no-referrer");
      expect((await call(`/api/state?token=${token}`)).statusCode).toBe(401);
      expect((await call(`/api/share/revoke?token=${token}`, "POST", input)).statusCode).toBe(401);
      expect((await call("/share/invalid")).statusCode).toBe(404);
      const delivery = vi.spyOn((server as any).browserPush, "sendTest").mockResolvedValue({ subscriptions: 1, accepted: 1, failed: 0 });
      expect((await call("/api/push/test", "POST", {})).statusCode).toBe(401);
      expect(delivery).not.toHaveBeenCalled();
      const testPush = await call("/api/push/test", "POST", {}, true);
      expect(testPush.statusCode).toBe(200);
      expect(JSON.parse(testPush.body)).toEqual({ subscriptions: 1, accepted: 1, failed: 0 });
      delivery.mockRejectedValueOnce(new Error("Push storage unavailable"));
      const failedPush = await call("/api/push/test", "POST", {}, true);
      expect(failedPush.statusCode).toBe(400); expect(failedPush.body).toContain("Push storage unavailable");
      expect((await call("/api/share/revoke", "POST", input, true)).statusCode).toBe(200);
      expect((await call(`/share/${token}`)).statusCode).toBe(404);
    } finally { server.dispose(); }
  });
  it("serves the public install shell without exposing private state and versions dashboard assets", async () => {
    const server = new WebDashboardServer(
      {
        extensionUri: { fsPath: process.cwd() },
        extension: { packageJSON: { version: "1.2.10-pre1" } },
        globalStorageUri: { fsPath: "storage" },
        secrets: { get: vi.fn(async () => undefined) }
      } as never,
      {} as never,
      { hasDashboardPassphrase: vi.fn(async () => true), setOnlineDeviceIds: vi.fn() } as never
    );
    const handle = (server as unknown as { handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> }).handle.bind(server);
    const get = async (url: string, forwarded = false): Promise<{ status: number; body: string; headers: Map<string, unknown> }> => {
      const headers = new Map<string, unknown>();
      let body = "";
      const response = {
        statusCode: 200,
        setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value),
        end: (value?: Buffer | string) => { body = value?.toString() ?? ""; }
      } as unknown as http.ServerResponse;
      await handle({
        method: "GET", url,
        headers: { host: "127.0.0.1:39875", ...(forwarded ? { "x-forwarded-proto": "https" } : {}) },
        socket: { remoteAddress: "127.0.0.1" }
      } as http.IncomingMessage, response);
      return { status: response.statusCode, body, headers };
    };
    try {
      const manifest = await get("/manifest.webmanifest", true);
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
      expect(JSON.parse(manifest.body)).toMatchObject({ name: "Codex Manager", display: "standalone", start_url: "/" });
      const worker = await get("/service-worker.js", true);
      expect(worker.status).toBe(200);
      expect(worker.headers.get("cache-control")).toBe("no-store");
      expect(worker.body).toContain("codex-manager-static-");
      const privateState = await get("/api/state", true);
      expect(privateState.status).toBe(401);
      for (const path of ["/dash", "/dash/", "/dash?from=bookmark"]) {
        const legacy = await get(path, true);
        expect(legacy.status).toBe(302);
        expect(legacy.headers.get("location")).toBe(path.includes("?") ? "/?from=bookmark" : "/");
        expect(legacy.body).toBe("");
      }
      const id = "01a04882-d037-7a42-ad24-9afb61901188";
      const oldSession = await get(`/${id}?device=pc%3Aremote`, true);
      expect(oldSession.status).toBe(302);
      expect(oldSession.headers.get("location")).toBe(`/workspace/${id}?device=pc%3Aremote`);
      const lockedSession = await get(`/workspace/${id}?device=pc%3Aremote`, true);
      expect(lockedSession.body).toContain(encodeURIComponent(`/workspace/${id}?device=pc%3Aremote`));
      const session = await get(`/workspace/${id}`);
      expect(session.status).toBe(200);
      expect(session.body).toContain('id="app"');
      const dashboard = await get("/");
      const assetVersion = getWebDashboardAssetVersion(process.cwd(), "1.2.10-pre1");
      expect(dashboard.body).toContain(`rel="manifest" href="/manifest.webmanifest?v=${assetVersion}"`);
      expect(dashboard.body).toContain(`src="/assets/browserHost.js?v=${assetVersion}"`);
      expect(dashboard.headers.get("cache-control")).toBe("no-store");
      expect(dashboard.headers.get("content-security-policy")).toContain("connect-src 'self' ws://127.0.0.1:39875 wss://127.0.0.1:39875;");
    } finally {
      server.dispose();
    }
  });
});

describe("isLocalWebDashboardRequest", () => {
  it("allows direct loopback hosts without password authorization", () => {
    expect(
      isLocalWebDashboardRequest({
        headers: { host: "localhost:39875" },
        socket: { remoteAddress: "127.0.0.1" }
      } as http.IncomingMessage)
    ).toBe(true);
    expect(
      isLocalWebDashboardRequest({
        headers: { host: "127.0.0.1:39875" },
        socket: { remoteAddress: "127.0.0.1" }
      } as http.IncomingMessage)
    ).toBe(true);
  });

  it("keeps forwarded Cloudflared requests behind the password gate", () => {
    expect(
      isLocalWebDashboardRequest({
        headers: {
          host: "localhost:39875",
          "x-forwarded-proto": "https"
        },
        socket: { remoteAddress: "127.0.0.1" }
      } as http.IncomingMessage)
    ).toBe(false);
    expect(
      isLocalWebDashboardRequest({
        headers: { host: "dashboard.example.com" },
        socket: { remoteAddress: "127.0.0.1" }
      } as http.IncomingMessage)
    ).toBe(false);
  });
});

describe("browser dashboard request boundaries", () => {
  it("accepts same-origin browser traffic and non-browser heartbeat clients", () => {
    expect(
      isTrustedWebDashboardOrigin({ headers: { host: "127.0.0.1:39875", origin: "http://127.0.0.1:39875" } })
    ).toBe(true);
    expect(
      isTrustedWebDashboardOrigin({
        headers: {
          host: "dashboard.example.com",
          origin: "https://dashboard.example.com",
          "x-forwarded-proto": "https"
        }
      })
    ).toBe(true);
    expect(
      isTrustedWebDashboardOrigin(
        {
          headers: {
            host: "127.0.0.1:39875",
            origin: "https://codex.madebydevs.com",
            "x-forwarded-proto": "http"
          }
        },
        "https://codex.madebydevs.com"
      )
    ).toBe(true);
    expect(isTrustedWebDashboardOrigin({ headers: { host: "127.0.0.1:39875" } })).toBe(true);
  });

  it("accepts Cloudflare same-origin login and WebSocket metadata after local host rewriting", () => {
    const forwardedHeaders = {
      host: "127.0.0.1:39875",
      origin: "https://codex.madebydevs.com",
      "x-forwarded-proto": "http",
      "cf-ray": "test-ray",
      "sec-fetch-site": "same-origin"
    };

    expect(isTrustedWebDashboardOrigin({ headers: forwardedHeaders })).toBe(true);
    expect(
      isTrustedWebDashboardOrigin({
        headers: { ...forwardedHeaders, "sec-fetch-mode": "websocket" }
      })
    ).toBe(true);
  });

  it("rejects cross-site and opaque browser origins targeting loopback", () => {
    expect(
      isTrustedWebDashboardOrigin({ headers: { host: "127.0.0.1:39875", origin: "https://malicious.example" } })
    ).toBe(false);
    expect(isTrustedWebDashboardOrigin({ headers: { host: "127.0.0.1:39875", origin: "null" } })).toBe(false);
    expect(
      isTrustedWebDashboardOrigin({
        headers: {
          host: "127.0.0.1:39875",
          origin: "https://malicious.example",
          "x-forwarded-proto": "http",
          "cf-ray": "test-ray",
          "sec-fetch-site": "cross-site"
        }
      })
    ).toBe(false);
  });

  it("does not retain the retired mobile authentication bypass", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).not.toContain("/api/mobile-login");
    expect(source).not.toContain("x-codex-mobile");
    expect(source).not.toContain('searchParams.get("mobile")');
  });

  it("expires, revokes, and signs out authenticated browser WebSocket sessions", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toMatch(/setTimeout\(\s*\(\) => client\.close\(4001, "Dashboard session expired"\)/);
    expect(source).toContain("this.browserSocketSessionFingerprint.set");
    expect(source).toContain("this.closeRemoteBrowserSockets();");
    expect(source).toContain("this.closeInvalidRemoteBrowserSockets()");
    expect(source).toContain('method === "POST" && path === "/logout"');
    expect(source).toContain("this.closeRemoteBrowserSockets((socket)");
  });

  it("watches active and archived session metadata without watching unrelated auth files", () => {
    expect(isCliSessionWatchPath("session_index.jsonl")).toBe(true);
    expect(isCliSessionWatchPath("sessions\\2026\\rollout.jsonl")).toBe(true);
    expect(isCliSessionWatchPath("archived_sessions\\2026\\08\\rollout.jsonl")).toBe(true);
    expect(isCliSessionWatchPath("thread-writer-locks/session.lock")).toBe(true);
    expect(isCliSessionWatchPath("auth.json")).toBe(false);
    expect(isCliSessionWatchPath("models_cache.json")).toBe(false);
  });

  it("keeps realtime revisions monotonic across extension-host restarts", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain("this.cliSessionRealtimeRevision + 1");
    expect(source).toContain("Date.now()");
  });

  it("does not probe the model catalog during realtime session reconciliation", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).not.toContain("readCodexCliComposerConfig");
    expect(source).toContain("stabilizeSessionProjectPaths(this.context, withCodexSessionRecovery(this.context, sessions))");
  });

  it("starts CLI realtime monitoring only for active workspace viewers", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain("const WORKSPACE_VIEWER_LEASE_MS = 45_000;");
    expect(source).toContain('message.type === "dashboard:workspace-presence"');
    expect(source).toContain("this.hasWorkspaceViewer()");
    expect(source).toContain("this.workspaceViewerLastSeen.delete(socket)");
    expect(source).not.toMatch(
      /this\.startCliSessionWatcher\(\);\s*this\.startCliSessionReconciliation\(\);\s*this\.updateOnlineDevicePresence/
    );
  });
});

describe("normalizeCloudflaredDomain", () => {
  it("normalizes a public HTTPS origin and rejects unsafe values", () => {
    expect(normalizeCloudflaredDomain("codex.example.com")).toBe("https://codex.example.com");
    expect(normalizeCloudflaredDomain("https://codex.example.com/")).toBe("https://codex.example.com");
    expect(normalizeCloudflaredDomain("http://codex.example.com")).toBeUndefined();
    expect(normalizeCloudflaredDomain("https://user:pass@codex.example.com")).toBeUndefined();
    expect(normalizeCloudflaredDomain(" ")).toBe("");
  });
});

describe("peer WebSocket failure handling", () => {
  it("runs durable Settings Sync for user-initiated browser sync actions", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source.match(/syncNow\(false, false, true\)/g)).toHaveLength(2);
    expect(source).not.toContain(
      "syncEncryptedAccounts: this.encryptedSync ? () => this.encryptedSync!.syncNow(false, false)"
    );
  });

  it("keeps peer presence through three missed heartbeats", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain("const PEER_OFFLINE_AFTER_MS = 15_000;");
    expect(source).toContain("this.deferPeerRemoval(peerId);");
    expect(source).toContain("Keep the last confirmed device set during the reconnect grace period.");
  });

  it("merges a peer claim before publishing the refreshed dashboard snapshot", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain(
      "await this.encryptedSync?.applyRealtimeEnablementRegistry(normalized.enablementRegistry);"
    );
  });

  it("does not re-enter Undici close while its error event is dispatching", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain('socket.addEventListener("error", () => undefined);');
    expect(source).not.toContain('socket.addEventListener("error", () => socket.close());');
    expect(source).toContain("if (this.peerStopped || !domain || this.peerSocket) return;");
    expect(source).toContain("if (!this.peerReconnectTimer)");
    expect(source).toContain("const PEER_RECONNECT_DELAY_MS = 1_000;");
  });

  it("uses the configured HTTPS origin exclusively for cross-PC WebSockets", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain('endpoint.protocol = "wss:";');
    expect(source).not.toContain('configuredDomain || (alwaysOnline ?');
  });

  it("publishes CLI session file changes after a short settling debounce", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain("const CLI_SESSION_WATCH_DEBOUNCE_MS = 250;");
    expect(source).toContain("}, CLI_SESSION_WATCH_DEBOUNCE_MS);");
  });

  it("fails pending peer actions immediately when the hub disconnects", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain("The peer WebSocket disconnected before the selected PC responded.");
    expect(source).toContain("this.peerActionWaiters.clear();");
  });

  it("prevents overlapping peer publishes and bounds HTTP heartbeat requests", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain("if (this.peerPublishInFlight)");
    expect(source).toContain("if (this.peerHttpHeartbeatInFlight)");
    expect(source).toContain("const PEER_HTTP_HEARTBEAT_TIMEOUT_MS = 10_000;");
    expect(source).toContain("signal: controller.signal");
  });

  it("keeps the VS Code host and detached relay on the single dashboard port", () => {
    const serverSource = readFileSync("src/services/webDashboardServer.ts", "utf8");
    const relaySource = readFileSync("tools/always-online-server.js", "utf8");
    expect(serverSource).toContain("const WEB_DASHBOARD_PORT = 39875;");
    expect(serverSource).not.toContain("39876");
    expect(relaySource).toContain("const port = 39875;");
    expect(relaySource).not.toContain("config.port || 39875");
  });
});


describe("confirmed peer claim sync", () => {
  function fixture() {
    const sync = {
      getRealtimeEncryptedVault: vi.fn(async () => "encrypted-vault"),
      signRealtimePeerPayload: vi.fn(async () => "signed"),
      verifyRealtimePeerPayload: vi.fn(async (_body: string, signature: string) => signature === "signed"),
      setOnlineDeviceIds: vi.fn(), setRealtimeSyncPublisher: vi.fn()
    };
    const server = new WebDashboardServer({ extensionUri: { fsPath: process.cwd() }, secrets: { get: vi.fn(async () => undefined) } } as never, {} as never, sync as never);
    const internal = server as unknown as {
      peerSocket: { readyState: number; send(raw: string): void; close(): void };
      peerVaultWaiters: Map<string, (applied: boolean) => void>;
      publishPeerVault(force: boolean): Promise<boolean>;
      acceptPeerVaultAcknowledgment(message: unknown): Promise<boolean>;
    };
    const sent: any[] = [];
    internal.peerSocket = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)), close: vi.fn() };
    return { server, internal, sent };
  }

  it("does not report success until a signed peer confirms application", async () => {
    const { server, internal, sent } = fixture();
    try {
      const task = internal.publishPeerVault(true);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      const ack = { type: "peer:vault-ack", requestId: sent[0].requestId, deviceId: "other-pc", applied: true, sentAt: Date.now(), signature: "bad" };
      await internal.acceptPeerVaultAcknowledgment(ack);
      expect(internal.peerVaultWaiters.size).toBe(1);
      await internal.acceptPeerVaultAcknowledgment({ ...ack, signature: "signed" });
      expect(await task).toBe(true);
      expect(internal.peerVaultWaiters.size).toBe(0);
    } finally { server.dispose(); }
  });

  it("settles missing confirmations as failure and clears its bounded queue", async () => {
    vi.useFakeTimers();
    const { server, internal, sent } = fixture();
    try {
      const task = internal.publishPeerVault(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await task).toBe(false);
      expect(internal.peerVaultWaiters.size).toBe(0);
    } finally { server.dispose(); vi.useRealTimers(); }
  });
});


it("signs the current claim registry even when account and session data stay cached", async () => {
  const released = { accountId: "one", deviceId: "peer", deviceName: "Other PC", enabled: false, revision: 2, updatedAt: Date.now() };
  const server = Object.create(WebDashboardServer.prototype) as any;
  Object.assign(server, { deviceId: "local", lastPeerSentAt: 0,
    readLocalPeerState: vi.fn(async () => ({ sessions: [], accounts: [], enablementRegistry: [{ ...released, enabled: true, revision: 1 }] })),
    encryptedSync: { getRealtimeEnablementRegistry: () => [released], signRealtimePeerPayload: vi.fn(async () => "signed") } });
  const snapshot = await server.readLocalPeerSessions();
  expect(snapshot.enablementRegistry).toEqual([released]);
  expect(server.encryptedSync.signRealtimePeerPayload).toHaveBeenCalledWith(expect.stringContaining('"enabled":false'));
});
