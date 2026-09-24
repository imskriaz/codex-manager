import { describe, expect, it, vi } from "vitest";
import { attachCodexAppServerPrompts, respondCodexAppServerPrompt } from "../src/services/codexAppServerPrompts";
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

describe("Codex app-server dashboard prompts", () => {
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
});
