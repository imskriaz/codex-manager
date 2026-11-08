import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardHostMessage, DashboardCodexServerRequest } from "../src/domain/dashboard/types";
import { codexPromptKey } from "../webview-src/dashboard/codexSessionPrompts";

const harness = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, cleanups: [] as Array<() => void>, post: vi.fn() }));
vi.mock("preact/hooks", () => ({
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    harness.slots[index] ??= { value: initial };
    return [harness.slots[index].value, (next: unknown) => { harness.slots[index].value = typeof next === "function" ? next(harness.slots[index].value) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    return harness.slots[index] ??= { current: initial };
  },
  useCallback: (callback: unknown) => {
    const index = harness.cursor++;
    return harness.slots[index] ??= callback;
  },
  useEffect: (setup: () => (() => void)) => {
    const index = harness.cursor++;
    if (harness.slots[index]) return;
    harness.slots[index] = true;
    harness.effects.push(() => { harness.cleanups.push(setup()); });
  }
}));
vi.mock("../webview-src/dashboard/host", () => ({ postMessageToHost: harness.post }));
import { useCodexSessionPrompts } from "../webview-src/dashboard/codexSessionPromptHook";

const request = (deviceId = "worker"): DashboardCodexServerRequest => ({ id: "question", threadId: "thread", deviceId, kind: "question", title: "Layout", questions: [{ id: "choice", header: "Choice", question: "Which layout?", isSecret: false }] });
let listener: ((event: MessageEvent<DashboardHostMessage>) => void) | undefined;
const send = vi.fn(), notice = vi.fn();
let options: Parameters<typeof useCodexSessionPrompts>[0];
const render = (patch: Partial<typeof options> = {}) => {
  options = { ...options, ...patch };
  harness.cursor = 0;
  const result = useCodexSessionPrompts(options);
  harness.effects.splice(0).forEach(effect => effect());
  return result;
};
const emit = (data: DashboardHostMessage) => listener?.({ data } as MessageEvent<DashboardHostMessage>);
beforeEach(() => {
  harness.slots = []; harness.cursor = 0; harness.effects = []; harness.cleanups = []; harness.post.mockReset();
  send.mockReset().mockImplementation(() => "response" + send.mock.calls.length);
  notice.mockReset(); listener = undefined;
  options = { target: { id: "thread", deviceId: "worker" }, browser: true, connected: true,
    peers: [{ id: "host", connected: true, local: true }, { id: "worker", connected: true }, { id: "other", connected: true }], sendAction: send, onNotice: notice };
  vi.stubGlobal("window", {
    addEventListener: (_: string, callback: typeof listener) => { listener = callback; },
    removeEventListener: () => { listener = undefined; },
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  });
});
afterEach(() => { harness.cleanups.forEach(cleanup => cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("session request routing and recovery", () => {
  it('quietly removes permission requests handled by Manager Auto approval', () => {
    render(); emit({ type: 'dashboard:codex-request', request: { ...request(), kind: 'command' } });
    emit({ type: 'dashboard:codex-request-resolved', requestId: 'question', deviceId: 'worker', automatic: true });
    expect(render().active).toBeUndefined(); expect(notice).not.toHaveBeenCalled();
  });
  it('recovers a missing approval acknowledgement without relying on the parent timeout handler', () => {
    vi.useFakeTimers(); render();
    const approval = { ...request(), kind: 'permissions' as const };
    emit({ type: 'dashboard:codex-request', request: approval });
    const key = codexPromptKey(approval);
    render().respond(key, 'approve');
    vi.advanceTimersByTime(80_000);
    let hook = render();
    expect(hook.active).toMatchObject({ uncertain: true, responseId: undefined, error: expect.stringContaining('not confirmed') });
    hook.respond(key, 'approve'); expect(send).toHaveBeenCalledOnce();
    emit({ type: 'dashboard:codex-requests', requests: [approval] });
    hook = render(); hook.respond(key, 'approve');
    expect(send).toHaveBeenCalledTimes(2);
    emit({ type: 'dashboard:action-result', requestId: 'response1', action: 'respondCodexServerRequest', status: 'failed', error: 'Old failure' });
    expect(render().entries[0]?.responseId).toBe('response2');
    emit({ type: 'dashboard:action-result', requestId: 'response2', action: 'respondCodexServerRequest', status: 'completed' });
    const notices = notice.mock.calls.length;
    vi.advanceTimersByTime(80_000);
    expect(render().active).toBeUndefined(); expect(notice).toHaveBeenCalledTimes(notices);
  });
  it.each(['resolved', 'snapshot', 'unmount'] as const)('clears approval deadlines after %s', action => {
    vi.useFakeTimers(); render(); emit({ type: 'dashboard:codex-request', request: request() });
    render().respond(codexPromptKey(request()), 'decline');
    if (action === 'resolved') emit({ type: 'dashboard:codex-request-resolved', requestId: 'question', deviceId: 'worker' });
    else if (action === 'snapshot') emit({ type: 'dashboard:codex-requests', requests: [] });
    else harness.cleanups.forEach(cleanup => cleanup?.());
    const notices = notice.mock.calls.length;
    vi.advanceTimersByTime(80_000);
    expect(notice).toHaveBeenCalledTimes(notices);
  });
  it('keeps an approval usable when the host cannot queue the response', () => {
    render(); emit({ type: 'dashboard:codex-request', request: request() });
    send.mockReturnValueOnce(undefined);
    render().respond(codexPromptKey(request()), 'decline');
    expect(render().active).toMatchObject({ error: expect.stringContaining('not queued') });
    expect(render().active?.responseId).toBeUndefined();
    render().respond(codexPromptKey(request()), 'decline'); expect(send).toHaveBeenCalledTimes(2);
  });
  it("routes an explicit answer to its owner exactly once and keeps it after failure", () => {
    render(); emit({ type: "dashboard:codex-request", request: request() });
    const key = codexPromptKey(request());
    let hook = render(); hook.answer(key, "choice", "Compact");
    hook = render(); hook.respond(key, "approve"); hook.respond(key, "approve");
    expect(render().active).toBeUndefined();
    expect(send).toHaveBeenCalledExactlyOnceWith("respondCodexServerRequest", undefined, { codexRequestId: "question", codexDecision: "approve", codexAnswers: { choice: "Compact" }, targetDeviceId: "worker" });
    emit({ type: "dashboard:action-result", requestId: "response1", action: "respondCodexServerRequest", status: "failed", error: "Connection lost" });
    hook = render();
    expect(hook.active).toMatchObject({ answers: { choice: "Compact" }, error: "Connection lost", responseId: undefined });
    hook = render({ connected: false }); hook.answer(key, "choice", "Offline draft"); hook.respond(key, "approve");
    expect(send).toHaveBeenCalledTimes(1);
    hook = render({ connected: true });
    expect(hook.active?.answers.choice).toBe("Offline draft");
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ level: "warning" }));
  });
  it("isolates matching request IDs and answer drafts across session navigation", () => {
    render(); emit({ type: "dashboard:codex-requests", requests: [request(), request("other")] });
    let hook = render(); hook.answer(codexPromptKey(request()), "choice", "Private draft");
    hook = render({ target: { id: "thread", deviceId: "other" } });
    expect(hook.active?.answers).toEqual({});
    hook = render({ target: { id: "thread", deviceId: "worker" } });
    expect(hook.active?.answers.choice).toBe("Private draft");
    emit({ type: "dashboard:codex-request-resolved", requestId: "question", deviceId: "other" });
    expect(render().active?.answers.choice).toBe("Private draft");
    expect(send).not.toHaveBeenCalled();
  });
  it("requires verification after an unconfirmed send and bounds failed checks", () => {
    vi.useFakeTimers(); render(); emit({ type: "dashboard:codex-request", request: request() });
    const key = codexPromptKey(request());
    let hook = render(); hook.answer(key, "choice", "Compact");
    hook = render(); hook.respond(key, "approve"); hook.timeout("response1");
    hook = render(); hook.respond(key, "approve");
    expect(send).toHaveBeenCalledTimes(1);
    hook.check(key); expect(harness.post).toHaveBeenCalledExactlyOnceWith({ type: "dashboard:ready" });
    vi.advanceTimersByTime(15_000);
    expect(render().active?.error).toContain("could not be verified");
    emit({ type: "dashboard:codex-requests", requests: [request()] });
    hook = render(); expect(hook.active?.uncertain).toBe(false);
    expect(hook.active?.answers.choice).toBe("Compact");
    expect(send).toHaveBeenCalledTimes(1);
    hook.respond(key, "approve");
    expect(send).toHaveBeenCalledTimes(2);
    emit({ type: "dashboard:action-result", requestId: "response2", action: "respondCodexServerRequest", status: "completed" });
    expect(render().active).toBeUndefined();
    expect(notice).toHaveBeenCalledWith({ level: "info", message: "Response sent to Codex." });
  });
  it("recognizes local device aliases and prevents responses to offline or missing peers", () => {
    render({ target: { id: "thread" } });
    emit({ type: "dashboard:codex-requests", requests: [request("host")] });
    let hook = render(); expect(hook.active?.request.deviceId).toBe("host");
    expect(hook.connectedTo(hook.active!)).toBe(true);
    emit({ type: "dashboard:codex-requests", requests: [request()] });
    hook = render({ target: { id: "thread", deviceId: "worker" }, peers: [{ id: "worker", connected: false }] });
    expect(hook.connectedTo(hook.active!)).toBe(false);
    hook.respond(codexPromptKey(request()), "decline"); expect(send).not.toHaveBeenCalled();
    hook = render({ peers: [] }); expect(hook.connectedTo(hook.active!)).toBe(false);
  });
});

it('uses the transcript queue for async questions and never selects a modal for another VS Code session', () => {
  render({ browser: false, target: { id: 'another' } });
  emit({ type: 'dashboard:codex-requests', requests: [request()] }); expect(render().active).toBeUndefined();
  emit({ type: 'dashboard:codex-requests', requests: [{ ...request(), sourceMessageId: 'message' }] });
  const hook = render({ target: { id: 'thread', deviceId: 'worker' } });
  expect(hook.active).toBeUndefined(); expect(hook.background).toBeUndefined();
});

it('does not surface expired question notifications after reconnect', () => {
  render({ target: { id: 'another' } });
  emit({ type: 'dashboard:codex-requests', requests: [{ ...request(), createdAt: Date.now() - 120_000 }] });
  expect(render().background).toBeUndefined();
});


it('keeps dismissed background requests hidden across reconnects and reloads without hiding their session prompt', () => {
  const records = new Map<string,string>();
  vi.stubGlobal('localStorage',{ getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>records.set(key,value) });
  render({target:{id:'another'}});emit({type:'dashboard:codex-request',request:request()});
  let hook=render();expect(hook.background?.request.id).toBe('question');hook.dismiss(codexPromptKey(request()));
  emit({type:'dashboard:codex-requests',requests:[request()]});hook=render();expect(hook.background).toBeUndefined();
  harness.cleanups.forEach(cleanup=>cleanup?.());harness.slots=[];harness.effects=[];harness.cleanups=[];
  render();emit({type:'dashboard:codex-requests',requests:[request()]});expect(render().background).toBeUndefined();
  expect(render({target:{id:'thread',deviceId:'worker'}}).active?.request.id).toBe('question');
  emit({type:'dashboard:codex-request',request:{...request(),id:'new-question'}});
  expect(render({target:{id:'another'}}).background?.request.id).toBe('new-question');
});
it('dismisses a request in memory when browser storage is full', () => {
  vi.stubGlobal('localStorage',{getItem:()=>'{broken',setItem:()=>{throw Error('Full');}});
  render({target:{id:'another'}});emit({type:'dashboard:codex-request',request:request()});
  render().dismiss(codexPromptKey(request()));expect(render().background).toBeUndefined();
  expect(notice).toHaveBeenCalledWith(expect.objectContaining({message:expect.stringContaining('this tab')}));
});
