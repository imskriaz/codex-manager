import { describe, expect, it } from "vitest";
import { mapClaudeModels, mapDiscoveredModels, MODEL_PLACEHOLDER } from "../webview-src/dashboard/apiProxyModelMapping";
import { CLAUDE_PROXY_MODELS, CLAUDE_PROXY_MODEL_OVERRIDES, claudeProxyModelName } from '../src/domain/dashboard/apiProxy';

describe("API proxy model mapping", () => {
  it('uses versionless Claude aliases and names their actual Codex target', () => {
    expect(CLAUDE_PROXY_MODELS.opus).toBe('claude-opus');
    expect(claudeProxyModelName('opus', { id: 'gpt-6.1', name: 'GPT 6.1' })).toBe('claude-opus (GPT 6.1)');
    expect(claudeProxyModelName('sonnet', { id: 'gpt-6.1', name: 'gpt-6.1' })).toBe('claude-sonnet (GPT 6.1)');
    expect(Object.values(CLAUDE_PROXY_MODEL_OVERRIDES)).toEqual(Object.values(CLAUDE_PROXY_MODELS));
    expect(CLAUDE_PROXY_MODEL_OVERRIDES).toEqual({
      'claude-opus-5-5': 'claude-opus',
      'claude-sonnet-5-5': 'claude-sonnet',
      'claude-haiku-5-5': 'claude-haiku',
      'claude-fable-5-2': 'claude-fable'
    });
  });
  it("maps Claude roles to discovered IDs, including Fable and provider-qualified models", () => {
    const models = mapDiscoveredModels({
      data: [
        { id: "cx/claude-opus", display_name: "Claude Opus" },
        { id: "cx/claude-sonnet", displayName: "Claude Sonnet" },
        { id: "cx/claude-haiku", name: "Claude Haiku" },
        { id: "cx/claude-fable", label: "Claude Fable" }
      ]
    });
    expect(mapClaudeModels(models)).toEqual({
      model: "cx/claude-sonnet",
      opus: "cx/claude-opus",
      sonnet: "cx/claude-sonnet",
      haiku: "cx/claude-haiku",
      fable: "cx/claude-fable"
    });
  });

  it("uses a stable fallback when a catalogue has no Claude role names", () => {
    const models = mapDiscoveredModels({ data: [{ id: "cx/gpt-5.2-codex", name: "GPT-5.2 Codex" }] });
    expect(mapClaudeModels(models)).toEqual({
      model: "cx/gpt-5.2-codex",
      opus: "cx/gpt-5.2-codex",
      sonnet: "cx/gpt-5.2-codex",
      haiku: "cx/gpt-5.2-codex",
      fable: "cx/gpt-5.2-codex"
    });
    expect(mapDiscoveredModels({ data: [{ id: "" }, null, { id: "cx/gpt-5.2-codex" }] })).toHaveLength(1);
    expect(mapClaudeModels([]).model).toBe(MODEL_PLACEHOLDER);
  });
});
