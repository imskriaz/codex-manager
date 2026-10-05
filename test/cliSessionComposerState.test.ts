import { describe, expect, it } from "vitest";
import { acknowledgeCliComposerDraft, cliComposerDraftKey, normalizeCliComposerDraft, resolveCliComposerSettings } from "../webview-src/dashboard/cliSessionComposerState";

describe("durable Codex composer state", () => {
  it("separates devices and new project drafts from existing chats", () => {
    expect(cliComposerDraftKey("pc-a", "chat")).not.toBe(cliComposerDraftKey("pc-b", "chat"));
    expect(cliComposerDraftKey("pc-a", undefined, "D:/work")).not.toBe(cliComposerDraftKey("pc-b", undefined, "D:/work"));
    expect(cliComposerDraftKey(undefined, "D:/work")).not.toBe(cliComposerDraftKey(undefined, undefined, "D:/work"));
  });
  it("rejects corrupt, oversized and unsupported stored inputs", () => {
    expect(normalizeCliComposerDraft({ text: "x".repeat(64_001), attachments: [] })).toBeUndefined();
    expect(normalizeCliComposerDraft({ text: "hello", attachments: [{ id: "bad", kind: "executable" }] })).toBeUndefined();
    expect(normalizeCliComposerDraft({ text: "hello", attachments: [], sandboxMode: "root" })).toEqual({ text: "hello", attachments: [] });
  });
  it("clears only confirmed submitted content and preserves edits/settings", () => {
    const submitted = { text: "first", attachments: [], model: "chosen" };
    expect(acknowledgeCliComposerDraft(submitted, submitted)).toEqual({ ...submitted, text: "" });
    expect(acknowledgeCliComposerDraft({ ...submitted, text: "follow-up", model: "next" }, submitted)).toEqual({ text: "follow-up", attachments: [], model: "next" });
  });
  it("restores settings offline and validates them against the fresh model catalog", () => {
    const saved = { text: "draft", attachments: [], model: "retired", reasoningEffort: "xhigh", sandboxMode: "read-only" as const };
    expect(resolveCliComposerSettings(saved, undefined)).toMatchObject({ model: "retired", reasoningEffort: "xhigh", sandboxMode: "read-only" });
    expect(resolveCliComposerSettings(saved, { models: [{ id: "available", label: "Available", reasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }], defaultSandboxMode: "workspace-write" })).toEqual({ model: "available", reasoningEffort: "medium", sandboxMode: "read-only" });
  });
});
