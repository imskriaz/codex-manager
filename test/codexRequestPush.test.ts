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
it('routes suggested question answers to their owning PC once and never accepts arbitrary answers', async () => {
  actions.set('prompt', ['Yes', 'No']);
  server.codexPushActions.set('prompt', { requestId: 'request', targetDeviceId: 'worker', question: true, answers: { Yes: { choice: 'Yes' }, No: { choice: 'No' } } });
  expect((await respond('prompt', 'Injected')).status).toBe(409);
  expect((await respond('prompt', 'Yes')).status).toBe(200);
  expect(processMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ payload: { codexRequestId: 'request', targetDeviceId: 'worker', codexDecision: 'approve', codexAnswers: { choice: 'Yes' } } }));
  expect((await respond('prompt', 'No')).status).toBe(409);
});
it('reports a missing response acknowledgement as unconfirmed without replaying it', async () => {
  seed(); processMessage.mockResolvedValueOnce({ messages: [] });
  const result = await respond('prompt', 'Approve');
  expect(result.status).toBe(400); expect((await result.json()).error).toContain('did not confirm');
  expect((await respond('prompt', 'Approve')).status).toBe(409);
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

it('offers direct answers and inline text replies with a link to the owning session', () => {
  const notify = vi.fn(); server.browserPush.notify = notify; server.peerSessions = new Map();
  server.notifyCodexRequest({ id: 'choice', threadId: 'session', deviceId: 'worker', kind: 'question', title: 'Codex has a question', questions: [{ id: 'layout', question: 'Which layout?', isSecret: false, options: [{ label: 'Compact' }, { label: 'Spacious' }] }] });
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ actions: ['Compact','Spacious'], url: '/workspace/session?device=worker' }));
  server.notifyCodexRequest({ id: 'typed', threadId: 'session', kind: 'question', title: 'Codex has a question', questions: [{ id: 'answer', question: 'What should change?', isSecret: false }] });
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ actions: ['Reply','Answer'], replyAction: 'Reply', url: '/workspace/session' }));
  server.notifyCodexRequest({ id: 'reserved', threadId: 'session', kind: 'question', title: 'Next?', questions: [{ id: 'next', question: 'Next action?', isSecret: false, options: [{ label: 'Reply' }] }] });
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ actions: ['Reply','Answer'], replyAction: 'Reply' }));
  expect(processMessage).not.toHaveBeenCalled();
});

it('keeps transcript question push identity stable across owner reconnects without merging different questions', () => {
  const notify = vi.fn(); server.browserPush.notify = notify; server.peerSessions = new Map();
  const request = { id: 'first-owner', threadId: 'session', sourceMessageId: 'question-message', createdAt: Date.now(), kind: 'question', title: 'Codex has a question', questions: [{ id: 'choice-0', question: 'Continue?', isSecret: false }] };
  server.notifyCodexRequest(request);
  const first = notify.mock.lastCall![0];
  server.notifyCodexRequest({ ...request, id: 'reconnected-owner' });
  expect(notify.mock.lastCall![0].notificationId).toBe(first.notificationId);
  expect(server.codexPushActions.get(first.notificationId).requestId).toBe('reconnected-owner');
  server.notifyCodexRequest({ ...request, questions: [{ ...request.questions[0], id: 'choice-1' }] });
  expect(notify.mock.lastCall![0].notificationId).not.toBe(first.notificationId);
  server.notifyCodexRequest({ ...request, questions: [{ ...request.questions[0], question: 'Changed question?' }] });
  expect(notify.mock.lastCall![0].notificationId).not.toBe(first.notificationId);
});

it('never pushes expired or invalid-date questions', () => {
  const notify = vi.fn(); server.browserPush.notify = notify; server.peerSessions = new Map();
  for (const createdAt of [Date.now() - 120_000, Date.now() + 60_000, NaN]) server.notifyCodexRequest({ id: 'stale', threadId: 'session', kind: 'question', title: 'Old question', createdAt });
  expect(notify).not.toHaveBeenCalled();
});

it('routes typed notification replies exactly once to Codex and keeps blank answers from consuming the action', async () => {
  actions.set('prompt', ['Reply','Answer']); server.codexPushActions.set('prompt', { requestId: 'request', targetDeviceId: 'worker', question: true, replyQuestionId: 'answer' });
  const post = (reply: string) => fetch(`${origin}/api/push/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codex-Dashboard': '1', Origin: origin }, body: JSON.stringify({ notificationId: 'prompt', action: 'Reply', reply }) });
  expect((await post(' ')).status).toBe(400); expect(processMessage).not.toHaveBeenCalled();
  expect((await post('Typed answer')).status).toBe(200); expect(processMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ payload: { codexRequestId: 'request', targetDeviceId: 'worker', codexDecision: 'approve', codexAnswers: { answer: 'Typed answer' } } }));
  expect((await post('Typed answer')).status).toBe(400); expect(processMessage).toHaveBeenCalledOnce();
});

it('pushes permission requests with approve and reject actions and never grants access on delivery', () => {
  const notify = vi.fn(); server.browserPush.notify = notify; server.peerSessions = new Map();
  server.notifyCodexRequest({ id: 'permission', threadId: 'session', kind: 'permissions', title: 'Grant additional permissions?', detail: 'Network access requested. ' + 'Review these roots. '.repeat(12) });
  expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actions: ['Approve','Reject'], url: '/workspace/session', message: expect.stringContaining('Network access requested') }));
  expect(processMessage).not.toHaveBeenCalled();
});
it('routes a permission Reject action as a decline exactly once', async () => {
  actions.set('permission', ['Approve', 'Reject']); server.codexPushActions.set('permission', { requestId: 'request', targetDeviceId: 'worker', question: false });
  expect((await respond('permission', 'Reject')).status).toBe(200);
  expect(processMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ payload: { codexRequestId: 'request', targetDeviceId: 'worker', codexDecision: 'decline' } }));
  expect((await respond('permission', 'Reject')).status).toBe(409);
});
