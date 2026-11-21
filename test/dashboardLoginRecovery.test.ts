import { expect, it, vi } from "vitest";
import { WebDashboardServer } from "../src/services/webDashboardServer";

function fixture() {
  const server = new WebDashboardServer(
    { extensionUri: { fsPath: "extension" }, secrets: { get: vi.fn(async () => undefined) } } as never,
    {} as never,
    { hasDashboardPassphrase: vi.fn(async () => true), setOnlineDeviceIds: vi.fn() } as never
  );
  const internal = server as any;
  vi.spyOn(internal, "isAuthorized").mockResolvedValue(true);
  const user = vi.spyOn(internal, "officeUserForRequest").mockResolvedValue(undefined);
  return { server, internal, user };
}

it.each([undefined, { enabled: false }])("shows sign-in for a missing or disabled user instead of JSON or a redirect loop (%s)", async officeUser => {
  const { server, internal, user } = fixture();
  user.mockResolvedValue(officeUser);
  const returnPath = "/workspace/12345678-1234-1234-1234-123456789abc?device=remote";
  try {
    for (const url of ["/", returnPath, "/api/keys", `/login?returnTo=${encodeURIComponent(returnPath)}`]) {
      const headers = new Map<string, string>();
      let body = "";
      const response = { statusCode: 200, setHeader: (key: string, value: string) => headers.set(key.toLowerCase(), value), end: (value: string) => { body = value; } };
      await internal.handle({ method: "GET", url, headers: { host: "dashboard.example", "x-forwarded-proto": "https" } }, response);
      expect(response.statusCode).toBe(200);
      expect(headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(headers.has("location")).toBe(false);
      expect(body).toContain('name="password"');
      expect(body).toContain("Your dashboard session expired");
      if (url !== "/" && url !== "/api/keys") expect(body).toContain(`action="/login?returnTo=${encodeURIComponent(returnPath)}"`);
    }
  } finally { server.dispose(); }
});

it("keeps expired user API requests as 401 JSON", async () => {
  const { server, internal } = fixture();
  const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
  try {
    await internal.handle({ method: "POST", url: "/api/message", headers: {} }, response);
    expect(response.statusCode).toBe(401);
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "application/json; charset=utf-8");
    expect(JSON.parse(response.end.mock.calls[0]![0])).toEqual({ error: "Your session expired. Sign in again." });
  } finally { server.dispose(); }
});

it("recovers direct local navigation with a stale session cookie", async () => {
  const { server, internal, user } = fixture();
  user.mockRestore();
  vi.mocked(internal.isAuthorized).mockRestore();
  vi.spyOn(internal, "isAuthorizedSessionToken").mockResolvedValue(false);
  const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
  try {
    await internal.handle({ method: "GET", url: "/login", headers: { host: "127.0.0.1:39875", cookie: `codex_dashboard_session=${"a".repeat(64)}` }, socket: { remoteAddress: "127.0.0.1" } }, response);
    expect(response.statusCode).toBe(200);
    expect(response.end.mock.calls[0]![0]).toContain('name="password"');
    expect(response.setHeader).not.toHaveBeenCalledWith("Location", expect.anything());
  } finally { server.dispose(); }
});

it("redirects an enabled user from sign-in to the requested page", async () => {
  const { server, internal, user } = fixture();
  user.mockResolvedValue({ enabled: true });
  const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
  try {
    await internal.handle({ method: "GET", url: "/login?returnTo=%2Fworkspace", headers: {} }, response);
    expect(response.statusCode).toBe(303);
    expect(response.setHeader).toHaveBeenCalledWith("Location", "/workspace");
  } finally { server.dispose(); }
});
