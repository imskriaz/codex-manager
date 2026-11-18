import { describe, expect, it } from "vitest";
import { mapClaudeModels, mapDiscoveredModels, MODEL_PLACEHOLDER } from "../webview-src/dashboard/apiProxyModelMapping";

describe("API proxy model mapping", () => {
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
