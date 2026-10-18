import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock("undici", async original => ({ ...await original<typeof import("undici")>(), fetch: mockFetch }));
import { WebDashboardServer } from "../src/services/webDashboardServer";

const secret = Buffer.alloc(32, 7);
let settings: { cloudflaredDomain: string; webDashboardEnabled: boolean; webSocketServerEnabled: boolean };
let server: WebDashboardServer;
beforeEach(() => {
  settings = { cloudflaredDomain: "https://tunnel.example", webDashboardEnabled: true, webSocketServerEnabled: true };
  server = Object.assign(Object.create(WebDashboardServer.prototype), { settingsStore: { getDashboardSettings: () => settings }, hostProofKey: secret });
  mockFetch.mockReset().mockImplementation(async (url: URL) => Response.json({ proof: createHmac("sha256", secret).update(url.searchParams.get("challenge")!).digest("hex") }));
});
afterEach(() => vi.useRealTimers());
it("recognizes this exact tunnel host from a fresh per-request challenge", async () => {
  expect(await server.isConfiguredDomainLocal()).toBe(true); expect(await server.isConfiguredDomainLocal()).toBe(true);
  expect(mockFetch.mock.calls[0]?.[0].searchParams.get("challenge")).not.toBe(mockFetch.mock.calls[1]?.[0].searchParams.get("challenge"));
  expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
});
it.each(["foreign", "offline", "malformed", "oversized", "forbidden"])("keeps the relay off for a %s host", async reason => {
  if (reason === "foreign") mockFetch.mockResolvedValue(Response.json({ proof: "foreign-proof" }));
  if (reason === "offline") mockFetch.mockRejectedValue(new Error("offline"));
  if (reason === "malformed") mockFetch.mockResolvedValue(new Response("not JSON"));
  if (reason === "oversized") mockFetch.mockResolvedValue(new Response("x".repeat(513)));
  if (reason === "forbidden") mockFetch.mockResolvedValue(new Response("Forbidden", { status: 403 }));
  expect(await server.isConfiguredDomainLocal()).toBe(false);
});
it("honors a disabled cross-system toggle without making a network request", async () => {
  settings.webSocketServerEnabled = false; expect(await server.isConfiguredDomainLocal()).toBe(false); expect(mockFetch).not.toHaveBeenCalled();
});
it("rejects a stale successful proof after configuration changes", async () => {
  mockFetch.mockImplementation(async (url: URL) => {
    settings.webDashboardEnabled = false;
    return Response.json({ proof: createHmac("sha256", secret).update(url.searchParams.get("challenge")!).digest("hex") });
  });
  expect(await server.isConfiguredDomainLocal()).toBe(false);
});
