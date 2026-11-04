import { afterEach, describe, expect, it, vi } from "vitest";
import { attachCodexAppServerPrompts, cancelCodexAppServerPrompts, respondCodexAppServerPrompt, listPendingCodexAppServerPrompts, syncNativeCodexPrompts, clearNativeCodexPrompts } from "../src/services/codexAppServerPrompts";
import type { AppServerRequest, CodexAppServerRpc } from "../src/services/codexAppServerRpc";
import { subscribeDashboardRealtime } from "../src/services/dashboardRealtime";

function createRpc() {
  let receive: ((request: AppServerRequest) => void) | undefined;
  const answerServerRequest = vi.fn();
  const rejectServerRequest = vi.fn();
  const rpc = {
    onServerRequest: (listener: (request: AppServerRequest) => void) => { receive = listener; return () => { receive = undefined; }; },
    answerServerRequest,
    rejectServerRequest
  } as unknown as CodexAppServerRpc;
  return { rpc, emit: (request: AppServerRequest) => receive?.(request), answerServerRequest, rejectServerRequest };
}
afterEach(() => vi.useRealTimers());

it('preserves native question age across owner resync and prompt expiry', async () => {
  vi.useFakeTimers(); const source = {}, respond = vi.fn();
  const requests = [{ id: 'native-question', method: 'item/tool/requestUserInput', params: { threadId: 'native-age', questions: [{ id: 'choice', question: 'Continue?' }] } }];
  try {
    syncNativeCodexPrompts(source, 'native-age', requests, respond);
    const first = listPendingCodexAppServerPrompts().find(request => request.threadId === 'native-age')!;
    await vi.advanceTimersByTimeAsync(300_000);
    syncNativeCodexPrompts(source, 'native-age', requests, respond);
    expect(listPendingCodexAppServerPrompts().find(request => request.threadId === 'native-age')?.createdAt).toBe(first.createdAt);
    expect(respond).not.toHaveBeenCalled();
  } finally { clearNativeCodexPrompts(source); }
});

describe("Codex app-server dashboard prompts", () => {
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
