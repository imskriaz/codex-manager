import { afterEach, describe, expect, it, vi } from "vitest";
import { attachCodexAppServerPrompts, autoApprovePendingCodexPrompts, cancelCodexAppServerPrompts, respondCodexAppServerPrompt, listPendingCodexAppServerPrompts, syncNativeCodexPrompts, clearNativeCodexPrompts } from "../src/services/codexAppServerPrompts";
import type { AppServerRequest, CodexAppServerRpc } from "../src/services/codexAppServerRpc";
import { subscribeDashboardRealtime } from "../src/services/dashboardRealtime";

function createRpc() {
  let receive: ((request: AppServerRequest) => void) | undefined;
  let notify: ((method: string, params: unknown) => void) | undefined;
  const answerServerRequest = vi.fn();
  const rejectServerRequest = vi.fn();
  const rpc = {
    onServerRequest: (listener: (request: AppServerRequest) => void) => { receive = listener; return () => { receive = undefined; }; },
    onNotification: (listener: (method: string, params: unknown) => void) => { notify = listener; return () => { notify = undefined; }; },
    answerServerRequest,
    rejectServerRequest
  } as unknown as CodexAppServerRpc;
  return { rpc, emit: (request: AppServerRequest) => receive?.(request), notify: (method: string, params: unknown) => notify?.(method, params), answerServerRequest, rejectServerRequest };
}
afterEach(() => vi.useRealTimers());

it('distinguishes answered requests from unanswered disconnects in resolution events', async () => {
  const resolutions: Array<{ answered?: boolean }> = [];
  const stop = subscribeDashboardRealtime(message => { if (message.type === 'dashboard:codex-request-resolved') resolutions.push(message); });
  const fake = createRpc(), detach = attachCodexAppServerPrompts(fake.rpc, 'answered');
  try {
    fake.emit({ id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'answered', questions: [{ id: 'choice', question: 'Continue?' }] } });
    const prompt = listPendingCodexAppServerPrompts().find(request => request.threadId === 'answered')!;
    await respondCodexAppServerPrompt(prompt.id, 'approve', { choice: 'Yes' });
    expect(resolutions.at(-1)?.answered).toBe(true);
    fake.emit({ id: 2, method: 'item/tool/requestUserInput', params: { threadId: 'answered', questions: [{ id: 'next', question: 'Again?' }] } });
    detach(); expect(resolutions.at(-1)?.answered).toBeUndefined();
  } finally { detach(); stop(); }
});

it('keeps native blocking questions answerable across long waits and owner resync', async () => {
  vi.useFakeTimers(); const source = {}, respond = vi.fn().mockResolvedValue(undefined);
  const requests = [{ id: 'native-question', method: 'item/tool/requestUserInput', params: { threadId: 'native-age', questions: [{ id: 'choice', question: 'Continue?' }] } }];
  try {
    syncNativeCodexPrompts(source, 'native-age', requests, respond);
    const first = listPendingCodexAppServerPrompts().find(request => request.threadId === 'native-age')!;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(listPendingCodexAppServerPrompts().find(request => request.threadId === 'native-age')).toEqual(first);
    syncNativeCodexPrompts(source, 'native-age', requests, respond);
    expect(listPendingCodexAppServerPrompts().find(request => request.threadId === 'native-age')).toEqual(first);
    expect(respond).not.toHaveBeenCalled();
    await respondCodexAppServerPrompt(first.id, 'approve', { choice: 'Yes' });
    expect(respond).toHaveBeenCalledExactlyOnceWith(requests[0], { answers: { choice: { answers: ['Yes'] } } });
  } finally { clearNativeCodexPrompts(source); }
});

it('keeps an app-server blocking question pending without rejecting it on a dashboard timeout', async () => {
  vi.useFakeTimers(); const fake = createRpc(), detach = attachCodexAppServerPrompts(fake.rpc, 'waiting');
  try {
    fake.emit({ id: 'blocking', method: 'item/tool/requestUserInput', params: { threadId: 'waiting', isBlocking: true, questions: [{ id: 'choice', question: 'Continue?' }] } });
    const first = listPendingCodexAppServerPrompts().find(request => request.threadId === 'waiting')!;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(listPendingCodexAppServerPrompts().find(request => request.threadId === 'waiting')).toEqual(first);
    expect(fake.rejectServerRequest).not.toHaveBeenCalled();
    respondCodexAppServerPrompt(first.id, 'approve', { choice: 'Typed answer' });
    expect(fake.answerServerRequest).toHaveBeenCalledExactlyOnceWith('blocking', { answers: { choice: { answers: ['Typed answer'] } } });
  } finally { detach(); }
});

describe("Codex app-server dashboard prompts", () => {
  it('clears requests resolved in Codex without resending a response or clearing another owner', () => {
    const fake = createRpc(), other = createRpc();
    const detach = attachCodexAppServerPrompts(fake.rpc, 'resolved'), detachOther = attachCodexAppServerPrompts(other.rpc, 'other');
    try {
      const params = { mode: 'form', requestedSchema: { type: 'object', properties: {} } };
      fake.emit({ id: 1, method: 'mcpServer/elicitation/request', params });
      other.emit({ id: 1, method: 'mcpServer/elicitation/request', params });
      fake.notify('serverRequest/resolved', { threadId: 'wrong', requestId: 1 });
      expect(listPendingCodexAppServerPrompts()).toHaveLength(2);
      fake.notify('serverRequest/resolved', { threadId: 'resolved', requestId: 1 });
      expect(listPendingCodexAppServerPrompts()).toMatchObject([{ threadId: 'other' }]);
      expect(fake.answerServerRequest).not.toHaveBeenCalled();
      expect(fake.rejectServerRequest).not.toHaveBeenCalled();
    } finally { detach(); detachOther(); }
  });
  it('answers protocol time requests only for the attached thread', () => {
    const fake = createRpc(), detach = attachCodexAppServerPrompts(fake.rpc, 'clock');
    try {
      fake.emit({ id: 1, method: 'currentTime/read', params: { threadId: 'clock' } });
      expect(fake.answerServerRequest).toHaveBeenCalledExactlyOnceWith(1, { currentTimeAt: Math.floor(Date.now() / 1000) });
      fake.emit({ id: 2, method: 'currentTime/read', params: { threadId: 'other' } });
      expect(fake.answerServerRequest).toHaveBeenCalledOnce();
      expect(fake.rejectServerRequest).toHaveBeenCalledWith(2, expect.any(String));
      expect(listPendingCodexAppServerPrompts()).toEqual([]);
    } finally { detach(); }
  });
  it('shows stdin and managed-network context while retaining fresh human approval checks', async () => {
    const fake = createRpc(), detach = attachCodexAppServerPrompts(fake.rpc, 'human', () => true);
    try {
      fake.emit({ id: 1, method: 'item/commandExecution/requestApproval', params: { kind: 'humanCommand', command: 'deploy', availableDecisions: ['accept', 'decline'] } });
      await Promise.resolve(); expect(fake.answerServerRequest).not.toHaveBeenCalled();
      respondCodexAppServerPrompt(listPendingCodexAppServerPrompts()[0]!.id, 'decline');
      fake.emit({ id: 2, method: 'item/commandExecution/requestApproval', params: { kind: 'writeStdin', command: 'yes', networkApprovalContext: { host: 'example.com' }, availableDecisions: ['decline'] } });
      await Promise.resolve();
      const prompt = listPendingCodexAppServerPrompts()[0]!;
      expect(prompt.title).toContain('input to a running command');
      expect(prompt.detail).toContain('example.com');
      expect(() => respondCodexAppServerPrompt(prompt.id, 'approve')).toThrow(/did not offer approval/);
      expect(fake.answerServerRequest).toHaveBeenCalledTimes(1);
    } finally { detach(); }
  });
  it('mirrors MCP approvals and inherits only confirmed auto approval for empty forms', async () => {
    const fake = createRpc(); let enabled = false;
    const detach = attachCodexAppServerPrompts(fake.rpc, 'mcp-auto', () => enabled);
    const params = { threadId: 'mcp-auto', serverName: 'codex-manager', mode: 'form', message: 'Allow manager_schema?', requestedSchema: { type: 'object', properties: {} } };
    try {
      fake.emit({ id: 1, method: 'mcpServer/elicitation/request', params });
      await Promise.resolve();
      expect(listPendingCodexAppServerPrompts()[0]).toMatchObject({ kind: 'mcp', detail: 'Allow manager_schema?' });
      expect(fake.answerServerRequest).not.toHaveBeenCalled();
      enabled = true; autoApprovePendingCodexPrompts('mcp-auto'); await Promise.resolve();
      expect(fake.answerServerRequest).toHaveBeenCalledExactlyOnceWith(1, { action: 'accept', content: {} });
      fake.emit({ id: 2, method: 'mcpServer/elicitation/request', params }); await Promise.resolve();
      expect(fake.answerServerRequest).toHaveBeenLastCalledWith(2, { action: 'accept', content: {} });
      fake.emit({ id: 3, method: 'mcpServer/elicitation/request', params: { ...params, requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } } } });
      fake.emit({ id: 4, method: 'mcpServer/elicitation/request', params: { ...params, mode: 'url', url: 'https://example.com/verify' } });
      fake.emit({ id: 5, method: 'mcpServer/elicitation/request', params: { ...params, mode: 'openai/userVerification' } });
      await Promise.resolve(); expect(fake.answerServerRequest).toHaveBeenCalledTimes(2);
      const form = listPendingCodexAppServerPrompts().find(item => item.questions?.length)!;
      await respondCodexAppServerPrompt(form.id, 'approve', { answer: 'typed' });
      expect(fake.answerServerRequest).toHaveBeenLastCalledWith(3, { action: 'accept', content: { answer: 'typed' } });
      const external = listPendingCodexAppServerPrompts().find(item => item.mcp?.mode === 'external')!;
      expect(() => respondCodexAppServerPrompt(external.id, 'approve')).toThrow(/verification/);
      await respondCodexAppServerPrompt(external.id, 'decline');
      expect(fake.answerServerRequest).toHaveBeenLastCalledWith(5, { action: 'decline' });
    } finally { detach(); }
  });
  it('retains MCP input after write failure and declines with the MCP response shape', () => {
    const fake = createRpc(), detach = attachCodexAppServerPrompts(fake.rpc, 'mcp-fail');
    try {
      fake.emit({ id: 9, method: 'mcpServer/elicitation/request', params: { mode: 'form', serverName: 'test', requestedSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } } });
      const prompt = listPendingCodexAppServerPrompts()[0]!;
      expect(() => respondCodexAppServerPrompt(prompt.id, 'approve', { count: '0' })).toThrow(/count/);
      fake.answerServerRequest.mockImplementationOnce(() => { throw new Error('write failed'); });
      expect(() => respondCodexAppServerPrompt(prompt.id, 'approve', { count: '2' })).toThrow('write failed');
      expect(listPendingCodexAppServerPrompts()).toHaveLength(1);
      respondCodexAppServerPrompt(prompt.id, 'decline');
      expect(fake.answerServerRequest).toHaveBeenLastCalledWith(9, { action: 'decline' });
    } finally { detach(); }
  });
  it('refuses legacy requests that name another conversation', () => {
    const fake = createRpc(), detach = attachCodexAppServerPrompts(fake.rpc, 'owner');
    try {
      fake.emit({ id: 1, method: 'execCommandApproval', params: { conversationId: 'other', command: ['echo', 'test'] } });
      expect(listPendingCodexAppServerPrompts()).toEqual([]);
      expect(fake.rejectServerRequest).toHaveBeenCalledOnce();
    } finally { detach(); }
  });
  it.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'])('auto approves current and future %s prompts only after opt-in', async method => {
    const fake = createRpc(); let enabled = false;
    const detach = attachCodexAppServerPrompts(fake.rpc, 'auto', () => enabled);
    try {
      const params = { threadId: 'auto', command: 'echo test', permissions: { network: { enabled: true } } };
      fake.emit({ id: 1, method, params }); await Promise.resolve(); expect(fake.answerServerRequest).not.toHaveBeenCalled();
      enabled = true; autoApprovePendingCodexPrompts('auto'); autoApprovePendingCodexPrompts('auto'); await Promise.resolve();
      expect(fake.answerServerRequest).toHaveBeenCalledTimes(1); expect(listPendingCodexAppServerPrompts()).toEqual([]);
      fake.emit({ id: 2, method, params }); await Promise.resolve(); expect(fake.answerServerRequest).toHaveBeenCalledTimes(2);
      enabled = false; fake.emit({ id: 3, method, params }); await Promise.resolve(); expect(fake.answerServerRequest).toHaveBeenCalledTimes(2);
      expect(listPendingCodexAppServerPrompts()).toHaveLength(1);
    } finally { detach(); }
  });
  it('never auto answers questions, unsupported grants, changed owners, or failed responses repeatedly', async () => {
    const fake = createRpc(); let enabled = true;
    const detach = attachCodexAppServerPrompts(fake.rpc, 'auto-safe', () => enabled);
    const source = {}, respond = vi.fn().mockRejectedValue(new Error('Owner unavailable'));
    try {
      fake.emit({ id: 1, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: 'Choose?' }] } });
      fake.emit({ id: 2, method: 'item/permissions/requestApproval', params: { permissions: { unknownScope: true } } });
      await Promise.resolve(); await Promise.resolve(); expect(fake.answerServerRequest).not.toHaveBeenCalled();
      fake.emit({ id: 3, method: 'item/commandExecution/requestApproval', params: { command: 'echo hi' } }); enabled = false;
      await Promise.resolve(); expect(fake.answerServerRequest).not.toHaveBeenCalled();
      const requests = [{ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-auto', command: 'echo hi' } }];
      syncNativeCodexPrompts(source, 'native-auto', requests, respond, () => true);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      syncNativeCodexPrompts(source, 'native-auto', requests, respond, () => true);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(respond).toHaveBeenCalledOnce();
      expect(listPendingCodexAppServerPrompts().find(request => request.threadId === 'native-auto')).toBeDefined();
      syncNativeCodexPrompts(source, 'native-auto', [{ ...requests[0]!, id: 10 }], respond, () => true);
      clearNativeCodexPrompts(source); await Promise.resolve(); expect(respond).toHaveBeenCalledOnce();
    } finally { detach(); clearNativeCodexPrompts(source); }
  });
  it("removes a stopped turn's prompts while preserving other sessions and resolving stale replies", () => {
    const first = createRpc();
    const second = createRpc();
    const detachFirst = attachCodexAppServerPrompts(first.rpc, "first");
    const detachSecond = attachCodexAppServerPrompts(second.rpc, "second");
    const events: Array<{ type: string; requestId?: string }> = [];
    const unsubscribe = subscribeDashboardRealtime(message => events.push(message));
    try {
      first.emit({ id: 1, method: "item/commandExecution/requestApproval", params: { command: "echo first" } });
      second.emit({ id: 2, method: "item/commandExecution/requestApproval", params: { command: "echo second" } });
      const request = listPendingCodexAppServerPrompts().find(item => item.threadId === "first")!;
      cancelCodexAppServerPrompts("first");
      expect(first.rejectServerRequest).toHaveBeenCalledWith(1, expect.stringContaining("stopped"));
      expect(listPendingCodexAppServerPrompts().map(item => item.threadId)).toEqual(["second"]);
      expect(() => respondCodexAppServerPrompt(request.id, "approve")).toThrow(/no longer active/);
      expect(events.filter(event => event.type === "dashboard:codex-request-resolved" && event.requestId === request.id)).toHaveLength(2);
    } finally { detachFirst(); detachSecond(); unsubscribe(); }
  });
  it("deduplicates provider request IDs, refuses mismatched threads, and fails a full prompt queue", () => {
    const fake = createRpc();
    const detach = attachCodexAppServerPrompts(fake.rpc, "thread-1");
    try {
      const request = { id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", command: "echo hi" } };
      fake.emit(request);
      fake.emit(request);
      expect(listPendingCodexAppServerPrompts()).toHaveLength(1);
      fake.emit({ ...request, id: 2, params: { ...request.params, threadId: "other-thread" } });
      expect(listPendingCodexAppServerPrompts()).toHaveLength(1);
      for (let id = 3; id < 33; id++) fake.emit({ ...request, id });
      expect(listPendingCodexAppServerPrompts()).toHaveLength(30);
      expect(fake.rejectServerRequest).toHaveBeenCalledWith(32, expect.any(String));
    } finally { detach(); }
    expect(listPendingCodexAppServerPrompts()).toEqual([]);
  });

  it("retains a visible prompt on response-write failure, validates decisions, and expires unanswered prompts", () => {
    vi.useFakeTimers();
    const fake = createRpc();
    const detach = attachCodexAppServerPrompts(fake.rpc, "thread-1");
    try {
      fake.emit({ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", command: "echo hi" } });
      const request = listPendingCodexAppServerPrompts()[0]!;
      expect(() => respondCodexAppServerPrompt(request.id, "yes" as never)).toThrow(/Approve or Decline/);
      fake.answerServerRequest.mockImplementationOnce(() => { throw new Error("write failed"); });
      expect(() => respondCodexAppServerPrompt(request.id, "approve")).toThrow("write failed");
      expect(listPendingCodexAppServerPrompts()).toHaveLength(1);
      vi.advanceTimersByTime(5 * 60_000);
      expect(listPendingCodexAppServerPrompts()).toEqual([]);
      expect(fake.rejectServerRequest).toHaveBeenCalledWith(1, expect.stringMatching(/timed out/));
    } finally { detach(); }
  });
  it("requires an explicit one-request command approval and resolves its UI", () => {
    const fake = createRpc();
    const events: Array<{ type: string; request?: { id: string; title: string }; requestId?: string }> = [];
    const unsubscribe = subscribeDashboardRealtime((message) => events.push(message));
    const detach = attachCodexAppServerPrompts(fake.rpc, "thread-1");
    try {
      fake.emit({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", command: "npm test", cwd: "D:/project" } });
      const request = events.find((event) => event.type === "dashboard:codex-request")?.request;
      expect(request).toMatchObject({ title: "Approve Codex command?" });
      expect(fake.answerServerRequest).not.toHaveBeenCalled();
      respondCodexAppServerPrompt(request!.id, "approve");
      expect(fake.answerServerRequest).toHaveBeenCalledWith(7, { decision: "accept" });
      expect(events).toContainEqual(expect.objectContaining({ type: "dashboard:codex-request-resolved", requestId: request!.id }));
      expect(() => respondCodexAppServerPrompt(request!.id, "approve")).toThrow(/no longer active/i);
    } finally { detach(); unsubscribe(); }
  });

  it("translates structured question answers into the app-server response", () => {
    const fake = createRpc();
    let requestId = "";
    const unsubscribe = subscribeDashboardRealtime((message) => {
      if (message.type === "dashboard:codex-request") requestId = message.request.id;
    });
    const detach = attachCodexAppServerPrompts(fake.rpc, "thread-2");
    try {
      fake.emit({ id: "q-1", method: "item/tool/requestUserInput", params: {
        threadId: "thread-2", questions: [{ id: "choice", header: "Choice", question: "Which one?", isSecret: false, options: [{ label: "A", description: "First" }] }]
      } });
      expect(() => respondCodexAppServerPrompt(requestId, "approve", {})).toThrow(/Answer/);
      respondCodexAppServerPrompt(requestId, "approve", { choice: "A" });
      expect(fake.answerServerRequest).toHaveBeenCalledWith("q-1", { answers: { choice: { answers: ["A"] } } });
    } finally { detach(); unsubscribe(); }
  });

  it("declines additional permissions without granting any scope", () => {
    const fake = createRpc();
    let requestId = "";
    const unsubscribe = subscribeDashboardRealtime((message) => {
      if (message.type === "dashboard:codex-request") requestId = message.request.id;
    });
    const detach = attachCodexAppServerPrompts(fake.rpc, "thread-3");
    try {
      fake.emit({ id: 9, method: "item/permissions/requestApproval", params: { threadId: "thread-3", permissions: { network: { enabled: true } } } });
      respondCodexAppServerPrompt(requestId, "decline");
      expect(fake.rejectServerRequest).toHaveBeenCalledWith(9, expect.stringMatching(/declined/i));
      expect(fake.answerServerRequest).not.toHaveBeenCalled();
    } finally { detach(); unsubscribe(); }
  });

  it("grants only the requested network and filesystem permissions for the current turn", () => {
    const fake = createRpc();
    const detach = attachCodexAppServerPrompts(fake.rpc, "permissions");
    const permissions = { network: { enabled: true }, fileSystem: { read: ["/project/input"], write: ["/project/output"] } };
    try {
      fake.emit({ id: 12, method: "item/permissions/requestApproval", params: { threadId: "permissions", permissions } });
      const request = listPendingCodexAppServerPrompts()[0]!;
      expect(fake.answerServerRequest).not.toHaveBeenCalled();
      respondCodexAppServerPrompt(request.id, "approve");
      expect(fake.answerServerRequest).toHaveBeenCalledExactlyOnceWith(12, { permissions, scope: "turn" });
      expect(listPendingCodexAppServerPrompts()).toEqual([]);
    } finally { detach(); }
  });

  it("preserves secret answer whitespace and validates all questions before sending any response", () => {
    const fake = createRpc();
    const detach = attachCodexAppServerPrompts(fake.rpc, "answers");
    try {
      fake.emit({ id: 13, method: "item/tool/requestUserInput", params: { threadId: "answers", questions: [
        { id: "layout", header: "Layout", question: "Which layout?", isSecret: false },
        { id: "secret", header: "Secret", question: "Secret?", isSecret: true }
      ] } });
      const request = listPendingCodexAppServerPrompts()[0]!;
      expect(() => respondCodexAppServerPrompt(request.id, "approve", { layout: "Compact" })).toThrow(/Answer/);
      expect(fake.answerServerRequest).not.toHaveBeenCalled();
      respondCodexAppServerPrompt(request.id, "approve", { layout: " Compact ", secret: "  private value  " });
      expect(fake.answerServerRequest).toHaveBeenCalledExactlyOnceWith(13, { answers: { layout: { answers: ["Compact"] }, secret: { answers: ["  private value  "] } } });
    } finally { detach(); }
  });

  it("keeps unsupported permission grants pending for a visible decline instead of accepting them", () => {
    const fake = createRpc();
    const detach = attachCodexAppServerPrompts(fake.rpc, "unsupported");
    try {
      fake.emit({ id: 14, method: "item/permissions/requestApproval", params: { threadId: "unsupported", permissions: { unknownScope: true } } });
      const request = listPendingCodexAppServerPrompts()[0]!;
      expect(() => respondCodexAppServerPrompt(request.id, "approve")).toThrow(/not supported/);
      expect(fake.answerServerRequest).not.toHaveBeenCalled();
      expect(listPendingCodexAppServerPrompts()).toHaveLength(1);
      respondCodexAppServerPrompt(request.id, "decline");
      expect(fake.rejectServerRequest).toHaveBeenCalledWith(14, expect.stringContaining("declined"));
    } finally { detach(); }
  });
});
