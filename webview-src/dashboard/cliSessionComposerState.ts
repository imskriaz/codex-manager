import type { DashboardCliComposerConfig, DashboardCliSandboxMode } from "../../src/domain/dashboard/types";
import { validateChatAttachments, type ChatAttachment } from "../../src/domain/chatAttachments";

export type CliComposerDraft = {
  text: string;
  attachments: ChatAttachment[];
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: DashboardCliSandboxMode;
};
export type CliSubmissionResult = { requestId: string; status: "completed" | "failed" | "cancelled" };

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

export function resolveCliComposerSettings(draft: CliComposerDraft | undefined, config: DashboardCliComposerConfig | undefined) {
  const model = config?.models.find((option) => option.id === draft?.model)
    ?? config?.models.find((option) => option.id === config.defaultModel) ?? config?.models[0];
  const reasoningEffort = model?.reasoningEfforts.includes(draft?.reasoningEffort ?? "")
    ? draft?.reasoningEffort
    : model?.reasoningEfforts.includes(config?.defaultReasoningEffort ?? "")
      ? config?.defaultReasoningEffort : model?.defaultReasoningEffort ?? model?.reasoningEfforts[0];
  return { model: model?.id ?? (!config?.models.length ? draft?.model ?? config?.defaultModel : undefined), reasoningEffort: reasoningEffort ?? (!config?.models.length ? draft?.reasoningEffort ?? config?.defaultReasoningEffort : undefined),
    sandboxMode: draft?.sandboxMode ?? config?.defaultSandboxMode ?? "workspace-write" as DashboardCliSandboxMode };
}

/** Clear only the submitted content, preserving edits made while it was in flight. */
export function acknowledgeCliComposerDraft(current: CliComposerDraft, submitted: CliComposerDraft): CliComposerDraft {
  return { ...current,
    text: current.text === submitted.text ? "" : current.text,
    attachments: JSON.stringify(current.attachments) === JSON.stringify(submitted.attachments) ? [] : current.attachments };
}
