import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type * as vscode from "vscode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { DashboardAuth, DASHBOARD_PASSPHRASE_KEY } from "../src/services/dashboardAuth";
import { WebDashboardServer, fingerprintWebDashboardSession } from "../src/services/webDashboardServer";
import { removeTestDirectory } from "./testFilesystem";

let root: string;
let store: SqliteStateStore;
let secrets: Map<string, string>;
let storage: vscode.SecretStorage;
const source = { hasDashboardPassphrase: vi.fn(), verifyDashboardPassphrase: vi.fn(), getDashboardPassphraseFingerprint: vi.fn() };
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-dashboard-auth-"));
  vi.stubEnv("CODEX_MANAGER_STORAGE_ROOT", root);
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
  secrets = new Map([[DASHBOARD_PASSPHRASE_KEY, "same protected password"]]);
  storage = { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); } } as vscode.SecretStorage;
});
afterEach(async () => {
  configureSqliteStateStore(undefined);
  store.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await removeTestDirectory(root);
});

it("preserves existing browser login and the same password across both hosts and database reopen", async () => {
  const token = "a".repeat(64);
  const sessions = JSON.stringify([{ fingerprint: fingerprintWebDashboardSession(token), expiresAt: Date.now() + 60_000 }]);
  secrets.set("codexManager.webDashboard.sessions.v1", sessions);
  const extension = new DashboardAuth(storage, source);
  await extension.refresh();
  const fingerprint = await extension.getDashboardPassphraseFingerprint();
  expect(JSON.stringify(store.get("dashboard-auth", "credential"))).not.toContain(secrets.get(DASHBOARD_PASSPHRASE_KEY));
  store.close();
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
  const node = new DashboardAuth({ get: vi.fn(async () => undefined) } as never);
  await expect(node.hasDashboardPassphrase()).resolves.toBe(true);
  await expect(node.verifyDashboardPassphrase("same protected password")).resolves.toBe(true);
  await expect(node.verifyDashboardPassphrase("wrong")).resolves.toBe(false);
  await expect(node.readSessions()).resolves.toBe(sessions);
  await expect(new DashboardAuth(storage, source).getDashboardPassphraseFingerprint()).resolves.toBe(fingerprint);
  const server = new WebDashboardServer({ extensionUri: { fsPath: "extension" }, secrets: storage } as never, {} as never);
  try {
    await expect((server as any).isAuthorized({ headers: { host: "dashboard.example", "cf-ray": "tunnel", cookie: `codex_dashboard_session=${token}` }, socket: { remoteAddress: "127.0.0.1" } })).resolves.toBe(true);
  } finally { server.dispose(); }
});

it("allows fresh remote login in standalone and persists logout for the next VS Code owner", async () => {
  await new DashboardAuth(storage, source).refresh();
  const server = new WebDashboardServer({ extensionUri: { fsPath: "extension" }, secrets: storage } as never, {} as never);
  const headers = new Map<string, string>();
  const response = { statusCode: 200, setHeader: (key: string, value: string) => headers.set(key, value), end: vi.fn() };
  const request = Object.assign(new EventEmitter(), { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-proto": "https" }, setEncoding: vi.fn() });
  try {
    const pending = (server as any).handleLogin(request, response, "/workspace");
    request.emit("data", "password=same+protected+password"); request.emit("end");
    await pending;
    expect(response.statusCode).toBe(303);
    const cookie = headers.get("Set-Cookie")!;
    expect(cookie).toContain("HttpOnly; SameSite=Strict");
    expect(cookie).toContain("Secure");
    const token = cookie.split(";")[0]!.split("=")[1]!;
    await expect((server as any).isAuthorizedSessionToken(token)).resolves.toBe(true);
    await (server as any).forgetSession(token);
    await new DashboardAuth(storage, source).refresh();
    await expect((server as any).isAuthorizedSessionToken(token)).resolves.toBe(false);
  } finally { server.dispose(); }
});

it("revokes sessions on password rotation or removal and never resurrects legacy sessions", async () => {
  const extension = new DashboardAuth(storage, source);
  await extension.refresh();
  const old = await extension.getDashboardPassphraseFingerprint();
  await extension.writeSessions("[]", old);
  secrets.set(DASHBOARD_PASSPHRASE_KEY, "replacement protected password");
  await extension.refresh();
  const node = new DashboardAuth(storage);
  await expect(node.readSessions()).resolves.toBeUndefined();
  await expect(node.verifyDashboardPassphrase("same protected password")).resolves.toBe(false);
  await expect(node.verifyDashboardPassphrase("replacement protected password")).resolves.toBe(true);
  await expect(node.writeSessions("[]", old)).rejects.toThrow("changed during sign-in");
  secrets.delete(DASHBOARD_PASSPHRASE_KEY);
  await extension.refresh();
  await expect(node.hasDashboardPassphrase()).resolves.toBe(false);
  secrets.set(DASHBOARD_PASSPHRASE_KEY, "same protected password");
  secrets.set("codexManager.webDashboard.sessions.v1", "stale legacy sessions");
  await new DashboardAuth(storage, source).refresh();
  await expect(node.readSessions()).resolves.toBeUndefined();
});

it("preserves committed authentication when storage is full, then retries successfully", async () => {
  const extension = new DashboardAuth(storage, source);
  await extension.refresh();
  await extension.writeSessions("[]");
  const previous = store.get("dashboard-auth", "credential");
  secrets.set(DASHBOARD_PASSPHRASE_KEY, "new password");
  const original = store.set.bind(store);
  const write = vi.spyOn(store, "set").mockImplementation((namespace, key, value) => {
    if (namespace === "dashboard-auth" && key === "credential") throw new Error("SQLITE_FULL");
    original(namespace, key, value);
  });
  await expect(extension.refresh()).rejects.toThrow("SQLITE_FULL");
  expect(store.get("dashboard-auth", "credential")).toEqual(previous);
  expect(store.get("dashboard-auth", "sessions")).toBe("[]");
  write.mockRestore();
  await extension.refresh();
  await expect(new DashboardAuth(storage).verifyDashboardPassphrase("new password")).resolves.toBe(true);
});

it("fails closed on corrupt standalone credentials and repairs them from the trusted VS Code secret", async () => {
  store.set("dashboard-auth", "credential", { hash: "bad" });
  await expect(new DashboardAuth(storage).hasDashboardPassphrase()).rejects.toThrow("invalid");
  await expect(new DashboardAuth(storage).verifyDashboardPassphrase("anything")).rejects.toThrow("invalid");
  await new DashboardAuth(storage, source).refresh();
  await expect(new DashboardAuth(storage).verifyDashboardPassphrase("same protected password")).resolves.toBe(true);
});

it("closes a live standalone browser socket when a different owner revokes its login in SQLite", async () => {
  const extension = new DashboardAuth(storage, source);
  await extension.refresh();
  const token = "b".repeat(64), fingerprint = fingerprintWebDashboardSession(token), expiresAt = Date.now() + 60_000;
  await extension.writeSessions(JSON.stringify([{ fingerprint, expiresAt }]));
  const server = new WebDashboardServer({ extensionUri: { fsPath: "extension" }, secrets: storage } as never, {} as never);
  const socket = { readyState: 1, close: vi.fn() };
  const internal = server as any;
  try {
    internal.webSocketClients.add(socket);
    internal.browserSocketSessionFingerprint.set(socket, fingerprint);
    internal.browserSocketPassphraseFingerprint.set(socket, await extension.getDashboardPassphraseFingerprint());
    internal.browserSocketExpiresAt.set(socket, expiresAt);
    await internal.closeInvalidRemoteBrowserSockets();
    expect(socket.close).not.toHaveBeenCalled();
    const foreign = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
    try { foreign.set("dashboard-auth", "sessions", "[]"); } finally { foreign.close(); }
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledWith(4001, "Dashboard session expired"));
  } finally { internal.webSocketClients.delete(socket); server.dispose(); }
});

it("bounds simultaneous password checks and releases capacity after failed sign-in", async () => {
  const server = new WebDashboardServer({ extensionUri: { fsPath: "extension" }, secrets: storage } as never, {} as never);
  const internal = server as any;
  const releases: Array<(valid: boolean) => void> = [];
  internal.auth = {
    getDashboardPassphraseFingerprint: async () => "credential",
    hasDashboardPassphrase: async () => true,
    verifyDashboardPassphrase: vi.fn(() => new Promise(resolve => releases.push(resolve)))
  };
  const login = (ip: string) => {
    const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
    const request = Object.assign(new EventEmitter(), { socket: { remoteAddress: ip }, headers: {}, setEncoding: vi.fn() });
    const done = internal.handleLogin(request, response, "/");
    request.emit("data", "password=wrong"); request.emit("end");
    return { done, response };
  };
  try {
    const pending = ["one", "two", "three", "four"].map(login);
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    const excess = login("five"); await excess.done;
    expect(excess.response.statusCode).toBe(429);
    expect(internal.auth.verifyDashboardPassphrase).toHaveBeenCalledTimes(4);
    releases.forEach(release => release(false));
    await Promise.all(pending.map(item => item.done));
    internal.auth.verifyDashboardPassphrase.mockResolvedValue(false);
    const next = login("six"); await next.done;
    expect(next.response.statusCode).toBe(401);
  } finally { server.dispose(); }
});
