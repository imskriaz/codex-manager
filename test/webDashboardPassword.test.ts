import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import type * as http from "http";
import { EncryptedSyncManager } from "../src/services/encryptedSync";
import {
  isAddressInUseError,
  isForwardedHttpsRequest,
  fingerprintWebDashboardSession,
  normalizePersistedWebDashboardSessions,
  WebDashboardServer
} from "../src/services/webDashboardServer";

describe("Web Dashboard encrypted-sync passphrase", () => {
  it("uses the encrypted-sync secret as the dashboard credential", async () => {
    const passphrase = "correct horse battery staple";
    const manager = new EncryptedSyncManager(
      {
        secrets: {
          get: vi.fn(async (key: string) => (key === "codexManager.encryptedSync.passphrase" ? passphrase : undefined))
        }
      } as never,
      {} as never,
      {
        hasDashboardPassphrase: vi.fn(async () => true),
        verifyDashboardPassphrase: vi.fn(async () => false),
        setOnlineDeviceIds: vi.fn()
      } as never
    );

    await expect(manager.hasDashboardPassphrase()).resolves.toBe(true);
    await expect(manager.verifyDashboardPassphrase(passphrase)).resolves.toBe(true);
    await expect(manager.verifyDashboardPassphrase("wrong passphrase")).resolves.toBe(false);
  });

  it("recognizes a shared dashboard port without hiding unrelated server errors", () => {
    expect(isAddressInUseError(Object.assign(new Error("busy"), { code: "EADDRINUSE" }))).toBe(true);
    expect(isAddressInUseError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isAddressInUseError("EADDRINUSE")).toBe(false);
  });

  it("persists only valid, unexpired session fingerprints", () => {
    const token = "opaque-session-token";
    const fingerprint = fingerprintWebDashboardSession(token);
    const sessions = normalizePersistedWebDashboardSessions(
      JSON.stringify([
        { fingerprint, expiresAt: 2_000 },
        { fingerprint: token, expiresAt: 2_000 },
        { fingerprint, expiresAt: 500 },
        { fingerprint: "bad", expiresAt: 2_000 }
      ]),
      1_000
    );

    expect(sessions).toEqual([{ fingerprint, expiresAt: 2_000 }]);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("Web Dashboard forwarded protocol", () => {
  it("recognizes cloudflared HTTPS forwarding headers", () => {
    expect(isForwardedHttpsRequest({ headers: { "x-forwarded-proto": "https" } })).toBe(true);
    expect(isForwardedHttpsRequest({ headers: { "cf-visitor": '{"scheme":"https"}' } })).toBe(true);
    expect(isForwardedHttpsRequest({ headers: { "x-forwarded-proto": "http" } })).toBe(false);
  });

  it("returns 401 JSON for an expired tunneled API session", async () => {
    const server = new WebDashboardServer(
      {
        secrets: { get: vi.fn(async () => "configured") },
        globalStorageUri: { fsPath: "storage" },
        extensionUri: { fsPath: "extension" }
      } as never,
      {} as never,
      {
        hasDashboardPassphrase: vi.fn(async () => true),
        verifyDashboardPassphrase: vi.fn(async () => false),
        setOnlineDeviceIds: vi.fn()
      } as never
    );
    const headers = new Map<string, unknown>();
    let body = "";
    const response = {
      statusCode: 200,
      setHeader: vi.fn((key: string, value: unknown) => headers.set(key.toLowerCase(), value)),
      end: vi.fn((value?: string) => {
        body = value ?? "";
      })
    } as unknown as http.ServerResponse;
    const handle = (
      server as unknown as {
        handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
      }
    ).handle.bind(server);

    await handle(
      {
        method: "POST",
        url: "/api/message",
        headers: {},
        socket: { remoteAddress: "127.0.0.1" }
      } as http.IncomingMessage,
      response
    );

    expect(response.statusCode).toBe(401);
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(body)).toEqual({ error: "Dashboard session expired" });
    server.dispose();
  });

  it("reaches password verification when Chromium sends an opaque login origin", async () => {
    const server = new WebDashboardServer(
      {
        secrets: { get: vi.fn(async () => "configured") },
        globalStorageUri: { fsPath: "storage" },
        extensionUri: { fsPath: "extension" }
      } as never,
      {} as never,
      {
        hasDashboardPassphrase: vi.fn(async () => true),
        verifyDashboardPassphrase: vi.fn(async () => false),
        setOnlineDeviceIds: vi.fn()
      } as never
    );
    let body = "";
    const response = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((value?: string) => {
        body = value ?? "";
      })
    } as unknown as http.ServerResponse;
    const request = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/login?returnTo=%2F",
      headers: {
        origin: "null",
        "content-type": "application/x-www-form-urlencoded",
        "cf-ray": "browser-login"
      },
      socket: { remoteAddress: "127.0.0.1" },
      setEncoding: vi.fn()
    }) as unknown as http.IncomingMessage;
    const handle = (
      server as unknown as {
        handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
      }
    ).handle.bind(server);

    const pending = handle(request, response);
    request.emit("data", "password=incorrect");
    request.emit("end");
    await pending;

    expect(response.statusCode).toBe(401);
    expect(body).toContain("Incorrect password.");
    expect(body).not.toBe("Forbidden");
    server.dispose();
  });
});
