import { afterEach, expect, it, vi } from "vitest";
import { requestLocalTeamSettings } from "../src/services/teamSettingsRequest";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('allows read-only user session lists and details through the administrator bridge', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ sessions: [] }))); vi.stubGlobal('fetch', fetch);
  const path = '/api/office/sessions/11111111-1111-1111-1111-111111111111';
  await requestLocalTeamSettings({ path, method: 'GET' });
  await requestLocalTeamSettings({ path: path + '/22222222-2222-2222-2222-222222222222', method: 'GET' });
  await expect(requestLocalTeamSettings({ path, method: 'POST' })).rejects.toThrow('valid Team settings action');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([['/api/email/smtp','GET'],['/api/email/smtp','PUT'],['/api/email/preferences','POST'],['/api/email/test','POST']])('allows the local email settings bridge: %s %s', async (path, method) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'Saved.' }))); vi.stubGlobal('fetch', fetch);
  await expect(requestLocalTeamSettings({ path, method })).resolves.toEqual({ message: 'Saved.' }); expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  { path: "https://external.example/api/office/users", method: "GET" },
  { path: "/api/office/../state", method: "GET" },
  { path: "/api/office/users?target=other", method: "GET" },
  { path: "/api/office/logs", method: "DELETE" },
  { path: "/api/office/users", method: "PUT" }
])("rejects non-management requests before connecting: $method $path", async request => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(requestLocalTeamSettings(request)).rejects.toThrow("valid Team settings action");
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves API validation errors and never replays a rejected mutation", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "That email is already in use." }), { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  await expect(requestLocalTeamSettings({ path: "/api/office/users", method: "POST", body: { username: "alex@example.test" } })).rejects.toThrow("That email is already in use.");
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/office\/users$/), expect.objectContaining({ redirect: "error", method: "POST" }));
});

it("reports an unconfirmed write after a timeout without replay", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const fetch = vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
  vi.stubGlobal("fetch", fetch);
  const outcome = expect(requestLocalTeamSettings({ path: "/api/office/settings", method: "PUT", body: { workspaceRoot: "D:/team" } })).rejects.toThrow("Refresh before retrying");
  controller.abort(); await outcome;
  expect(fetch).toHaveBeenCalledOnce();
});
it("allows read-only model discovery through the local administrator bridge",async()=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify({models:[{id:"chosen",label:"Chosen"}]})));vi.stubGlobal("fetch",fetch);
 expect(await requestLocalTeamSettings({path:"/api/office/models",method:"GET"})).toEqual({models:[{id:"chosen",label:"Chosen"}]});
 await expect(requestLocalTeamSettings({path:"/api/office/models",method:"PUT",body:{}})).rejects.toThrow("valid Team settings action");
 expect(fetch).toHaveBeenCalledOnce();
});
