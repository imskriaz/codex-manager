import { randomUUID } from "crypto";
import type { DashboardCodexServerRequest } from "../domain/dashboard/types";
import { publishDashboardRealtime } from "./dashboardRealtime";
import type { AppServerRequest, CodexAppServerRpc } from "./codexAppServerRpc";

type PendingPrompt = {
  rpc: CodexAppServerRpc;
  serverId: string | number;
  method: string;
  params: Record<string, unknown>;
  request: DashboardCodexServerRequest;
  timer: NodeJS.Timeout;
};

const pendingPrompts = new Map<string, PendingPrompt>();
const PROMPT_TIMEOUT_MS = 5 * 60_000;

export function listPendingCodexAppServerPrompts(): DashboardCodexServerRequest[] {
  return [...pendingPrompts.values()].map((pending) => pending.request);
}

/** Route app-server approval and question requests through the dashboard.
 * Unsupported requests fail closed; no permission is granted automatically. */
export function attachCodexAppServerPrompts(rpc: CodexAppServerRpc, threadId: string): () => void {
  const off = rpc.onServerRequest((serverRequest) => {
    const request = toDashboardRequest(serverRequest, threadId);
    if (!request) {
      rpc.rejectServerRequest(serverRequest.id, `Codex Manager cannot safely answer ${serverRequest.method}.`);
      return;
    }
    const timer = setTimeout(() => {
      const pending = pendingPrompts.get(request.id);
      if (!pending) return;
      pendingPrompts.delete(request.id);
      try { pending.rpc.rejectServerRequest(pending.serverId, "The dashboard prompt timed out without a user answer."); } catch { /* connection closed */ }
      publishDashboardRealtime({ type: "dashboard:codex-request-resolved", requestId: request.id });
    }, PROMPT_TIMEOUT_MS);
    pendingPrompts.set(request.id, { rpc, serverId: serverRequest.id, method: serverRequest.method,
      params: serverRequest.params && typeof serverRequest.params === "object" ? serverRequest.params as Record<string, unknown> : {}, request, timer });
    publishDashboardRealtime({ type: "dashboard:codex-request", request });
  });
  return () => {
    off();
    for (const [id, pending] of pendingPrompts) {
      if (pending.rpc !== rpc) continue;
      clearTimeout(pending.timer);
      pendingPrompts.delete(id);
      publishDashboardRealtime({ type: "dashboard:codex-request-resolved", requestId: id });
    }
  };
}

export function respondCodexAppServerPrompt(
  requestId: string,
  decision: "approve" | "decline",
  answers?: Record<string, string>
): void {
  const pending = pendingPrompts.get(requestId);
  if (!pending) throw new Error("This Codex prompt is no longer active. Refresh the session before continuing.");
  let response: unknown;
  if (pending.request.kind === "question") {
    if (decision === "decline") {
      pending.rpc.rejectServerRequest(pending.serverId, "The user dismissed the question.");
      finishPrompt(requestId, pending);
      return;
    }
    const result: Record<string, { answers: string[] }> = {};
    for (const question of pending.request.questions ?? []) {
      const answer = answers?.[question.id]?.trim();
      if (!answer) throw new Error(`Answer “${question.header || question.question}” before continuing.`);
      if (answer.length > 8_000) throw new Error("Keep each answer under 8,000 characters.");
      result[question.id] = { answers: [answer] };
    }
    response = { answers: result };
  } else {
    if (pending.method === "item/permissions/requestApproval") {
      if (decision === "decline") {
        pending.rpc.rejectServerRequest(pending.serverId, "The user declined additional permissions.");
        finishPrompt(requestId, pending);
        return;
      }
      const requested = pending.params["permissions"];
      if (!requested || typeof requested !== "object") throw new Error("The requested permission details are missing. Decline this request and refresh the session.");
      const profile = requested as { network?: unknown; fileSystem?: unknown };
      response = { permissions: {
        ...(profile.network ? { network: profile.network } : {}),
        ...(profile.fileSystem ? { fileSystem: profile.fileSystem } : {})
      }, scope: "turn" };
    } else {
    const legacy = pending.method === "execCommandApproval" || pending.method === "applyPatchApproval";
    response = { decision: legacy ? (decision === "approve" ? "approved" : { denied: { rejection: "The user declined this action." } }) : (decision === "approve" ? "accept" : "decline") };
    }
  }
  pending.rpc.answerServerRequest(pending.serverId, response);
  finishPrompt(requestId, pending);
}

function finishPrompt(requestId: string, pending: PendingPrompt): void {
  clearTimeout(pending.timer);
  pendingPrompts.delete(requestId);
  publishDashboardRealtime({ type: "dashboard:codex-request-resolved", requestId });
}

function toDashboardRequest(serverRequest: AppServerRequest, fallbackThreadId: string): DashboardCodexServerRequest | undefined {
  const params = serverRequest.params && typeof serverRequest.params === "object"
    ? serverRequest.params as Record<string, unknown> : {};
  const method = serverRequest.method;
  const threadId = typeof params["threadId"] === "string" ? params["threadId"] : fallbackThreadId;
  const id = randomUUID();
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const rawCommand = params["command"];
    const command = typeof rawCommand === "string" ? rawCommand : Array.isArray(rawCommand) ? rawCommand.join(" ") : undefined;
    return {
      id, threadId, kind: "command", title: "Approve Codex command?",
      detail: [typeof params["reason"] === "string" ? params["reason"] : undefined, command].filter(Boolean).join("\n\n").slice(0, 8_000),
      cwd: typeof params["cwd"] === "string" ? params["cwd"] : undefined
    };
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const files = params["fileChanges"] && typeof params["fileChanges"] === "object"
      ? Object.keys(params["fileChanges"] as Record<string, unknown>).slice(0, 20) : [];
    return {
      id, threadId, kind: "file-change", title: "Approve Codex file changes?",
      detail: [typeof params["reason"] === "string" ? params["reason"] : undefined, files.join("\n"), typeof params["grantRoot"] === "string" ? `Requested write root: ${params["grantRoot"]}` : undefined].filter(Boolean).join("\n\n").slice(0, 8_000)
    };
  }
  if (method === "item/permissions/requestApproval") {
    const requested = params["permissions"];
    return {
      id, threadId, kind: "permissions", title: "Grant Codex additional permissions?",
      detail: [typeof params["reason"] === "string" ? params["reason"] : undefined,
        requested ? JSON.stringify(requested, null, 2) : undefined].filter(Boolean).join("\n\n").slice(0, 8_000),
      cwd: typeof params["cwd"] === "string" ? params["cwd"] : undefined
    };
  }
  if (method === "item/tool/requestUserInput") {
    const rawQuestions = Array.isArray(params["questions"]) ? params["questions"] : [];
    const questions = rawQuestions.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
      .slice(0, 3).map((value) => ({
        id: safeString(value["id"]), header: safeString(value["header"]), question: safeString(value["question"]),
        isSecret: value["isSecret"] === true,
        options: Array.isArray(value["options"]) ? value["options"].filter((option): option is Record<string, unknown> => Boolean(option && typeof option === "object"))
          .map((option) => ({ label: safeString(option["label"]), description: safeString(option["description"]) })) : undefined
      }));
    if (!questions.length || questions.some((question) => !question.id || !question.question)) return undefined;
    return { id, threadId, kind: "question", title: "Codex has a question", questions };
  }
  return undefined;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
