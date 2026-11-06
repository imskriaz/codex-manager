import { describe, expect, it } from "vitest";
import { acknowledgeCliComposerDraft, cliComposerDraftKey, cliContextUsage, isCliSubmissionEcho, normalizeCliComposerDraft, resolveCliComposerSettings, restoreFailedCliComposerDraft } from "../webview-src/dashboard/cliSessionComposerState";

describe("durable Codex composer state", () => {
  it('acknowledges only a newly observed user message in the expected turn', () => {
    const draft = { text: 'Follow up', attachments: [] };
    const echo = { id: 'new', role: 'user' as const, text: 'Follow up', turnId: 'turn' };
    expect(isCliSubmissionEcho(echo, draft, new Set(['old']), 'turn')).toBe(true);
    for (const patch of [{ id: 'old' }, { role: 'assistant' as const }, { text: 'Other prompt' }, { turnId: 'other' }, { kind: 'command' as const }, { images: [{ src: 'data:image/png;base64,AA==' }] }]) {
      expect(isCliSubmissionEcho({ ...echo, ...patch }, draft, new Set(['old']), 'turn')).toBe(false);
    }
    const attachment = { id: 'note', name: 'note.txt', kind: 'text' as const, mimeType: 'text/plain', size: 4, data: 'test' };
    expect(isCliSubmissionEcho({ ...echo, textAttachments: [{ name: 'note.txt', text: 'test' }] }, { ...draft, attachments: [attachment] }, new Set(), 'turn')).toBe(true);
    expect(isCliSubmissionEcho(echo, { ...draft, attachments: [attachment] }, new Set(), 'turn')).toBe(false);
  });
  it('uses reported context tokens, clamps the ring, and leaves missing usage unknown', () => {
    expect(cliContextUsage({ total: 250, contextWindow: 1000 })).toEqual({ used: 250, limit: 1000, percent: 25 });
    expect(cliContextUsage({ total: 0, contextWindow: 1000 })?.percent).toBe(0);
    expect(cliContextUsage({ total: 2000, contextWindow: 1000 })?.percent).toBe(100);
    for (const usage of [undefined, {}, { total: 1 }, { total: -1, contextWindow: 100 }, { total: 1, contextWindow: 0 }, { total: NaN, contextWindow: 10 }]) expect(cliContextUsage(usage)).toBeUndefined();
  });
  it('uses existing-session model and effort until the user overrides them, including before the catalog arrives', () => {
    const session = { model: 'session-model', reasoningEffort: 'high' };
    const config = { models: [{ id: 'default', label: 'Default', reasoningEfforts: ['medium'] }, { id: 'session-model', label: 'Session', reasoningEfforts: ['medium', 'high'] }], defaultModel: 'default', defaultSandboxMode: 'workspace-write' as const };
    expect(resolveCliComposerSettings(undefined, undefined, session)).toMatchObject(session);
    expect(resolveCliComposerSettings(undefined, config, session)).toMatchObject(session);
    expect(resolveCliComposerSettings({ text: '', attachments: [], model: 'default' }, config, session).model).toBe('default');
  });
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
  it("restores a failed send without replacing newer editor content", () => {
    const submitted = { text: "first", attachments: [], model: "chosen" };
    expect(restoreFailedCliComposerDraft({ ...submitted, text: "" }, submitted)).toEqual(submitted);
    expect(restoreFailedCliComposerDraft({ ...submitted, text: "follow-up" }, submitted).text).toBe("follow-up");
  });
  it('clears submitted text and attachments immediately and restores them on failure', () => {
    const submitted={text:'Follow up',attachments:[{id:'note',kind:'text' as const,name:'note.txt',mimeType:'text/plain',size:4,data:'test'}],model:'chosen'};
    const cleared=acknowledgeCliComposerDraft(submitted,submitted);
    expect(cleared).toEqual({...submitted,text:'',attachments:[]});
    expect(restoreFailedCliComposerDraft(cleared,submitted)).toEqual(submitted);
    expect(restoreFailedCliComposerDraft({...cleared,text:'New edit'},submitted).text).toBe('New edit');
  });
  it("restores settings offline and validates them against the fresh model catalog", () => {
    const saved = { text: "draft", attachments: [], model: "retired", reasoningEffort: "xhigh", sandboxMode: "read-only" as const };
    expect(resolveCliComposerSettings(saved, undefined)).toMatchObject({ model: "retired", reasoningEffort: "xhigh", sandboxMode: "read-only" });
    expect(resolveCliComposerSettings(saved, { models: [{ id: "available", label: "Available", reasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }], defaultSandboxMode: "workspace-write" })).toEqual({ model: "available", reasoningEffort: "medium", sandboxMode: "read-only" });
  });
});

it('uses Codex session access rather than a stale saved composer override or global default', () => {
  const draft={text:'Unsent',attachments:[],sandboxMode:'workspace-write' as const};
  const config={models:[],defaultSandboxMode:'workspace-write' as const};
  expect(resolveCliComposerSettings(draft,config,{sandboxMode:'danger-full-access'}).sandboxMode).toBe('danger-full-access');
  expect(resolveCliComposerSettings(draft,config,{}).sandboxMode).toBeUndefined();
  expect(resolveCliComposerSettings(draft,config).sandboxMode).toBe('workspace-write');
});

it('defaults new workspaces to Full while preserving explicit drafts and reported session access', () => {
  expect(resolveCliComposerSettings(undefined, undefined).sandboxMode).toBe('danger-full-access');
  expect(resolveCliComposerSettings({ text: '', attachments: [], sandboxMode: 'read-only' }, undefined).sandboxMode).toBe('read-only');
  expect(resolveCliComposerSettings(undefined, undefined, { sandboxMode: 'workspace-write' }).sandboxMode).toBe('workspace-write');
  expect(resolveCliComposerSettings(undefined, undefined, {}).sandboxMode).toBeUndefined();
});

it('defaults browser sessions to Full despite a restrictive host default and persists explicit approval choices', () => {
  const config = { models: [], defaultSandboxMode: 'read-only' as const };
  expect(resolveCliComposerSettings(undefined, config, undefined, 'danger-full-access').sandboxMode).toBe('danger-full-access');
  const draft = { text: '', attachments: [], sandboxMode: 'workspace-write' as const, autoApprove: true };
  expect(normalizeCliComposerDraft(draft)).toEqual(draft);
  expect(resolveCliComposerSettings(draft, config, undefined, 'danger-full-access').sandboxMode).toBe('workspace-write');
});
