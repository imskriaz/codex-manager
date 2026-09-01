import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as http from "http";
import * as path from "path";
import * as os from "os";
import { gzipSync } from "zlib";
import * as vscode from "vscode";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { fetch as undiciFetch, WebSocket as UndiciWebSocket } from "undici";
import { buildDashboardState } from "../application/dashboard/buildDashboardState";
import { scheduleExtensionHostReload } from "../application/accounts/switchEffects";
import type { DashboardClientMessage, DashboardHostMessage, DashboardPeerView } from "../domain/dashboard/types";
import type { DashboardState } from "../domain/dashboard/types";
import type { DashboardActionPayload } from "../domain/dashboard/types";
import { ExtensionSettingsStore, getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import { executeDashboardActionMessage } from "../presentation/dashboard/actionHandlers";
import { consumeDashboardActionPrompts, withDashboardNotificationSuppression } from "../utils/notificationPolicy";
import {
  resolveMirroredNotification,
  subscribeToVscodeNotificationResolutions,
  subscribeToVscodeNotifications,
  type MirroredNotification
} from "../utils/notificationMirror";
import { clearDashboardCodexAppPath, clearDashboardCodexCliPath } from "../presentation/dashboard/messageDispatcher";
import { buildDashboardStateSignature } from "../presentation/dashboard/signature";
import { DashboardOAuthCoordinator } from "../presentation/dashboard/oauthCoordinator";
import {
  handleDashboardSettingUpdate,
  normalizeCloudflaredDomain,
  pickDashboardCodexAppPath,
  pickDashboardCodexCliPath
} from "../presentation/dashboard/settings";
import { recordPeerQuotaChecks } from "./quotaCheckCoordination";
import { AccountsRepository } from "../storage";
import { AnnouncementService, type AnnouncementOptions } from "./announcements";
import type { EncryptedSyncManager } from "./encryptedSync";
import { isValidSyncAccountEnablement, type SyncAccountEnablement } from "./syncEnablementRegistry";
import { readCodexCliSessions, resolveCodexHome } from "./codexSessionResume";
import { stabilizeSessionProjectPaths } from "./sessionProjectBindings";
import {
  appendDashboardUsageSnapshot,
  readDashboardDailyUsageCache,
  saveDashboardUsageHistory
} from "./dashboardUsageHistory";
import { subscribeDashboardRealtime } from "./dashboardRealtime";

const WEB_DASHBOARD_PORT = 39875;
const LEGACY_PASSWORD_SECRET_KEY = "codexManager.webDashboard.passwordHash.v1";
const SESSION_SECRET_KEY = "codexManager.webDashboard.sessions.v1";
const SESSION_COOKIE = "codex_dashboard_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PERSISTED_SESSIONS = 16;
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_DASHBOARD_MESSAGE_BYTES = 2 * 1024 * 1024;
const PEER_HEARTBEAT_INTERVAL_MS = 5_000;
// Keep a peer's claim visible through a short transport interruption. A
// dropped WebSocket is not proof that the PC went offline; the reconnect and
// HTTP-heartbeat paths have a chance to confirm it before we release state.
const PEER_OFFLINE_AFTER_MS = 15_000;
const PEER_RECONNECT_DELAY_MS = 1_000;
const PEER_HTTP_HEARTBEAT_TIMEOUT_MS = 10_000;
const LOCAL_CLI_SESSION_CACHE_MS = 2_000;
const CLI_SESSION_RECONCILE_MS = 30_000;
const CLI_SESSION_WATCH_DEBOUNCE_MS = 250;
const WORKSPACE_VIEWER_LEASE_MS = 45_000;

function decodeWebSocketMessage(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export type WebDashboardOpenResult = "opened" | "cancelled" | "unavailable";

type LoginAttempt = { count: number; resetAt: number };
type PeerSessionMessage = {
  type: "peer:sessions";
  deviceId: string;
  deviceName: string;
  sessions: Array<{
    id: string;
    title: string;
    updatedAt?: string;
    status: "running" | "idle";
    archived?: boolean;
    projectPath?: string;
  }>;
  accounts?: import("../domain/dashboard/types").DashboardAccountViewModel[];
  enablementRegistry?: SyncAccountEnablement[];
  sentAt: number;
  signature?: string;
};
type PeerVaultMessage = {
  type: "peer:vault";
  deviceId: string;
  sentAt: number;
  vault: string;
  signature?: string;
};
type PeerActionMessage = {
  type: "peer:action";
  requestId: string;
  action: string;
  accountId?: string;
  payload?: DashboardActionPayload;
};
type PeerActionResultMessage = {
  type: "peer:action-result";
  requestId: string;
  status: "completed" | "cancelled" | "failed";
  payload?: unknown;
  error?: string;
};
type PeerAggregateMessage = {
  type: "peer:aggregate";
  peers: PeerSessionMessage[];
};
type LocalPeerState = Pick<PeerSessionMessage, "sessions" | "accounts" | "enablementRegistry">;

function peerSessionSignaturePayload(message: Omit<PeerSessionMessage, "signature">): string {
  return JSON.stringify({
    type: message.type,
    deviceId: message.deviceId,
    deviceName: message.deviceName,
    sessions: message.sessions,
    accounts: message.accounts ?? [],
    enablementRegistry: message.enablementRegistry ?? [],
    sentAt: message.sentAt
  });
}

function peerVaultSignaturePayload(message: Omit<PeerVaultMessage, "signature">): string {
  return JSON.stringify({ type: message.type, deviceId: message.deviceId, sentAt: message.sentAt, vault: message.vault });
}

export function isCliSessionWatchPath(filename: string | Buffer | null): boolean {
  if (filename === null) return true;
  const normalized = String(filename).replace(/\\/g, "/").toLowerCase();
  return (
    normalized === "session_index.jsonl" ||
    normalized.startsWith("sessions/") ||
    normalized.startsWith("archived_sessions/") ||
    normalized.startsWith("thread-writer-locks/")
  );
}

const WEB_DASHBOARD_ASSETS: Record<string, { parts: string[]; contentType: string }> = {
  "/assets/shared.css": { parts: ["media", "webview", "shared.css"], contentType: "text/css; charset=utf-8" },
  "/assets/dashboard.css": { parts: ["media", "webview", "quotaSummary.css"], contentType: "text/css; charset=utf-8" },
  "/assets/browserHost.js": {
    parts: ["media", "webview", "browserHost.js"],
    contentType: "text/javascript; charset=utf-8"
  },
  "/assets/dashboard.js": {
    parts: ["media", "webview", "dashboard", "dashboard.js"],
    contentType: "text/javascript; charset=utf-8"
  },
  "/assets/codex.svg": {
    parts: ["media", "product-icons", "codex-openai.svg"],
    contentType: "image/svg+xml"
  }
};

export class WebDashboardServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private readonly webSocketClients = new Set<WebSocket>();
  private readonly webSocketServer = new WebSocketServer({ noServer: true });
  private realtimePublishInFlight = false;
  private realtimePublishQueued = false;
  private stateBuildInFlight: Promise<DashboardState> | undefined;
  private lastRealtimeSignature = "";
  private readonly webSocketLastPong = new WeakMap<WebSocket, number>();
  private readonly workspaceViewerLastSeen = new Map<WebSocket, number>();
  private webSocketHeartbeatTimer: NodeJS.Timeout | undefined;
  private readonly peerSessions = new Map<string, PeerSessionMessage>();
  private readonly peerLastSeenAt = new Map<string, number>();
  private readonly peerLastSignedAt = new Map<string, number>();
  private readonly peerSockets = new Map<string, WebSocket>();
  private readonly peerDisconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly authenticatedPeerSockets = new WeakSet<WebSocket>();
  private readonly peerActionWaiters = new Map<string, (result: PeerActionResultMessage) => void>();
  private peerSocket: UndiciWebSocket | undefined;
  private peerReconnectTimer: NodeJS.Timeout | undefined;
  private peerPublishTimer: NodeJS.Timeout | undefined;
  private peerHttpHeartbeatTimer: NodeJS.Timeout | undefined;
  private peerPublishInFlight: Promise<void> | undefined;
  private peerPublishQueued = false;
  private lastPublishedPeerVault = "";
  private peerHttpHeartbeatInFlight: Promise<void> | undefined;
  private peerPresenceAuthoritative = false;
  private lastPeerSentAt = 0;
  private peerPresenceLossTimer: NodeJS.Timeout | undefined;
  private peerHeartbeatFailureReported = false;
  private cliSessionWatcher: fsSync.FSWatcher | undefined;
  private cliSessionChangeTimer: NodeJS.Timeout | undefined;
  private cliSessionReconcileTimer: NodeJS.Timeout | undefined;
  private cliSessionRealtimeRevision = Date.now();
  private cliSessionPublish: Promise<void> | undefined;
  private localCliSessions: import("../domain/dashboard/types").DashboardCliSessionSummary[] | undefined;
  private localCliSessionsReadAt = 0;
  private localCliSessionsRead: Promise<import("../domain/dashboard/types").DashboardCliSessionSummary[]> | undefined;
  private localPeerState: LocalPeerState | undefined;
  private localPeerStateRevision = 0;
  private localPeerStateRead: Promise<{ revision: number; state: LocalPeerState }> | undefined;
  private deviceId: string;
  private peerStopped = true;
  private readonly sessions = new Map<string, number>();
  private readonly loginAttempts = new Map<string, LoginAttempt>();
  private readonly settingsStore = new ExtensionSettingsStore();
  private readonly announcements: AnnouncementService;
  private readonly oauth: DashboardOAuthCoordinator;
  private notificationMirrorSubscription: vscode.Disposable | undefined;
  private notificationResolutionSubscription: vscode.Disposable | undefined;
  private readonly assetCache = new Map<string, { content: Buffer; gzip: Buffer; etag: string }>();
  private readonly dashboardRealtimeSubscription: () => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repo: AccountsRepository,
    private readonly encryptedSync?: EncryptedSyncManager
  ) {
    this.deviceId = context.globalState?.get<string>("codexManager.webDashboard.deviceId") ?? crypto.randomUUID();
    void context.globalState?.update("codexManager.webDashboard.deviceId", this.deviceId);
    this.announcements = new AnnouncementService(context.globalStorageUri.fsPath, context.extensionUri.fsPath);
    this.oauth = new DashboardOAuthCoordinator(
      repo,
      () => undefined,
      async () => {
        if (!getCodexManagerConfiguration().get<boolean>("encryptedSyncEnabled", false)) {
          return undefined;
        }
        return this.encryptedSync
          ? this.encryptedSync.syncNow(true, false)
          : vscode.commands.executeCommand<boolean>("codexManager.syncNow", { announceSuccess: false });
      }
    );
    this.dashboardRealtimeSubscription = subscribeDashboardRealtime((message) => {
      if (this.webSocketClients.size === 0 || message.type === "dashboard:snapshot") return;
      const serialized = JSON.stringify(message);
      for (const socket of this.webSocketClients) {
        if (socket.readyState === WebSocket.OPEN) socket.send(serialized);
      }
    });
    this.webSocketServer.on("connection", (socket, request) => {
      this.webSocketLastPong.set(socket, Date.now());
      socket.on("pong", () => this.webSocketLastPong.set(socket, Date.now()));
      const query = new URL(request.url ?? "/", this.getUrl()).searchParams;
      if (query.get("peer") === "1") {
        const peerId = query.get("deviceId");
        socket.once("close", () => {
          if (peerId && this.peerSockets.get(peerId) === socket) {
            this.peerSockets.delete(peerId);
            this.deferPeerRemoval(peerId);
          }
        });
        socket.on("message", (data) => {
          void this.handlePeerMessage(decodeWebSocketMessage(data), socket);
        });
      } else {
        this.webSocketClients.add(socket);
        const removeClient = (): void => {
          this.webSocketClients.delete(socket);
          this.workspaceViewerLastSeen.delete(socket);
          this.refreshCliSessionRealtimeLifecycle();
        };
        socket.once("close", removeClient);
        socket.once("error", removeClient);
        socket.on("message", (data) => {
          void this.handleBrowserSocketMessage(decodeWebSocketMessage(data), socket);
        });
        void this.sendRealtimeSnapshot(socket);
      }
    });
  }

  async start(): Promise<void> {
    if (!this.isEnabled() || this.server) return;
    // The browser dashboard now authenticates with the encrypted-sync
    // passphrase. Remove the retired standalone password secret if present.
    try {
      await this.context.secrets.delete(LEGACY_PASSWORD_SECRET_KEY);
    } catch {
      // Removing an already-missing legacy secret is best effort.
    }
    if (this.encryptedSync) this.deviceId = await this.encryptedSync.getPresenceDeviceId();
    this.peerStopped = false;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        console.error("[codexManager] Web Dashboard request failed", error);
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
        }
        if (!response.writableEnded) response.end("Dashboard request failed");
      });
    });
    this.server.on("upgrade", (request, socket, head) => {
      void this.handleWebSocketUpgrade(request, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.off("listening", onListening);
        this.server = undefined;
        if (isAddressInUseError(error)) {
          resolve();
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(WEB_DASHBOARD_PORT, "127.0.0.1");
    });
    this.startWebSocketHeartbeat();
    this.notificationMirrorSubscription ??= subscribeToVscodeNotifications((notification) => {
      this.broadcastRealtimeNotice(notification);
    });
    this.notificationResolutionSubscription ??= subscribeToVscodeNotificationResolutions((notificationId) => {
      this.broadcastRealtimeNotificationDismissed(notificationId);
    });
    this.updateOnlineDevicePresence();
    this.connectPeerSocket();
  }

  async stop(): Promise<void> {
    this.peerStopped = true;
    this.sessions.clear();
    this.loginAttempts.clear();
    const server = this.server;
    this.server = undefined;
    for (const socket of this.webSocketClients) socket.close();
    this.webSocketClients.clear();
    this.workspaceViewerLastSeen.clear();
    this.notificationMirrorSubscription?.dispose();
    this.notificationMirrorSubscription = undefined;
    this.notificationResolutionSubscription?.dispose();
    this.notificationResolutionSubscription = undefined;
    if (this.webSocketHeartbeatTimer) clearInterval(this.webSocketHeartbeatTimer);
    this.webSocketHeartbeatTimer = undefined;
    this.cliSessionWatcher?.close();
    this.cliSessionWatcher = undefined;
    if (this.cliSessionChangeTimer) clearTimeout(this.cliSessionChangeTimer);
    this.cliSessionChangeTimer = undefined;
    if (this.cliSessionReconcileTimer) clearInterval(this.cliSessionReconcileTimer);
    this.cliSessionReconcileTimer = undefined;
    for (const socket of this.peerSockets.values()) socket.close();
    this.peerSockets.clear();
    for (const timer of this.peerDisconnectTimers.values()) clearTimeout(timer);
    this.peerDisconnectTimers.clear();
    this.peerSocket?.close();
    this.peerSocket = undefined;
    if (this.peerReconnectTimer) clearTimeout(this.peerReconnectTimer);
    this.peerReconnectTimer = undefined;
    if (this.peerPublishTimer) clearInterval(this.peerPublishTimer);
    if (this.peerHttpHeartbeatTimer) clearInterval(this.peerHttpHeartbeatTimer);
    this.peerHttpHeartbeatTimer = undefined;
    this.peerSessions.clear();
    this.peerLastSeenAt.clear();
    this.peerLastSignedAt.clear();
    for (const timer of this.peerDisconnectTimers.values()) clearTimeout(timer);
    this.peerDisconnectTimers.clear();
    this.peerPresenceAuthoritative = false;
    if (this.peerPresenceLossTimer) clearTimeout(this.peerPresenceLossTimer);
    this.peerPresenceLossTimer = undefined;
    this.lastRealtimeSignature = "";
    this.localCliSessions = undefined;
    this.localCliSessionsReadAt = 0;
    this.localCliSessionsRead = undefined;
    this.localPeerState = undefined;
    this.localPeerStateRevision = 0;
    this.localPeerStateRead = undefined;
    this.encryptedSync?.setOnlineDeviceIds(undefined);
    for (const [requestId, waiter] of this.peerActionWaiters) {
      waiter({
        type: "peer:action-result",
        requestId,
        status: "failed",
        error: "The dashboard connection was closed."
      });
    }
    this.peerActionWaiters.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async applyConfiguration(): Promise<void> {
    if (this.isEnabled()) {
      await this.start();
      this.restartPeerSocket();
    } else {
      await this.stop();
    }
  }

  private restartPeerSocket(): void {
    this.peerStopped = true;
    this.peerSocket?.close();
    this.peerSocket = undefined;
    if (this.peerReconnectTimer) clearTimeout(this.peerReconnectTimer);
    this.peerReconnectTimer = undefined;
    if (this.peerPublishTimer) clearInterval(this.peerPublishTimer);
    this.peerPublishTimer = undefined;
    if (this.peerHttpHeartbeatTimer) clearInterval(this.peerHttpHeartbeatTimer);
    this.peerHttpHeartbeatTimer = undefined;
    this.peerSessions.clear();
    this.peerLastSeenAt.clear();
    this.peerLastSignedAt.clear();
    for (const timer of this.peerDisconnectTimers.values()) clearTimeout(timer);
    this.peerDisconnectTimers.clear();
    this.peerPresenceAuthoritative = false;
    if (this.peerPresenceLossTimer) clearTimeout(this.peerPresenceLossTimer);
    this.peerPresenceLossTimer = undefined;
    this.encryptedSync?.setOnlineDeviceIds(undefined);
    this.peerStopped = false;
    this.connectPeerSocket();
  }

  async openInBrowser(pathname = "/"): Promise<WebDashboardOpenResult> {
    if (!isWebDashboardPagePath(pathname)) {
      throw new Error("The requested Web Dashboard path is invalid.");
    }
    if (!this.isEnabled()) {
      void vscode.window.showInformationMessage("Web Dashboard setup pending. Enable it in Settings.");
      return "unavailable";
    }
    try {
      await this.start();
      const opened = await vscode.env.openExternal(vscode.Uri.parse(this.getUrl(pathname)));
      if (!opened) {
        void vscode.window.showWarningMessage("The Web Dashboard link was not opened. Try again from the dashboard.");
        return "unavailable";
      }
      return "opened";
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Web Dashboard could not start: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  dispose(): void {
    this.dashboardRealtimeSubscription();
    this.oauth.dispose();
    void this.stop();
  }

  private isEnabled(): boolean {
    const config = getCodexManagerConfiguration();
    return (
      config.get<boolean>("webDashboardEnabled", false) || config.get<boolean>("webDashboardAlwaysOnlineEnabled", false)
    );
  }

  private getUrl(pathname = "/"): string {
    return `http://127.0.0.1:${WEB_DASHBOARD_PORT}${pathname}`;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self' https: data:; frame-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", this.getUrl());
    const path = requestUrl.pathname;
    if (method === "GET" && path === "/workspace/") {
      response.statusCode = 302;
      response.setHeader("Location", "/workspace");
      response.end();
      return;
    }
    if (method === "POST" && path === "/api/peer-heartbeat") {
      const domainConfigured = Boolean(this.settingsStore.getDashboardSettings().cloudflaredDomain?.trim());
      if (!domainConfigured || request.headers["x-codex-peer"] !== "1") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      await this.handlePeerHeartbeatHttp(request, response);
      return;
    }
    // Password verification is the authorization boundary for login. Some
    // Chromium navigation paths serialize a same-page form POST as
    // `Origin: null`; rejecting that opaque value here prevents legitimate
    // users from ever reaching password verification. Authenticated APIs and
    // WebSocket upgrades retain the stricter origin checks below.
    if (method === "POST" && path === "/login") {
      const requestedReturnPath = requestUrl.searchParams.get("returnTo") ?? "/";
      await this.handleLogin(request, response, normalizeWebDashboardReturnPath(requestedReturnPath));
      return;
    }
    const configuredCloudflaredOrigin = normalizeCloudflaredDomain(
      this.settingsStore.getDashboardSettings().cloudflaredDomain ?? ""
    );
    if (method === "POST" && !isTrustedWebDashboardOrigin(request, configuredCloudflaredOrigin || undefined)) {
      response.statusCode = 403;
      if (path.startsWith("/api/")) this.sendJson(response, { error: "Cross-origin dashboard request rejected" });
      else response.end("Forbidden");
      return;
    }
    if (!(await this.isAuthorized(request))) {
      if (path.startsWith("/api/")) {
        response.statusCode = 401;
        this.sendJson(response, { error: "Dashboard session expired" });
        return;
      }
      const returnPath = normalizeWebDashboardReturnPath(path);
      this.sendHtml(response, loginPage(Boolean(await this.encryptedSync?.hasDashboardPassphrase()), "", returnPath));
      return;
    }
    if (method === "GET" && path === "/api/state") {
      await this.sendState(response);
      return;
    }
    if (method === "POST" && path === "/api/message") {
      await this.handleClientMessage(request, response);
      return;
    }
    if (method === "GET" && path.startsWith("/assets/")) {
      await this.sendAsset(path, request, response);
      return;
    }
    if (method === "GET" && isWebDashboardPagePath(path)) {
      this.sendHtml(response, dashboardPage());
      return;
    }
    response.statusCode = 404;
    response.end("Not found");
  }

  private async handleLogin(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    returnPath: string
  ): Promise<void> {
    const ip = request.socket.remoteAddress ?? "local";
    const now = Date.now();
    const attempt = this.loginAttempts.get(ip);
    if (attempt && attempt.resetAt > now && attempt.count >= MAX_LOGIN_ATTEMPTS) {
      response.statusCode = 429;
      response.end("Too many attempts");
      return;
    }
    let body: string;
    try {
      body = await readDashboardRequestBody(request, 4096);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        response.statusCode = 413;
        response.end("Login request too large");
        return;
      }
      throw error;
    }
    const password = new URLSearchParams(body).get("password") ?? "";
    const configured = Boolean(await this.encryptedSync?.hasDashboardPassphrase());
    if (!configured || !(await this.encryptedSync?.verifyDashboardPassphrase(password))) {
      this.loginAttempts.set(ip, {
        count: attempt && attempt.resetAt > now ? attempt.count + 1 : 1,
        resetAt: attempt && attempt.resetAt > now ? attempt.resetAt : now + LOGIN_WINDOW_MS
      });
      response.statusCode = 401;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(loginPage(configured, "Incorrect password.", returnPath));
      return;
    }
    const token = crypto.randomBytes(32).toString("hex");
    await this.rememberSession(token, now + SESSION_TTL_MS);
    response.statusCode = 303;
    const secure = isForwardedHttpsRequest(request) ? "; Secure" : "";
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
    );
    response.setHeader("Location", returnPath);
    response.end();
  }

  private async isAuthorized(request: http.IncomingMessage): Promise<boolean> {
    // The dashboard is bound to loopback, so direct local use does not need a
    // second passphrase prompt. Requests arriving through a forwarded/tunneled
    // connection (for example Cloudflared) are still required to authenticate.
    if (isLocalWebDashboardRequest(request)) return true;
    if (!(await this.encryptedSync?.hasDashboardPassphrase())) return false;
    const cookies = request.headers.cookie ?? "";
    const token = cookies
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${SESSION_COOKIE}=`))
      ?.split("=")[1];
    if (!token) return false;
    return this.isAuthorizedSessionToken(token);
  }

  private async isAuthorizedSessionToken(token: string): Promise<boolean> {
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) return false;
    let expiresAt = this.sessions.get(token);
    if (!expiresAt) {
      const persisted = normalizePersistedWebDashboardSessions(
        await this.context.secrets.get(SESSION_SECRET_KEY),
        Date.now()
      );
      const fingerprint = fingerprintWebDashboardSession(token);
      expiresAt = persisted.find((session) => session.fingerprint === fingerprint)?.expiresAt;
      if (expiresAt) {
        this.sessions.set(token, expiresAt);
      }
    }
    if (!expiresAt || expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  private async rememberSession(token: string, expiresAt: number): Promise<void> {
    this.sessions.set(token, expiresAt);
    const sessions = normalizePersistedWebDashboardSessions(
      await this.context.secrets.get(SESSION_SECRET_KEY),
      Date.now()
    ).filter((session) => session.fingerprint !== fingerprintWebDashboardSession(token));
    sessions.push({ fingerprint: fingerprintWebDashboardSession(token), expiresAt });
    await this.context.secrets.store(SESSION_SECRET_KEY, JSON.stringify(sessions.slice(-MAX_PERSISTED_SESSIONS)));
  }

  private async sendState(response: http.ServerResponse): Promise<void> {
    this.sendJson(response, await this.buildState());
  }

  private async handleClientMessage(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.headers["x-codex-dashboard"] !== "1") {
      response.statusCode = 403;
      response.end("Forbidden");
      return;
    }

    let message: DashboardClientMessage;
    try {
      const parsed = JSON.parse(await readDashboardRequestBody(request, MAX_DASHBOARD_MESSAGE_BYTES)) as unknown;
      if (!isDashboardClientMessage(parsed)) throw new Error("Invalid message");
      message = parsed;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        response.statusCode = 413;
        response.end("Dashboard message too large");
        return;
      }
      response.statusCode = 400;
      response.end("Invalid dashboard message");
      return;
    }

    const { messages, reloadAfterResponse } = await this.processClientMessage(message);
    this.sendJson(response, { messages });
    this.publishProcessedSnapshot(messages);
    if (reloadAfterResponse) {
      scheduleExtensionHostReload((errorMessage) => {
        this.broadcastRealtimeNotice("error", errorMessage);
      });
    }
  }

  /** Publish the newest dashboard state immediately to connected browser clients. */
  publishRealtimeState(): void {
    if (this.webSocketClients.size === 0) {
      // No consumer can observe the cached signature. Clear it so the next
      // connection always builds and receives current state.
      this.lastRealtimeSignature = "";
      return;
    }
    if (this.realtimePublishInFlight) {
      this.realtimePublishQueued = true;
      return;
    }
    this.realtimePublishInFlight = true;
    void this.broadcastRealtimeSnapshot()
      .catch((error) => console.warn("[codexManager] real-time dashboard publish failed", error))
      .finally(() => {
        this.realtimePublishInFlight = false;
        if (this.realtimePublishQueued) {
          this.realtimePublishQueued = false;
          this.publishRealtimeState();
        }
      });
  }

  /** Publish a local account or session change to browsers and online peers. */
  publishLocalStateChange(): void {
    this.publishLocalPeerState();
    void this.publishPeerVault();
    this.publishRealtimeState();
  }

  private startWebSocketHeartbeat(): void {
    if (this.webSocketHeartbeatTimer) return;
    this.webSocketHeartbeatTimer = setInterval(() => {
      const now = Date.now();
      let workspacePresenceChanged = false;
      for (const [socket, lastSeenAt] of this.workspaceViewerLastSeen) {
        if (now - lastSeenAt <= WORKSPACE_VIEWER_LEASE_MS) continue;
        this.workspaceViewerLastSeen.delete(socket);
        workspacePresenceChanged = true;
      }
      if (workspacePresenceChanged) this.refreshCliSessionRealtimeLifecycle();
      for (const socket of this.webSocketServer.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        if (now - (this.webSocketLastPong.get(socket) ?? 0) > 45_000) {
          socket.terminate();
          continue;
        }
        socket.ping();
      }
      let peerPresenceChanged = false;
      for (const [deviceId, lastSeenAt] of this.peerLastSeenAt) {
        if (now - lastSeenAt <= PEER_OFFLINE_AFTER_MS || this.peerSockets.has(deviceId)) continue;
        this.removePeerPresence(deviceId);
        peerPresenceChanged = true;
      }
      if (peerPresenceChanged) {
        this.updateOnlineDevicePresence();
        void this.broadcastPeerAggregate();
        this.publishRealtimeState();
      }
    }, PEER_HEARTBEAT_INTERVAL_MS);
    this.webSocketHeartbeatTimer.unref?.();
  }

  private async processClientMessage(
    message: DashboardClientMessage
  ): Promise<{ messages: DashboardHostMessage[]; reloadAfterResponse: boolean }> {
    const messages: DashboardHostMessage[] = [];
    let reloadAfterResponse = false;
    if (message.type === "dashboard:notification-response") {
      resolveMirroredNotification(message.notificationId, message.action);
      return { messages, reloadAfterResponse };
    }
    if (message.type === "dashboard:action") {
      const targetDeviceId = message.payload?.targetDeviceId;
      if (targetDeviceId && targetDeviceId !== this.deviceId) {
        const relayed = await this.relayPeerAction(message, targetDeviceId);
        messages.push({
          type: "dashboard:action-result",
          requestId: message.requestId,
          action: message.action,
          accountId: message.accountId,
          status: relayed.status,
          payload: relayed.payload as never,
          error: relayed.error
        });
        messages.push({ type: "dashboard:snapshot", state: await this.buildState() });
        return { messages, reloadAfterResponse };
      }
      const collected = await withDashboardNotificationSuppression(async () => {
        const result = await executeDashboardActionMessage(
          {
            context: this.context,
            repo: this.repo,
            resolveLanguage: () => this.settingsStore.resolveLanguage(),
            schedulePublishState: () => undefined,
            publishState: () => Promise.resolve(),
            oauth: this.oauth,
            announcements: this.announcements,
            getAnnouncementOptions: () => this.getAnnouncementOptions(),
            hostKind: "browser",
            configureEncryptedSync: this.encryptedSync
              ? (passphrase, confirmation) => this.encryptedSync!.configure({ passphrase, confirmation })
              : undefined,
            syncEncryptedAccounts: this.encryptedSync ? () => this.encryptedSync!.syncNow(true, false) : undefined,
            setEncryptedSyncRegistryOverride: this.encryptedSync
              ? (enabled, passphrase) => this.encryptedSync!.setRegistryOverrideEnabled(enabled, { passphrase })
              : undefined,
            getRemoteCliSessions: () => this.getRemoteCliSessions()
          },
          message
        );
        return { result, actionPrompts: consumeDashboardActionPrompts() };
      });
      const result = collected.result;
      const payload = collected.actionPrompts.length
        ? { ...(result.payload ?? {}), actionPrompts: collected.actionPrompts }
        : result.payload;
      messages.push({
        type: "dashboard:action-result",
        requestId: message.requestId,
        action: message.action,
        accountId: message.accountId,
        status: result.status,
        payload,
        error: result.errorMessage
      });
      reloadAfterResponse =
        result.status === "completed" && (message.action === "unloadAuth" || result.payload?.reloadScheduled === true);
    } else if (message.type === "dashboard:setting") {
      if (!(await handleDashboardSettingUpdate(message.key, message.value))) {
        throw new Error(`The ${message.key} setting could not be updated.`);
      }
    } else if (message.type === "dashboard:pickCodexAppPath") {
      await pickDashboardCodexAppPath(this.settingsStore);
    } else if (message.type === "dashboard:clearCodexAppPath") {
      await clearDashboardCodexAppPath();
    } else if (message.type === "dashboard:pickCodexCliPath") {
      if (!(await pickDashboardCodexCliPath(this.settingsStore))) {
        messages.push({
          type: "dashboard:notice",
          level: "warning",
          message: "Codex CLI path selection was cancelled."
        });
      }
    } else if (message.type === "dashboard:clearCodexCliPath") {
      await clearDashboardCodexCliPath();
    } else if (message.type === "dashboard:usage-history") {
      await saveDashboardUsageHistory(this.context, message.samples);
    }

    messages.push({ type: "dashboard:snapshot", state: await this.buildState() });
    return { messages, reloadAfterResponse };
  }

  private async relayPeerAction(
    message: Extract<DashboardClientMessage, { type: "dashboard:action" }>,
    targetDeviceId: string
  ): Promise<PeerActionResultMessage> {
    const socket = this.peerSockets.get(targetDeviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const hub = this.peerSocket;
      if (!hub || hub.readyState !== UndiciWebSocket.OPEN) {
        return {
          type: "peer:action-result",
          requestId: message.requestId,
          status: "failed",
          error: "The selected PC is offline."
        };
      }
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.peerActionWaiters.delete(message.requestId);
          resolve({
            type: "peer:action-result",
            requestId: message.requestId,
            status: "failed",
            error: "The selected PC did not respond in time."
          });
        }, 30_000);
        this.peerActionWaiters.set(message.requestId, (result) => {
          clearTimeout(timeout);
          resolve(this.decoratePeerActionResult(result, targetDeviceId));
        });
        hub.send(
          JSON.stringify({
            type: "peer:action",
            requestId: message.requestId,
            action: message.action,
            accountId: message.accountId,
            payload: message.payload
          } satisfies PeerActionMessage)
        );
      });
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve({
          type: "peer:action-result",
          requestId: message.requestId,
          status: "failed",
          error: "The selected PC did not respond in time."
        });
      }, 30_000);
      const onMessage = (data: Buffer): void => {
        try {
          const result = JSON.parse(data.toString()) as PeerActionResultMessage;
          if (result.type !== "peer:action-result" || result.requestId !== message.requestId) return;
          cleanup();
          resolve(this.decoratePeerActionResult(result, targetDeviceId));
        } catch {
          // Ignore unrelated peer traffic.
        }
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.off("message", onMessage);
      };
      socket.on("message", onMessage);
      socket.send(
        JSON.stringify({
          type: "peer:action",
          requestId: message.requestId,
          action: message.action,
          accountId: message.accountId,
          payload: { ...(message.payload ?? {}), targetDeviceId: undefined }
        } satisfies PeerActionMessage)
      );
    });
  }

  private decoratePeerActionResult(result: PeerActionResultMessage, deviceId: string): PeerActionResultMessage {
    if (!result.payload || typeof result.payload !== "object") return result;
    const peer = this.peerSessions.get(deviceId);
    const decorateSession = (session: unknown): unknown => {
      if (!session || typeof session !== "object") return session;
      return { ...session, deviceId, deviceName: peer?.deviceName, remote: true };
    };
    const payload = result.payload as Record<string, unknown>;
    return {
      ...result,
      payload: {
        ...payload,
        ...(Array.isArray(payload["cliSessions"]) ? { cliSessions: payload["cliSessions"].map(decorateSession) } : {}),
        ...(payload["cliSession"] ? { cliSession: decorateSession(payload["cliSession"]) } : {})
      }
    };
  }

  private async handleWebSocketUpgrade(
    request: http.IncomingMessage,
    socket: import("stream").Duplex,
    head: Buffer
  ): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", this.getUrl());
    const isPeer = requestUrl.searchParams.get("peer") === "1";
    const domainConfigured = Boolean(this.settingsStore.getDashboardSettings().cloudflaredDomain?.trim());
    if (
      requestUrl.pathname !== "/ws" ||
      !isTrustedWebDashboardOrigin(
        request,
        normalizeCloudflaredDomain(this.settingsStore.getDashboardSettings().cloudflaredDomain ?? "") || undefined
      ) ||
      (isPeer ? !domainConfigured : !(await this.isAuthorized(request)))
    ) {
      socket.destroy();
      return;
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (client) => {
      this.webSocketServer.emit("connection", client, request);
    });
  }

  private async sendRealtimeSnapshot(socket: WebSocket): Promise<void> {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        const state = await this.buildState();
        this.lastRealtimeSignature = buildDashboardStateSignature(state);
        socket.send(JSON.stringify({ type: "dashboard:snapshot", state }));
      }
    } catch (error) {
      console.warn("[codexManager] WebSocket snapshot failed", error);
      socket.close();
    }
  }

  private startCliSessionWatcher(): void {
    if (this.cliSessionWatcher) return;
    const codexHome = resolveCodexHome();
    if (!fsSync.existsSync(codexHome)) return;
    try {
      this.cliSessionWatcher = fsSync.watch(codexHome, { recursive: true }, (_eventType, filename) => {
        if (!isCliSessionWatchPath(filename)) return;
        if (this.cliSessionChangeTimer) return;
        this.cliSessionChangeTimer = setTimeout(() => {
          this.cliSessionChangeTimer = undefined;
          if (!this.hasWorkspaceViewer()) {
            this.refreshCliSessionRealtimeLifecycle();
            return;
          }
          // File changes are the trigger; the browser remains idle between
          // events and receives the bounded session list over WebSocket.
          this.localCliSessions = undefined;
          this.localCliSessionsReadAt = 0;
          void this.publishCliSessionsRealtime();
          this.publishLocalStateChange();
        }, CLI_SESSION_WATCH_DEBOUNCE_MS);
        this.cliSessionChangeTimer.unref?.();
      });
      this.cliSessionWatcher.on("error", () => {
        this.cliSessionWatcher?.close();
        this.cliSessionWatcher = undefined;
      });
    } catch {
      this.cliSessionWatcher = undefined;
    }
  }

  private startCliSessionReconciliation(): void {
    if (this.cliSessionReconcileTimer) return;
    this.cliSessionReconcileTimer = setInterval(() => {
      if (!this.hasWorkspaceViewer() || !getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false)) {
        this.refreshCliSessionRealtimeLifecycle();
        return;
      }
      if (!this.cliSessionWatcher) this.startCliSessionWatcher();
      void this.publishCliSessionsRealtime();
    }, CLI_SESSION_RECONCILE_MS);
    this.cliSessionReconcileTimer.unref?.();
  }

  private refreshCliSessionRealtimeLifecycle(): void {
    if (!this.hasWorkspaceViewer() || !getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false)) {
      this.stopCliSessionRealtime();
      return;
    }
    this.startCliSessionWatcher();
    this.startCliSessionReconciliation();
    void this.publishCliSessionsRealtime();
  }

  private stopCliSessionRealtime(): void {
    this.cliSessionWatcher?.close();
    this.cliSessionWatcher = undefined;
    if (this.cliSessionChangeTimer) clearTimeout(this.cliSessionChangeTimer);
    this.cliSessionChangeTimer = undefined;
    if (this.cliSessionReconcileTimer) clearInterval(this.cliSessionReconcileTimer);
    this.cliSessionReconcileTimer = undefined;
    this.cliSessionPublish = undefined;
  }

  private hasWorkspaceViewer(): boolean {
    const now = Date.now();
    for (const [socket, lastSeenAt] of this.workspaceViewerLastSeen) {
      if (socket.readyState !== WebSocket.OPEN || now - lastSeenAt > WORKSPACE_VIEWER_LEASE_MS) {
        this.workspaceViewerLastSeen.delete(socket);
      }
    }
    return this.workspaceViewerLastSeen.size > 0;
  }

  private updateWorkspaceViewer(socket: WebSocket, viewing: boolean): void {
    if (viewing) this.workspaceViewerLastSeen.set(socket, Date.now());
    else this.workspaceViewerLastSeen.delete(socket);
    this.refreshCliSessionRealtimeLifecycle();
  }

  private async publishCliSessionsRealtime(): Promise<void> {
    if (this.cliSessionPublish) return this.cliSessionPublish;
    this.cliSessionPublish = this.publishCliSessionsRealtimeCore().finally(() => {
      this.cliSessionPublish = undefined;
    });
    return this.cliSessionPublish;
  }

  private async publishCliSessionsRealtimeCore(): Promise<void> {
    if (!this.hasWorkspaceViewer() || !getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false))
      return;
    const sessions = await this.readLocalCliSessions(true);
    // Keep revisions monotonic across extension-host restarts. An already-open
    // browser page may otherwise reject a fresh revision that restarted at 1.
    const revision = (this.cliSessionRealtimeRevision = Math.max(this.cliSessionRealtimeRevision + 1, Date.now()));
    const message = JSON.stringify({
      type: "dashboard:action-result",
      requestId: `realtime-cli-${Date.now()}`,
      action: "listCodexCliSessions",
      status: "completed",
      payload: { cliSessions: sessions, realtimeRevision: revision }
    } satisfies DashboardHostMessage);
    for (const socket of this.webSocketClients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  private async handleBrowserSocketMessage(raw: string, socket: WebSocket): Promise<void> {
    let message: DashboardClientMessage | undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isDashboardClientMessage(parsed)) throw new Error("Invalid dashboard message.");
      message = parsed;
      if (message.type === "dashboard:workspace-presence") {
        this.updateWorkspaceViewer(socket, message.viewing);
        return;
      }
      const result = await this.processClientMessage(message);
      for (const hostMessage of result.messages) {
        if (hostMessage.type !== "dashboard:snapshot" && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(hostMessage));
        }
      }
      this.publishProcessedSnapshot(result.messages);
      if (result.reloadAfterResponse) {
        scheduleExtensionHostReload((errorMessage) => this.broadcastRealtimeNotice("error", errorMessage));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The dashboard request failed.";
      if (socket.readyState !== WebSocket.OPEN) return;
      if (message?.type === "dashboard:action") {
        socket.send(
          JSON.stringify({
            type: "dashboard:action-result",
            requestId: message.requestId,
            action: message.action,
            accountId: message.accountId,
            status: "failed",
            error: detail
          } satisfies DashboardHostMessage)
        );
      } else {
        socket.send(
          JSON.stringify({ type: "dashboard:notice", level: "error", message: detail } satisfies DashboardHostMessage)
        );
      }
    }
  }

  private async broadcastRealtimeSnapshot(): Promise<void> {
    if (this.webSocketClients.size === 0) return;
    this.broadcastRealtimeState(await this.buildState());
  }

  private publishProcessedSnapshot(messages: readonly DashboardHostMessage[]): void {
    const snapshot = messages.find(
      (message): message is Extract<DashboardHostMessage, { type: "dashboard:snapshot" }> =>
        message.type === "dashboard:snapshot"
    );
    if (snapshot) {
      this.publishLocalPeerState();
      this.broadcastRealtimeState(snapshot.state);
    }
  }

  private broadcastRealtimeState(state: DashboardState): void {
    if (this.webSocketClients.size === 0) {
      this.lastRealtimeSignature = "";
      return;
    }
    const signature = buildDashboardStateSignature(state);
    if (signature === this.lastRealtimeSignature) return;
    this.lastRealtimeSignature = signature;
    const message = JSON.stringify({ type: "dashboard:snapshot", state });
    for (const socket of this.webSocketClients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  private broadcastRealtimeNotice(
    notification: MirroredNotification | "info" | "warning" | "error",
    message?: string
  ): void {
    const payload: MirroredNotification =
      typeof notification === "string" ? { level: notification, message: message ?? "" } : notification;
    const notice = JSON.stringify({ type: "dashboard:notice", ...payload } satisfies DashboardHostMessage);
    for (const socket of this.webSocketClients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(notice);
    }
  }

  private broadcastRealtimeNotificationDismissed(notificationId: string): void {
    const message = JSON.stringify({
      type: "dashboard:notification-dismissed",
      notificationId
    } satisfies DashboardHostMessage);
    for (const socket of this.webSocketClients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  /** Sessions received from other PCs; the local PC always reads its own CLI directly. */
  private getRemoteCliSessions(): import("../domain/dashboard/types").DashboardCliSessionSummary[] {
    return [...this.peerSessions.values()].flatMap((peer) =>
      peer.sessions.map((session) => ({
        ...session,
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        projectPath: session.projectPath,
        remote: true
      }))
    );
  }

  /** Share one bounded session-index read across dashboard and heartbeat consumers. */
  private async readLocalCliSessions(
    force = false
  ): Promise<import("../domain/dashboard/types").DashboardCliSessionSummary[]> {
    if (!getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false)) return [];
    const now = Date.now();
    if (!force && this.localCliSessions && now - this.localCliSessionsReadAt < LOCAL_CLI_SESSION_CACHE_MS) {
      return this.localCliSessions;
    }
    if (this.localCliSessionsRead) return this.localCliSessionsRead;
    // Realtime/peer refreshes only need the session list. Avoid probing the
    // CLI model catalog here; that probe can take seconds when the cache is
    // cold and belongs to the explicit composer-config action instead.
    this.localCliSessionsRead = readCodexCliSessions()
      .then((sessions) => stabilizeSessionProjectPaths(this.context, sessions))
      .catch(() => [])
      .then((sessions) => {
        this.localCliSessions = sessions;
        this.localCliSessionsReadAt = Date.now();
        return sessions;
      })
      .finally(() => {
        this.localCliSessionsRead = undefined;
      });
    return this.localCliSessionsRead;
  }

  private async getConnectedPeers(): Promise<DashboardPeerView[]> {
    const cliEnabled = getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false);
    const localSessionCount = cliEnabled && this.hasWorkspaceViewer() ? (await this.readLocalCliSessions()).length : 0;
    return [
      {
        id: this.deviceId,
        name: os.hostname(),
        sessionCount: localSessionCount,
        connected: true,
        local: true
      },
      ...[...this.peerSessions.values()].map((peer) => ({
        id: peer.deviceId,
        name: peer.deviceName,
        sessionCount: peer.sessions.length,
        connected: true,
        local: false
      }))
    ];
  }

  private updateOnlineDevicePresence(): void {
    this.encryptedSync?.setOnlineDeviceIds(
      this.peerPresenceAuthoritative ? [this.deviceId, ...this.peerSessions.keys()] : undefined
    );
  }

  /** Keep a peer claim alive briefly while its transport reconnects. */
  private deferPeerRemoval(deviceId: string): void {
    const existing = this.peerDisconnectTimers.get(deviceId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.peerDisconnectTimers.delete(deviceId);
      if (this.peerSockets.has(deviceId)) return;
      const lastSeenAt = this.peerLastSeenAt.get(deviceId) ?? 0;
      if (Date.now() - lastSeenAt < PEER_OFFLINE_AFTER_MS) {
        this.deferPeerRemoval(deviceId);
        return;
      }
      this.removePeerPresence(deviceId);
      this.updateOnlineDevicePresence();
      void this.broadcastPeerAggregate();
      this.publishRealtimeState();
    }, PEER_OFFLINE_AFTER_MS);
    timer.unref?.();
    this.peerDisconnectTimers.set(deviceId, timer);
  }

  private removePeerPresence(deviceId: string): void {
    const timer = this.peerDisconnectTimers.get(deviceId);
    if (timer) clearTimeout(timer);
    this.peerDisconnectTimers.delete(deviceId);
    this.peerLastSeenAt.delete(deviceId);
    this.peerSessions.delete(deviceId);
    this.peerLastSignedAt.delete(deviceId);
  }

  private markPeerPresenceHealthy(): void {
    this.peerPresenceAuthoritative = true;
    this.peerHeartbeatFailureReported = false;
    if (this.peerPresenceLossTimer) clearTimeout(this.peerPresenceLossTimer);
    this.peerPresenceLossTimer = undefined;
    this.updateOnlineDevicePresence();
  }

  private markPeerPresenceUnknown(reason: string): void {
    if (this.peerStopped) {
      this.peerPresenceAuthoritative = false;
      this.updateOnlineDevicePresence();
      return;
    }
    // Keep the last confirmed device set during the reconnect grace period.
    // This prevents a transient WebSocket failure from turning every remote
    // claim into an apparent unclaimed account.
    if (this.peerPresenceLossTimer) return;
    this.peerPresenceLossTimer = setTimeout(() => {
      this.peerPresenceLossTimer = undefined;
      this.peerPresenceAuthoritative = false;
      this.updateOnlineDevicePresence();
      void this.encryptedSync
        ?.fenceLocalAccountsAfterPresenceLoss()
        .then((disabled) => {
          if (!disabled?.length) return;
          const message = `${disabled.length} locally enabled account${disabled.length === 1 ? " was" : "s were"} paused because device heartbeat could not be confirmed. Reconnect, then enable the account again.`;
          void vscode.window.showWarningMessage(message);
          this.broadcastRealtimeNotice("warning", message);
          this.publishRealtimeState();
        })
        .catch((error) => console.warn("[codexManager] presence-loss safety fence failed", error));
    }, PEER_OFFLINE_AFTER_MS);
    this.peerPresenceLossTimer.unref?.();
    if (!this.peerHeartbeatFailureReported) {
      this.peerHeartbeatFailureReported = true;
      console.warn(`[codexManager] peer presence is unconfirmed: ${reason}`);
    }
  }

  private async acceptPeerSession(message: Partial<PeerSessionMessage>): Promise<boolean> {
    if (
      message.type !== "peer:sessions" ||
      typeof message.deviceId !== "string" ||
      message.deviceId === this.deviceId ||
      typeof message.deviceName !== "string" ||
      !Array.isArray(message.sessions) ||
      typeof message.sentAt !== "number" ||
      !Number.isFinite(message.sentAt) ||
      typeof message.signature !== "string"
    ) {
      return false;
    }
    if (Math.abs(Date.now() - message.sentAt) > 2 * 60_000) return false;
    const lastSignedAt = this.peerLastSignedAt.get(message.deviceId) ?? 0;
    if (message.sentAt <= lastSignedAt) return false;
    const unsigned = {
      type: "peer:sessions" as const,
      deviceId: message.deviceId,
      deviceName: message.deviceName,
      sessions: message.sessions,
      accounts: Array.isArray(message.accounts) ? message.accounts : [],
      enablementRegistry: Array.isArray(message.enablementRegistry) ? message.enablementRegistry : [],
      sentAt: message.sentAt
    };
    if (
      !(await this.encryptedSync?.verifyRealtimePeerPayload(peerSessionSignaturePayload(unsigned), message.signature))
    ) {
      return false;
    }
    const normalized: PeerSessionMessage = {
      type: "peer:sessions",
      deviceId: message.deviceId.slice(0, 256),
      deviceName: message.deviceName.slice(0, 120),
      sessions: message.sessions
        .slice(0, 100)
        .filter(
          (session) =>
            session &&
            typeof session.id === "string" &&
            typeof session.title === "string" &&
            (session.status === "running" || session.status === "idle")
        ),
      accounts: Array.isArray(message.accounts)
        ? message.accounts
            .slice(0, 100)
            .filter((account) => account && typeof account.id === "string" && typeof account.email === "string")
        : [],
      enablementRegistry: Array.isArray(message.enablementRegistry)
        ? message.enablementRegistry.slice(0, 1_000).filter(isValidSyncAccountEnablement)
        : [],
      sentAt: message.sentAt,
      signature: message.signature
    };
    this.peerSessions.set(normalized.deviceId, normalized);
    const disconnectTimer = this.peerDisconnectTimers.get(normalized.deviceId);
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      this.peerDisconnectTimers.delete(normalized.deviceId);
    }
    recordPeerQuotaChecks(normalized.accounts ?? []);
    this.peerLastSeenAt.set(normalized.deviceId, Date.now());
    this.peerLastSignedAt.set(normalized.deviceId, normalized.sentAt);
    this.markPeerPresenceHealthy();
    if (normalized.enablementRegistry?.length) {
      try {
        await this.encryptedSync?.applyRealtimeEnablementRegistry(normalized.enablementRegistry);
      } catch (error) {
        console.warn("[codexManager] real-time peer enablement merge failed", error);
      }
    }
    return true;
  }

  private async acceptPeerVault(message: Partial<PeerVaultMessage>, sourceSocket?: WebSocket): Promise<boolean> {
    if (
      message.type !== "peer:vault" ||
      typeof message.deviceId !== "string" ||
      message.deviceId === this.deviceId ||
      typeof message.vault !== "string" ||
      message.vault.length > MAX_DASHBOARD_MESSAGE_BYTES ||
      typeof message.sentAt !== "number" ||
      !Number.isFinite(message.sentAt) ||
      typeof message.signature !== "string" ||
      Math.abs(Date.now() - message.sentAt) > 2 * 60_000
    ) return false;
    const unsigned = { type: "peer:vault" as const, deviceId: message.deviceId, sentAt: message.sentAt, vault: message.vault };
    if (!(await this.encryptedSync?.verifyRealtimePeerPayload(peerVaultSignaturePayload(unsigned), message.signature))) {
      return false;
    }
    await this.encryptedSync?.applyRealtimeEncryptedVault(message.vault);
    // A dashboard host can have several peer PCs connected. Relay the
    // authenticated ciphertext event so one source change reaches the whole
    // connected peer set without another Settings Sync request.
    const serialized = JSON.stringify(message);
    for (const socket of this.peerSockets.values()) {
      if (socket === sourceSocket || !this.authenticatedPeerSockets.has(socket) || socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      socket.send(serialized);
    }
    this.publishRealtimeState();
    return true;
  }

  private async handlePeerHeartbeatHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let parsed: Partial<PeerSessionMessage>;
    try {
      parsed = JSON.parse(
        await readDashboardRequestBody(request, MAX_DASHBOARD_MESSAGE_BYTES)
      ) as Partial<PeerSessionMessage>;
    } catch {
      response.statusCode = 400;
      response.end("Invalid heartbeat");
      return;
    }
    if (!(await this.acceptPeerSession(parsed))) {
      response.statusCode = 400;
      response.end("Invalid heartbeat");
      return;
    }
    await this.broadcastPeerAggregate();
    this.publishRealtimeState();
    this.sendJson(response, {
      type: "peer:aggregate",
      peers: [await this.readLocalPeerSessions(), ...this.peerSessions.values()]
    } satisfies PeerAggregateMessage);
  }

  private async handlePeerMessage(raw: string, sourceSocket: WebSocket): Promise<void> {
    try {
      const message = JSON.parse(raw) as Partial<PeerSessionMessage> & Partial<PeerVaultMessage> & Partial<PeerActionMessage>;
      if (message.type === "peer:vault") {
        await this.acceptPeerVault(message, sourceSocket);
        return;
      }
      if (message.type === "peer:action") {
        if (!this.authenticatedPeerSockets.has(sourceSocket)) return;
        if (message.payload?.targetDeviceId && message.payload.targetDeviceId !== this.deviceId) {
          void this.relayPeerAction(
            message as unknown as Extract<DashboardClientMessage, { type: "dashboard:action" }>,
            message.payload.targetDeviceId
          ).then((result) => sourceSocket.send(JSON.stringify(result)));
        } else {
          void this.handlePeerAction(message, sourceSocket);
        }
        return;
      }
      if (message.type === "peer:action-result" && typeof message.requestId === "string") {
        if (!this.authenticatedPeerSockets.has(sourceSocket)) return;
        const waiter = this.peerActionWaiters.get(message.requestId);
        if (waiter) {
          this.peerActionWaiters.delete(message.requestId);
          waiter(message as unknown as PeerActionResultMessage);
        }
        return;
      }
      if (!(await this.acceptPeerSession(message))) return;
      this.authenticatedPeerSockets.add(sourceSocket);
      this.peerSockets.set(message.deviceId!, sourceSocket);
      await this.sendPeerAggregate(sourceSocket);
      void this.broadcastPeerAggregate();
      this.publishRealtimeState();
    } catch {
      // Ignore malformed peer messages; the next publish will repair the view.
    }
  }

  private async sendPeerAggregate(socket: WebSocket): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) return;
    const local = await this.readLocalPeerSessions();
    socket.send(
      JSON.stringify({
        type: "peer:aggregate",
        peers: [local, ...this.peerSessions.values()]
      } satisfies PeerAggregateMessage)
    );
  }

  private async broadcastPeerAggregate(): Promise<void> {
    const local = await this.readLocalPeerSessions();
    const message = JSON.stringify({
      type: "peer:aggregate",
      peers: [local, ...this.peerSessions.values()]
    } satisfies PeerAggregateMessage);
    for (const socket of this.peerSockets.values()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  private invalidateLocalPeerState(): void {
    this.localPeerState = undefined;
    this.localPeerStateRevision += 1;
  }

  private publishLocalPeerState(): void {
    this.invalidateLocalPeerState();
    void this.publishPeerSessions();
    if (this.peerSockets.size > 0) void this.broadcastPeerAggregate();
  }

  private async readLocalPeerState(): Promise<LocalPeerState> {
    if (this.localPeerState) return this.localPeerState;
    const revision = this.localPeerStateRevision;
    const pending = (this.localPeerStateRead ??= (async () => {
      const enabled = getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false);
      const [sessions, dashboard] = await Promise.all([
        enabled ? this.readLocalCliSessions() : Promise.resolve([]),
        this.announcements
          .getState(this.getAnnouncementOptions())
          .then((announcements) =>
            buildDashboardState(this.repo, this.settingsStore, "/assets/codex.svg", announcements)
          )
      ]);
      return {
        revision,
        state: {
          sessions,
          accounts: dashboard.accounts,
          enablementRegistry: this.encryptedSync?.getRealtimeEnablementRegistry() ?? []
        }
      };
    })());
    let result: Awaited<typeof pending>;
    try {
      result = await pending;
    } finally {
      if (this.localPeerStateRead === pending) this.localPeerStateRead = undefined;
    }
    if (result.revision !== this.localPeerStateRevision) return this.readLocalPeerState();
    this.localPeerState = result.state;
    return result.state;
  }

  private async readLocalPeerSessions(): Promise<PeerSessionMessage> {
    const state = await this.readLocalPeerState();
    this.lastPeerSentAt = Math.max(Date.now(), this.lastPeerSentAt + 1);
    const unsigned: Omit<PeerSessionMessage, "signature"> = {
      type: "peer:sessions",
      deviceId: this.deviceId,
      deviceName: os.hostname(),
      sessions: state.sessions,
      accounts: state.accounts,
      enablementRegistry: state.enablementRegistry,
      sentAt: this.lastPeerSentAt
    };
    return {
      ...unsigned,
      signature: await this.encryptedSync?.signRealtimePeerPayload(peerSessionSignaturePayload(unsigned))
    };
  }

  private async handlePeerAction(message: Partial<PeerActionMessage>, socket: WebSocket): Promise<void> {
    await this.executePeerAction(message, (value) => socket.send(value));
  }

  private async executePeerAction(message: Partial<PeerActionMessage>, send: (value: string) => void): Promise<void> {
    if (typeof message.requestId !== "string" || typeof message.action !== "string") return;
    try {
      const result = await executeDashboardActionMessage(
        {
          context: this.context,
          repo: this.repo,
          resolveLanguage: () => this.settingsStore.resolveLanguage(),
          schedulePublishState: () => undefined,
          publishState: () => Promise.resolve(),
          oauth: this.oauth,
          announcements: this.announcements,
          getAnnouncementOptions: () => this.getAnnouncementOptions(),
          hostKind: "browser",
          configureEncryptedSync: this.encryptedSync
            ? (passphrase, confirmation) => this.encryptedSync!.configure({ passphrase, confirmation })
            : undefined,
          syncEncryptedAccounts: this.encryptedSync ? () => this.encryptedSync!.syncNow(true, false) : undefined
        },
        {
          type: "dashboard:action",
          requestId: message.requestId,
          action: message.action as never,
          accountId: message.accountId,
          payload: message.payload
        }
      );
      send(
        JSON.stringify({
          type: "peer:action-result",
          requestId: message.requestId,
          status: result.status,
          payload: result.payload,
          error: result.errorMessage
        } satisfies PeerActionResultMessage)
      );
      if (
        result.status === "completed" &&
        (message.action === "unloadAuth" || result.payload?.reloadScheduled === true)
      ) {
        scheduleExtensionHostReload(
          (errorMessage) => {
            this.broadcastRealtimeNotice("error", errorMessage);
          },
          150,
          message.action === "switch" ? "The account switched" : "Codex auth was unloaded"
        );
      }
    } catch (error) {
      send(
        JSON.stringify({
          type: "peer:action-result",
          requestId: message.requestId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        } satisfies PeerActionResultMessage)
      );
    }
  }

  private connectPeerSocket(): void {
    const configuredDomain = this.settingsStore.getDashboardSettings().cloudflaredDomain?.trim();
    const alwaysOnline = getCodexManagerConfiguration().get<boolean>("webDashboardAlwaysOnlineEnabled", false);
    const domain = configuredDomain || (alwaysOnline ? `http://127.0.0.1:${WEB_DASHBOARD_PORT}` : "");
    if (this.peerStopped || !domain || this.peerSocket) return;
    let endpoint: URL;
    try {
      endpoint = new URL(domain);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      endpoint.pathname = "/ws";
      endpoint.search = new URLSearchParams({ peer: "1", deviceId: this.deviceId }).toString();
    } catch {
      return;
    }
    const socket = new UndiciWebSocket(endpoint);
    this.peerSocket = socket;
    this.startPeerHttpHeartbeat();
    socket.addEventListener("open", () => {
      void (async () => {
        await this.publishPeerSessions();
        await this.publishPeerVault();
      })();
      if (this.peerHttpHeartbeatTimer) clearInterval(this.peerHttpHeartbeatTimer);
      this.peerHttpHeartbeatTimer = undefined;
      this.peerPublishTimer = setInterval(() => void this.publishPeerSessions(), PEER_HEARTBEAT_INTERVAL_MS);
    });
    socket.addEventListener("message", (event) => {
      void (async () => {
        try {
          const message = JSON.parse(String(event.data)) as Partial<PeerActionMessage> &
            Partial<PeerAggregateMessage> &
            Partial<PeerActionResultMessage>;
          if (message.type === "peer:action") void this.executePeerAction(message, (value) => socket.send(value));
          if (message.type === "peer:action-result" && typeof message.requestId === "string") {
            const waiter = this.peerActionWaiters.get(message.requestId);
            if (waiter) {
              this.peerActionWaiters.delete(message.requestId);
              waiter(message as unknown as PeerActionResultMessage);
            }
          }
          if (message.type === "peer:aggregate" && Array.isArray(message.peers)) {
            this.peerSessions.clear();
            this.peerLastSeenAt.clear();
            this.peerLastSignedAt.clear();
            for (const peer of message.peers) {
              await this.acceptPeerSession(peer);
            }
            this.markPeerPresenceHealthy();
            this.publishRealtimeState();
          }
        } catch {
          // Ignore malformed peer messages.
        }
      })();
    });
    socket.addEventListener("close", () => {
      if (this.peerSocket === socket) this.peerSocket = undefined;
      if (this.peerPublishTimer) clearInterval(this.peerPublishTimer);
      this.peerPublishTimer = undefined;
      this.markPeerPresenceUnknown("WebSocket heartbeat disconnected");
      for (const [requestId, waiter] of this.peerActionWaiters) {
        waiter({
          type: "peer:action-result",
          requestId,
          status: "failed",
          error: "The peer WebSocket disconnected before the selected PC responded."
        });
      }
      this.peerActionWaiters.clear();
      if (this.peerStopped) return;
      this.startPeerHttpHeartbeat();
      if (!this.peerReconnectTimer) {
        this.peerReconnectTimer = setTimeout(() => {
          this.peerReconnectTimer = undefined;
          this.connectPeerSocket();
        }, PEER_RECONNECT_DELAY_MS);
        this.peerReconnectTimer.unref?.();
      }
    });
    // Undici closes a socket as part of dispatching its error event. Calling
    // close() from this callback re-enters failWebsocketConnection and can
    // recurse until the extension host reports "Maximum call stack size
    // exceeded". Let the paired close event perform cleanup/reconnect.
    socket.addEventListener("error", () => undefined);
  }

  private async publishPeerSessions(): Promise<void> {
    if (this.peerPublishInFlight) {
      this.peerPublishQueued = true;
      return this.peerPublishInFlight;
    }
    const task = this.publishPeerSessionsCore();
    this.peerPublishInFlight = task;
    try {
      await task;
    } catch (error) {
      console.warn("[codexManager] peer heartbeat publish failed", error);
    } finally {
      if (this.peerPublishInFlight === task) this.peerPublishInFlight = undefined;
      if (this.peerPublishQueued) {
        this.peerPublishQueued = false;
        void this.publishPeerSessions();
      }
    }
  }

  private async publishPeerSessionsCore(): Promise<void> {
    const socket = this.peerSocket;
    if (!socket || socket.readyState !== UndiciWebSocket.OPEN) return;
    socket.send(JSON.stringify((await this.readLocalPeerSessions()) satisfies PeerSessionMessage));
  }

  private async publishPeerVault(): Promise<void> {
    const socket = this.peerSocket;
    if (!socket || socket.readyState !== UndiciWebSocket.OPEN) return;
    const vault = await this.encryptedSync?.getRealtimeEncryptedVault();
    if (!vault || vault === this.lastPublishedPeerVault) return;
    const unsigned = { type: "peer:vault" as const, deviceId: this.deviceId, sentAt: Date.now(), vault };
    const signature = await this.encryptedSync?.signRealtimePeerPayload(peerVaultSignaturePayload(unsigned));
    if (!signature) return;
    socket.send(JSON.stringify({ ...unsigned, signature } satisfies PeerVaultMessage));
    this.lastPublishedPeerVault = vault;
  }

  private startPeerHttpHeartbeat(): void {
    if (this.peerStopped || this.peerHttpHeartbeatTimer) return;
    void this.publishPeerHeartbeatHttp();
    this.peerHttpHeartbeatTimer = setInterval(() => void this.publishPeerHeartbeatHttp(), PEER_HEARTBEAT_INTERVAL_MS);
    this.peerHttpHeartbeatTimer.unref?.();
  }

  private async publishPeerHeartbeatHttp(): Promise<void> {
    if (this.peerHttpHeartbeatInFlight) return this.peerHttpHeartbeatInFlight;
    const task = this.publishPeerHeartbeatHttpCore();
    this.peerHttpHeartbeatInFlight = task;
    try {
      await task;
    } finally {
      if (this.peerHttpHeartbeatInFlight === task) this.peerHttpHeartbeatInFlight = undefined;
    }
  }

  private async publishPeerHeartbeatHttpCore(): Promise<void> {
    if (this.peerSocket?.readyState === UndiciWebSocket.OPEN) return;
    const configuredDomain = this.settingsStore.getDashboardSettings().cloudflaredDomain?.trim();
    const alwaysOnline = getCodexManagerConfiguration().get<boolean>("webDashboardAlwaysOnlineEnabled", false);
    const domain = configuredDomain || (alwaysOnline ? `http://127.0.0.1:${WEB_DASHBOARD_PORT}` : "");
    if (!domain) {
      this.peerPresenceAuthoritative = false;
      this.encryptedSync?.setOnlineDeviceIds(undefined);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PEER_HTTP_HEARTBEAT_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const endpoint = new URL("/api/peer-heartbeat", domain);
      const response = await undiciFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Codex-Peer": "1" },
        body: JSON.stringify(await this.readLocalPeerSessions()),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Peer heartbeat failed (${response.status}).`);
      const aggregate = (await response.json()) as Partial<PeerAggregateMessage>;
      if (aggregate.type !== "peer:aggregate" || !Array.isArray(aggregate.peers)) {
        throw new Error("Peer heartbeat returned an invalid response.");
      }
      this.peerSessions.clear();
      this.peerLastSeenAt.clear();
      this.peerLastSignedAt.clear();
      for (const peer of aggregate.peers) await this.acceptPeerSession(peer);
      this.markPeerPresenceHealthy();
      this.publishRealtimeState();
    } catch (error) {
      this.markPeerPresenceUnknown(error instanceof Error ? error.message : "HTTP heartbeat unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async buildState() {
    if (this.stateBuildInFlight) return this.stateBuildInFlight;
    const pending = this.buildStateInternal().finally(() => {
      if (this.stateBuildInFlight === pending) this.stateBuildInFlight = undefined;
    });
    this.stateBuildInFlight = pending;
    return pending;
  }

  private async buildStateInternal(): Promise<DashboardState> {
    const state = await buildDashboardState(
      this.repo,
      this.settingsStore,
      "/assets/codex.svg",
      await this.announcements.getState(this.getAnnouncementOptions()),
      await this.getConnectedPeers()
    );
    return {
      ...state,
      usageHistory: await appendDashboardUsageSnapshot(this.context, state),
      dailyUsageCache: readDashboardDailyUsageCache(this.context),
      peerAccounts: Object.fromEntries(
        [...this.peerSessions.values()].map((peer) => [peer.deviceId, peer.accounts ?? []])
      )
    };
  }

  private getAnnouncementOptions(): AnnouncementOptions {
    const packageJson = this.context.extension.packageJSON as { version?: string };
    return {
      version: packageJson.version ?? "0.0.0",
      locale: this.settingsStore.resolveLanguage()
    };
  }

  private async sendAsset(
    requestPath: string,
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const asset = WEB_DASHBOARD_ASSETS[requestPath];
    if (!asset) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    try {
      let cached = this.assetCache.get(requestPath);
      if (!cached) {
        const content = await fs.readFile(path.join(this.context.extensionUri.fsPath, ...asset.parts));
        cached = {
          content,
          gzip: gzipSync(content, { level: 6 }),
          etag: `"${crypto.createHash("sha256").update(content).digest("hex").slice(0, 20)}"`
        };
        this.assetCache.set(requestPath, cached);
      }
      response.setHeader("Content-Type", asset.contentType);
      response.setHeader("Cache-Control", "private, max-age=300");
      response.setHeader("ETag", cached.etag);
      if (request.headers["if-none-match"] === cached.etag) {
        response.statusCode = 304;
        response.end();
        return;
      }
      response.setHeader("Vary", "Accept-Encoding");
      if (/\bgzip\b/i.test(request.headers["accept-encoding"] ?? "")) {
        response.setHeader("Content-Encoding", "gzip");
        response.end(cached.gzip);
      } else {
        response.end(cached.content);
      }
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  }

  private sendHtml(response: http.ServerResponse, html: string): void {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
  }

  private sendJson(response: http.ServerResponse, value: unknown): void {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value));
  }
}

class RequestBodyTooLargeError extends Error {}

export interface PersistedWebDashboardSession {
  fingerprint: string;
  expiresAt: number;
}

export function fingerprintWebDashboardSession(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function normalizePersistedWebDashboardSessions(
  value: string | undefined,
  now = Date.now()
): PersistedWebDashboardSession[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is PersistedWebDashboardSession => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Partial<PersistedWebDashboardSession>;
        return (
          typeof candidate.fingerprint === "string" &&
          /^[a-f0-9]{64}$/.test(candidate.fingerprint) &&
          typeof candidate.expiresAt === "number" &&
          Number.isFinite(candidate.expiresAt) &&
          candidate.expiresAt > now
        );
      })
      .slice(-MAX_PERSISTED_SESSIONS);
  } catch {
    return [];
  }
}

export function isWebDashboardPagePath(pathname: string): boolean {
  return pathname === "/" || pathname === "/dash" || pathname === "/workspace" || /^\/[0-9a-f-]{36}$/i.test(pathname);
}

export function normalizeWebDashboardReturnPath(pathname: string): string {
  return isWebDashboardPagePath(pathname) ? pathname : "/";
}

export function readDashboardRequestBody(request: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) {
        return;
      }
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        finish(() => reject(new RequestBodyTooLargeError("Request body too large")));
      }
    });
    request.on("end", () => finish(() => resolve(body)));
    request.on("error", (error) => finish(() => reject(error)));
    request.on("aborted", () => finish(() => reject(new Error("Request aborted"))));
  });
}

function loginPage(configured: boolean, error = "", returnPath = "/"): string {
  const action = `/login?returnTo=${encodeURIComponent(normalizeWebDashboardReturnPath(returnPath))}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#111827"><title>Codex Manager</title><link rel="icon" href="/assets/codex.svg" type="image/svg+xml"><style>${BASE_CSS}</style></head><body><main class="login"><h1>Codex Manager</h1>${configured ? `<p id="login-hint">Enter your Codex Manager password.</p><form method="post" action="${action}"><label for="dashboard-password">Password</label><input id="dashboard-password" name="password" type="password" autocomplete="current-password" aria-describedby="login-hint" autofocus required><button type="submit">Unlock dashboard</button></form>${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}` : `<p>Access is locked until a password is set in General settings.</p>`}</main></body></html>`;
}

function dashboardPage(): string {
  return `<!DOCTYPE html><html lang="en" data-theme="auto" data-dashboard-host="browser"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0d1117"><title>Codex Manager</title><link rel="icon" href="/assets/codex.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/shared.css"><link rel="stylesheet" href="/assets/dashboard.css"></head><body><div id="app"></div><script src="/assets/browserHost.js"></script><script src="/assets/dashboard.js"></script></body></html>`;
}

const BASE_CSS = `:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111827;color:#edf2ff}body{margin:0;background:#111827}main{max-width:1100px;margin:0 auto;padding:28px 20px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}h1{font-size:22px;margin:0;text-wrap:balance}label{display:block;margin-top:18px;font-size:14px;font-weight:700}button{border:0;border-radius:8px;padding:10px 14px;background:#4f8cff;color:#fff;font-weight:700;cursor:pointer;touch-action:manipulation}button:hover{background:#6aa0ff}button:focus-visible,input:focus-visible{outline:2px solid #8bb8ff;outline-offset:3px}input{display:block;width:100%;box-sizing:border-box;padding:11px;border-radius:8px;border:1px solid #43516d;background:#1b2537;color:#fff;margin:8px 0 12px}.login{max-width:380px;margin:12vh auto}.login p{color:#a8b3c9;line-height:1.5}.error{color:#ff8c9b;margin-top:12px}`;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character
  );
}

function isDashboardClientMessage(value: unknown): value is DashboardClientMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  switch (candidate["type"]) {
    case "dashboard:ready":
    case "dashboard:pickCodexAppPath":
    case "dashboard:clearCodexAppPath":
    case "dashboard:pickCodexCliPath":
    case "dashboard:clearCodexCliPath":
      return true;
    case "dashboard:workspace-presence":
      return typeof candidate["viewing"] === "boolean";
    case "dashboard:usage-history":
      return Array.isArray(candidate["samples"]) && candidate["samples"].length <= 10_000;
    case "dashboard:action":
      return (
        typeof candidate["requestId"] === "string" &&
        candidate["requestId"].length <= 256 &&
        typeof candidate["action"] === "string" &&
        candidate["action"].length <= 128
      );
    case "dashboard:setting":
      return (
        typeof candidate["key"] === "string" &&
        candidate["key"].length <= 128 &&
        ["string", "number", "boolean"].includes(typeof candidate["value"])
      );
    case "dashboard:notification-response":
      return typeof candidate["notificationId"] === "string" && candidate["notificationId"].length <= 128;
    default:
      return false;
  }
}

export function isAddressInUseError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

export function isForwardedHttpsRequest(request: Pick<http.IncomingMessage, "headers">): boolean {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const value = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  if (value?.split(",")[0]?.trim().toLowerCase() === "https") {
    return true;
  }

  const cfVisitor = request.headers["cf-visitor"];
  const visitorValue = Array.isArray(cfVisitor) ? cfVisitor[0] : cfVisitor;
  if (!visitorValue) {
    return false;
  }
  try {
    return (JSON.parse(visitorValue) as { scheme?: unknown }).scheme === "https";
  } catch {
    return false;
  }
}

/**
 * Returns true for direct requests addressed to the loopback dashboard host.
 * Forwarding headers prevent a Cloudflared (or other reverse-proxy) request
 * from being mistaken for local access even when its origin host is localhost.
 */
export function isLocalWebDashboardRequest(request: Pick<http.IncomingMessage, "headers">): boolean {
  const headers = request.headers;
  const forwarded = ["x-forwarded-proto", "x-forwarded-for", "cf-visitor", "cf-ray", "cf-connecting-ip"].some(
    (name) => headers[name] !== undefined
  );
  if (forwarded) return false;

  const hostHeader = headers.host;
  if (hostHeader) {
    try {
      const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    } catch {
      return false;
    }
  }

  // A Host header is required for normal HTTP/1.1 requests. If it is absent,
  // keep the request behind authentication rather than trusting only the
  // peer address (a tunnel can also connect from loopback).
  return false;
}

/** Reject browser requests whose Origin does not match the addressed dashboard. */
export function isTrustedWebDashboardOrigin(
  request: Pick<http.IncomingMessage, "headers">,
  configuredCloudflaredOrigin?: string
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (Array.isArray(origin) || origin === "null") return false;
  const forwardedHost = request.headers["x-forwarded-host"];
  const rawHost = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host;
  const host = rawHost?.split(",", 1)[0]?.trim();
  if (!host) return false;
  try {
    const expected = new URL(`${isForwardedHttpsRequest(request) ? "https" : "http"}://${host}`).origin;
    const supplied = new URL(origin);
    if (supplied.username || supplied.password) return false;
    // Cloudflared normally preserves the public Host header, but a service
    // ingress can forward localhost instead. The configured public origin is
    // an explicit allow-list entry for that proxy path and avoids rejecting
    // the login POST when the forwarded host/protocol is rewritten.
    if (supplied.origin === expected || supplied.origin === configuredCloudflaredOrigin) return true;

    // A Cloudflare Tunnel can rewrite both Host and forwarded protocol at the
    // local service boundary. Fetch Metadata is browser-controlled, so a
    // forwarded same-origin navigation or WebSocket remains safe to accept
    // even when those proxy headers no longer describe the public hostname.
    // Cross-site browser requests still fail this check.
    const fetchSite = request.headers["sec-fetch-site"];
    return supplied.protocol === "https:" && fetchSite === "same-origin" && isForwardedWebDashboardRequest(request);
  } catch {
    return false;
  }
}

function isForwardedWebDashboardRequest(request: Pick<http.IncomingMessage, "headers">): boolean {
  return ["x-forwarded-proto", "x-forwarded-host", "x-forwarded-for", "cf-visitor", "cf-ray", "cf-connecting-ip"].some(
    (name) => request.headers[name] !== undefined
  );
}

export { WEB_DASHBOARD_PORT };
