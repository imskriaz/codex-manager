import type { DashboardCliComposerConfig, DashboardCliSandboxMode, DashboardCliSessionSummary, DashboardCliSessionMessage, DashboardCodexSessionLiveState } from "../../src/domain/dashboard/types";
import { validateChatAttachments, type ChatAttachment } from "../../src/domain/chatAttachments";

export type CliComposerDraft = {
  text: string;
  attachments: ChatAttachment[];
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: DashboardCliSandboxMode;
};
export type CliSubmissionResult = { requestId: string; status: "completed" | "failed" | "cancelled"; message?: string; fileRevision?: string };

/** An existing running marker alone does not acknowledge a follow-up. */
export function isCliSubmissionEcho(message: DashboardCliSessionMessage, submitted: CliComposerDraft, seenIds: Set<string>, turnId?: string): boolean {
  if (seenIds.has(message.id) || message.role !== "user" || (message.kind && message.kind !== "message") || (turnId && message.turnId && message.turnId !== turnId)) return false;
  return message.text.trim() === submitted.text.trim()
    && JSON.stringify(message.textAttachments ?? []) === JSON.stringify(submitted.attachments.filter(file => file.kind === "text").map(file => ({ name: file.name, text: file.data })))
    && (message.images?.length ?? 0) === submitted.attachments.filter(file => file.kind === "image").length;
}

export function cliContextUsage(usage: DashboardCodexSessionLiveState["tokenUsage"]) {
  if (typeof usage?.total !== "number" || !Number.isFinite(usage.total) || usage.total < 0 || typeof usage.contextWindow !== "number" || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return undefined;
  return { used: usage.total, limit: usage.contextWindow, percent: Math.min(100, Math.round(usage.total / usage.contextWindow * 100)) };
}

export function cliComposerDraftKey(deviceId: string | undefined, sessionId: string | undefined, projectPath?: string): string {
  return JSON.stringify([deviceId ?? "local", sessionId ? "session" : "new", sessionId ?? projectPath?.trim() ?? ""]);
}

export function normalizeCliComposerDraft(value: unknown): CliComposerDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const draft = value as Record<string, unknown>;
  if (typeof draft["text"] !== "string" || draft["text"].length > 64_000) return undefined;
  try {
    return {
      text: draft["text"], attachments: validateChatAttachments(draft["attachments"]),
      ...(typeof draft["model"] === "string" && draft["model"].length <= 200 ? { model: draft["model"] } : {}),
      ...(typeof draft["reasoningEffort"] === "string" && /^[a-z]{1,20}$/.test(draft["reasoningEffort"]) ? { reasoningEffort: draft["reasoningEffort"] } : {}),
      ...(["read-only", "workspace-write", "danger-full-access"].includes(String(draft["sandboxMode"]))
        ? { sandboxMode: draft["sandboxMode"] as DashboardCliSandboxMode } : {})
    };
  } catch {
    return undefined;
  }
}

export function resolveCliComposerSettings(draft: CliComposerDraft | undefined, config: DashboardCliComposerConfig | undefined, session?: Pick<DashboardCliSessionSummary, "model" | "reasoningEffort">) {
  const preferredModel = draft?.model ?? session?.model;
  const preferredEffort = draft?.reasoningEffort ?? session?.reasoningEffort;
  const model = config?.models.find((option) => option.id === preferredModel)
    ?? config?.models.find((option) => option.id === config.defaultModel) ?? config?.models[0];
  const reasoningEffort = model?.reasoningEfforts.includes(preferredEffort ?? "")
    ? preferredEffort
    : model?.reasoningEfforts.includes(config?.defaultReasoningEffort ?? "")
      ? config?.defaultReasoningEffort : model?.defaultReasoningEffort ?? model?.reasoningEfforts[0];
  return { model: model?.id ?? (!config?.models.length ? preferredModel ?? config?.defaultModel : undefined), reasoningEffort: reasoningEffort ?? (!config?.models.length ? preferredEffort ?? config?.defaultReasoningEffort : undefined),
    sandboxMode: draft?.sandboxMode ?? config?.defaultSandboxMode ?? "workspace-write" as DashboardCliSandboxMode };
}

/** Clear only the submitted content, preserving edits made while it was in flight. */
export function acknowledgeCliComposerDraft(current: CliComposerDraft, submitted: CliComposerDraft): CliComposerDraft {
  return { ...current,
    text: current.text === submitted.text ? "" : current.text,
    attachments: JSON.stringify(current.attachments) === JSON.stringify(submitted.attachments) ? [] : current.attachments };
}

/** Restore only content that is still empty after an unconfirmed send. */
export function restoreFailedCliComposerDraft(current: CliComposerDraft, submitted: CliComposerDraft): CliComposerDraft {
  return { ...current,
    text: current.text ? current.text : submitted.text,
    attachments: current.attachments.length ? current.attachments : submitted.attachments };
}
