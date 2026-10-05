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
  expiresAt: number;
};

const pendingPrompts = new Map<string, PendingPrompt>();
const PROMPT_TIMEOUT_MS = 5 * 60_000;
const MAX_PENDING_PROMPTS = 30;

export function listPendingCodexAppServerPrompts(): DashboardCodexServerRequest[] {
  for (const [id, pending] of pendingPrompts) if (Date.now() >= pending.expiresAt) {
    try { pending.rpc.rejectServerRequest(pending.serverId, "The dashboard prompt expired without a user answer."); } catch { /* disconnected */ }
    finishPrompt(id, pending);
  }
  return [...pendingPrompts.values()].map((pending) => pending.request);
}

/** Route app-server approval and question requests through the dashboard.
 * Unsupported requests fail closed; no permission is granted automatically. */
export function attachCodexAppServerPrompts(rpc: CodexAppServerRpc, threadId: string): () => void {
  const off = rpc.onServerRequest((serverRequest) => {
    if (Buffer.byteLength(JSON.stringify(serverRequest.params ?? {}), "utf8") > 32 * 1024) {
      rpc.rejectServerRequest(serverRequest.id, "This approval request is too large to review safely in the dashboard.");
      return;
    }
    const existing = [...pendingPrompts.values()].find((pending) => pending.rpc === rpc && pending.serverId === serverRequest.id);
    if (existing) {
      if (existing.method !== serverRequest.method || JSON.stringify(existing.params) !== JSON.stringify(serverRequest.params)) {
        rpc.rejectServerRequest(serverRequest.id, "Codex reused a pending request ID with different details.");
        finishPrompt(existing.request.id, existing);
      }
      return;
    }
    const request = toDashboardRequest(serverRequest, threadId);
    if (!request || pendingPrompts.size >= MAX_PENDING_PROMPTS || (threadId && request.threadId !== threadId)) {
      rpc.rejectServerRequest(serverRequest.id, `Codex Manager cannot safely answer ${serverRequest.method}.`);
      return;
    }
    const timer = setTimeout(() => {
      const pending = pendingPrompts.get(request.id);
      if (!pending) return;
      try { pending.rpc.rejectServerRequest(pending.serverId, "The dashboard prompt timed out without a user answer."); } catch { /* connection closed */ }
      finishPrompt(request.id, pending);
    }, PROMPT_TIMEOUT_MS);
    pendingPrompts.set(request.id, { rpc, serverId: serverRequest.id, method: serverRequest.method,
      params: serverRequest.params && typeof serverRequest.params === "object" ? serverRequest.params as Record<string, unknown> : {}, request, timer, expiresAt: Date.now() + PROMPT_TIMEOUT_MS });
    publishDashboardRealtime({ type: "dashboard:codex-request", request });
  });
  const cleanup = () => {
    off();
    for (const [id, pending] of pendingPrompts) {
      if (pending.rpc !== rpc) continue;
      try { pending.rpc.rejectServerRequest(pending.serverId, "The Codex session ended before this prompt was answered."); } catch { /* disconnected */ }
      finishPrompt(id, pending);
    }
  };
  const offDisconnect = rpc.onDisconnect?.(cleanup);
  return () => { offDisconnect?.(); cleanup(); };
}

export function respondCodexAppServerPrompt(
  requestId: string,
  decision: "approve" | "decline",
  answers?: Record<string, string>
): void {
  if (decision !== "approve" && decision !== "decline") throw new Error("Choose Approve or Decline for this Codex request.");
  const pending = pendingPrompts.get(requestId);
  if (!pending) throw new Error("This Codex prompt is no longer active. Refresh the session before continuing.");
  if (Date.now() >= pending.expiresAt) {
    try { pending.rpc.rejectServerRequest(pending.serverId, "The dashboard prompt expired without a user answer."); } catch { /* disconnected */ }
    finishPrompt(requestId, pending);
    throw new Error("This Codex prompt expired. Refresh the session before continuing.");
  }
  let response: unknown;
  if (pending.request.kind === "question") {
    if (decision === "decline") {
      pending.rpc.rejectServerRequest(pending.serverId, "The user dismissed the question.");
      finishPrompt(requestId, pending);
      return;
    }
    const result: Record<string, { answers: string[] }> = {};
    for (const question of pending.request.questions ?? []) {
      const answer = typeof answers?.[question.id] === "string" ? answers[question.id]!.trim() : undefined;
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
      if (Array.isArray(requested) || JSON.stringify(requested).length > 8000) throw new Error("The requested permission details cannot be reviewed safely. Decline this request.");
      const profile = requested as { network?: unknown; fileSystem?: unknown };
      if (Object.keys(profile).some((key) => key !== "network" && key !== "fileSystem")) throw new Error("This permission type is not supported. Decline the request.");
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
    if (!requested || typeof requested !== "object" || Array.isArray(requested) || JSON.stringify(requested).length > 7000) return undefined;
    return {
      id, threadId, kind: "permissions", title: "Grant Codex additional permissions?",
      detail: [typeof params["reason"] === "string" ? params["reason"].slice(0, 500) : undefined,
        JSON.stringify(requested)].filter(Boolean).join("\n\n").slice(0, 8_000),
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
          .slice(0, 20).map((option) => ({ label: safeString(option["label"]), description: safeString(option["description"]) })) : undefined
      }));
    if (rawQuestions.length > 3 || !questions.length || new Set(questions.map((question) => question.id)).size !== questions.length || questions.some((question) => !question.id || !question.question || question.id === "__proto__" || question.id === "constructor" || question.id.length > 128)) return undefined;
    return { id, threadId, kind: "question", title: "Codex has a question", questions };
  }
  return undefined;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 8000) : "";
}
