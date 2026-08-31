import { EventEmitter } from "events";
import { readFileSync } from "fs";
import type * as http from "http";
import { describe, expect, it, vi } from "vitest";
import {
  isLocalWebDashboardRequest,
  isCliSessionWatchPath,
  isTrustedWebDashboardOrigin,
  isWebDashboardPagePath,
  normalizeWebDashboardReturnPath,
  readDashboardRequestBody
} from "../src/services/webDashboardServer";
import { normalizeCloudflaredDomain } from "../src/presentation/dashboard/settings";

function createRequest(): http.IncomingMessage & EventEmitter {
  const request = new EventEmitter() as http.IncomingMessage & EventEmitter;
  request.setEncoding = vi.fn().mockReturnValue(request);
  return request;
}

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
});

describe("isWebDashboardPagePath", () => {
  it("serves the session workspace and direct session deep links", () => {
    expect(isWebDashboardPagePath("/dash")).toBe(true);
    expect(isWebDashboardPagePath("/workspace")).toBe(true);
    expect(isWebDashboardPagePath("/01a04882-d037-7a42-ad24-9afb61901188")).toBe(true);
    expect(isWebDashboardPagePath("/workspace/not-a-session")).toBe(false);
    expect(isWebDashboardPagePath("/workspace/01a04882-d037-7a42-ad24-9afb61901188")).toBe(false);
  });

  it("preserves safe session routes after login and rejects redirect paths", () => {
    expect(normalizeWebDashboardReturnPath("/workspace")).toBe("/workspace");
    expect(normalizeWebDashboardReturnPath("/01a04882-d037-7a42-ad24-9afb61901188")).toBe(
      "/01a04882-d037-7a42-ad24-9afb61901188"
    );
    expect(normalizeWebDashboardReturnPath("//example.com/steal")).toBe("/dash");
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
    expect(source).toContain("stabilizeSessionProjectPaths(this.context, sessions)");
  });

  it("starts CLI realtime monitoring only for active workspace viewers", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain("const WORKSPACE_VIEWER_LEASE_MS = 45_000;");
    expect(source).toContain('message.type === "dashboard:workspace-presence"');
    expect(source).toContain("this.hasWorkspaceViewer()");
    expect(source).toContain("this.workspaceViewerLastSeen.delete(socket)");
    expect(source).not.toMatch(/this\.startCliSessionWatcher\(\);\s*this\.startCliSessionReconciliation\(\);\s*this\.updateOnlineDevicePresence/);
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
  it("keeps peer presence through three missed heartbeats", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain("const PEER_OFFLINE_AFTER_MS = 15_000;");
    expect(source).toContain("this.deferPeerRemoval(peerId);");
    expect(source).toContain("Keep the last confirmed device set during the reconnect grace period.");
  });

  it("merges a peer claim before publishing the refreshed dashboard snapshot", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain("await this.encryptedSync?.applyRealtimeEnablementRegistry(normalized.enablementRegistry);");
  });

  it("does not re-enter Undici close while its error event is dispatching", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain('socket.addEventListener("error", () => undefined);');
    expect(source).not.toContain('socket.addEventListener("error", () => socket.close());');
    expect(source).toContain("if (this.peerStopped || !domain || this.peerSocket) return;");
    expect(source).toContain("if (!this.peerReconnectTimer)");
    expect(source).toContain("const PEER_RECONNECT_DELAY_MS = 1_000;");
  });

  it("uses ws for a local relay and wss for an HTTPS peer hub", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain('endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";');
    expect(source).not.toContain('endpoint.protocol = "wss:";');
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
