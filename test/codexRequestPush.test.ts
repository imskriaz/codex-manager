import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebDashboardServer } from "../src/services/webDashboardServer";

let host: Server, origin: string, authorized: boolean;
let server: any;
const actions = new Map<string, string[]>();
const processMessage = vi.fn();
beforeEach(async () => {
  authorized = true; actions.clear(); processMessage.mockReset();
  processMessage.mockResolvedValue({ messages: [{ type: "dashboard:action-result", status: "completed" }] });
  server = Object.assign(Object.create(WebDashboardServer.prototype), {
    getUrl: () => origin, settingsStore: { getDashboardSettings: () => ({}) }, isAuthorized: async () => authorized,
    codexPushActions: new Map(), processClientMessage: processMessage,
    browserPush: { takeAction: (id: string, action: string) => {
      if (!actions.get(id)?.includes(action)) return false;
      actions.delete(id); return true;
    } }
  });
  host = createServer((request, response) => { void server.handle(request, response).catch(() => { response.statusCode = 500; response.end(); }); });
  await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => { host.close(() => resolve()); host.closeAllConnections(); }); });
const respond = (notificationId: string, action: string) => fetch(`${origin}/api/push/action`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Codex-Dashboard": "1", Origin: origin },
  body: JSON.stringify({ notificationId, action }), signal: AbortSignal.timeout(5_000)
});
const seed = (question = false) => {
  actions.set("prompt", question ? ["Answer"] : ["Approve", "Decline"]);
  server.codexPushActions.set("prompt", { requestId: "request", targetDeviceId: "worker", question });
};

it.each(["Approve", "Decline"])("routes %s to the owning PC once and rejects duplicate or invalid notification choices", async action => {
  seed();
  expect((await respond("prompt", "Unexpected")).status).toBe(409);
  expect(processMessage).not.toHaveBeenCalled();
  expect((await respond("prompt", action)).status).toBe(200);
  expect(processMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: "respondCodexServerRequest",
    payload: { codexRequestId: "request", targetDeviceId: "worker", codexDecision: action === "Approve" ? "approve" : "decline" } }));
  expect((await respond("prompt", action)).status).toBe(409);
  expect(processMessage).toHaveBeenCalledOnce();
});
it("opens questions for review without supplying an automatic answer", async () => {
  seed(true);
  expect((await respond("prompt", "Answer")).status).toBe(200);
  expect(processMessage).not.toHaveBeenCalled();
});
it("requires an active login and surfaces remote disconnects without replaying a response", async () => {
  seed(); authorized = false;
  expect((await respond("prompt", "Approve")).status).toBe(401);
  expect(processMessage).not.toHaveBeenCalled();
  authorized = true;
  processMessage.mockResolvedValueOnce({ messages: [{ type: "dashboard:action-result", status: "failed", error: "The selected PC is offline." }] });
  const result = await respond("prompt", "Approve");
  expect(result.status).toBe(400); expect((await result.json()).error).toContain("offline");
  expect((await respond("prompt", "Approve")).status).toBe(409);
  expect(processMessage).toHaveBeenCalledOnce();
});
