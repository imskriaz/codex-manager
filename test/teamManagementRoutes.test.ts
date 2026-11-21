import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebDashboardServer,
  isWebDashboardPagePath,
  normalizeWebDashboardReturnPath
} from "../src/services/webDashboardServer";
import { updateOfficeUser } from "../src/services/officeUsers";

afterEach(() => vi.restoreAllMocks());
describe("Team management routes", () => {
  it.each([undefined, { id: "disabled", role: "user", enabled: false }])("fails closed when the session user is missing or disabled", async user => {
    const server = new WebDashboardServer({ extensionUri: { fsPath: "extension" }, secrets: { get: vi.fn(async () => undefined) } } as never, { getDashboardSettings: () => ({ teamWorkspaceEnabled: true }) } as never);
    const internal = server as any;
    vi.spyOn(internal, "isAuthorized").mockResolvedValue(true);
    vi.spyOn(internal, "officeUserForRequest").mockResolvedValue(user);
    const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
    try {
      await internal.handle({ method: "GET", url: "/api/state", headers: { host: "127.0.0.1:39875" }, socket: { remoteAddress: "127.0.0.1" } }, response);
      expect(response.statusCode).toBe(401);
    } finally { server.dispose(); }
  });
  it("closes only the affected user's sockets after a permissions change", () => {
    const server = new WebDashboardServer({ extensionUri: { fsPath: "extension" }, secrets: { get: vi.fn(async () => undefined) } } as never, {} as never);
    const internal = server as any;
    const affected = { readyState: 1, close: vi.fn() }, other = { readyState: 1, close: vi.fn() };
    internal.browserSocketOfficeUser = new WeakMap([[affected, { id: "alex" }], [other, { id: "other" }]]);
    internal.webSocketClients.add(affected); internal.webSocketClients.add(other);
    try {
      internal.closeOfficeUserSockets("alex");
      expect(affected.close).toHaveBeenCalledWith(4001, expect.stringContaining("permissions changed"));
      expect(other.close).not.toHaveBeenCalled();
    } finally { internal.webSocketClients.clear(); server.dispose(); }
  });
  it("opens Settings after login for either legacy management route", () => {
    expect(isWebDashboardPagePath("/manage")).toBe(true);
    expect(normalizeWebDashboardReturnPath("/manage")).toBe("/?settings=users");
    expect(normalizeWebDashboardReturnPath("/admin")).toBe("/?settings=users");
    expect(normalizeWebDashboardReturnPath("/?settings=users")).toBe("/?settings=users");
    expect(normalizeWebDashboardReturnPath("//external.example/manage")).toBe("/");
  });
  it.each(["/manage", "/admin"])("redirects administrator %s requests into Settings", async route => {
    const server = new WebDashboardServer({ extensionUri: { fsPath: "extension" }, secrets: { get: vi.fn(async () => undefined) } } as never, { getDashboardSettings: () => ({ teamWorkspaceEnabled: true }) } as never);
    const internal = server as any;
    vi.spyOn(internal, "isAuthorized").mockResolvedValue(true);
    vi.spyOn(internal, "officeUserForRequest").mockResolvedValue({ id: "master", role: "unrestricted-admin", enabled: true });
    const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
    try {
      await internal.handle({ method: "GET", url: route, headers: { host: "127.0.0.1:39875" }, socket: { remoteAddress: "127.0.0.1" } }, response);
      expect(response.statusCode).toBe(303);
      expect(response.setHeader).toHaveBeenCalledWith("Location", "/?settings=users");
    } finally { server.dispose(); }
  });
  it.each(["/manage", "/admin", "/api/office/settings", "/api/office/users", "/api/office/mcp"])(
    "denies regular users access to %s on the server",
    async (route) => {
      const server = new WebDashboardServer(
        { extensionUri: { fsPath: "extension" }, secrets: { get: vi.fn(async () => undefined) } } as never,
        { getDashboardSettings: () => ({ teamWorkspaceEnabled: true }) } as never
      );
      const internal = server as any;
      vi.spyOn(internal, "isAuthorized").mockResolvedValue(true);
      vi.spyOn(internal, "officeUserForRequest").mockResolvedValue({ id: "user", role: "user", enabled: true });
      const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
      try {
        await internal.handle(
          { method: "GET", url: route, headers: { host: "127.0.0.1:39875" }, socket: { remoteAddress: "127.0.0.1" } },
          response
        );
        expect(response.statusCode).toBe(403);
      } finally {
        server.dispose();
      }
    }
  );
  it("rejects invalid roles and sign-in flags before changing a user", async () => {
    await expect(updateOfficeUser("user", { role: "superuser" as never })).rejects.toThrow("valid Team role");
    await expect(updateOfficeUser("user", { enabled: "false" as never })).rejects.toThrow("sign-in status");
  });
  it.each(["PUT", "PATCH", "DELETE"])("rejects cross-origin %s requests before updating Team data", async method => {
    const server = new WebDashboardServer({ extensionUri: { fsPath: "extension" }, secrets: { get: vi.fn(async () => undefined) } } as never, { getDashboardSettings: () => ({ teamWorkspaceEnabled: true }) } as never);
    const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
    try {
      await (server as any).handle({ method, url: "/api/office/settings", headers: { host: "127.0.0.1:39875", origin: "https://external.example" }, socket: { remoteAddress: "127.0.0.1" } }, response);
      expect(response.statusCode).toBe(403);
      expect(response.end).toHaveBeenCalledWith(expect.stringContaining("Cross-origin"));
    } finally { server.dispose(); }
  });
});
