import { describe, expect, it } from "vitest";
import { createClaudeModelOptions, isClaudeModel, nativeClaudeModel } from "../src/domain/dashboard/claudeModels";

describe("native Claude catalogue", () => {
  it("uses only discovered native models and exact supported reasoning levels", () => {
    expect(createClaudeModelOptions([
      {value:"opus",displayName:"Opus",supportsEffort:true,supportedEffortLevels:["low","high","max"]},
      {value:"haiku",displayName:"Haiku",supportsEffort:false,supportedEffortLevels:["high"]},
      {value:"custom/model",displayName:"Gateway model",supportedEffortLevels:["medium"]}
    ])).toEqual([
      expect.objectContaining({id:"claude-code/opus",provider:"claude",reasoningEfforts:["low","high","max"],defaultReasoningEffort:"high"}),
      expect.objectContaining({id:"claude-code/haiku",reasoningEfforts:[],defaultReasoningEffort:undefined}),
      expect.objectContaining({id:"claude-code/custom/model",label:"Gateway model",reasoningEfforts:["medium"]})
    ]);
  });
  it("rejects invalid models, deduplicates aliases and never invents missing efforts", () => {
    expect(createClaudeModelOptions([{value:"bad model",displayName:"Bad"},{value:"a",displayName:"A"},{value:"a",displayName:"Duplicate"}])).toEqual([expect.objectContaining({id:"claude-code/a",reasoningEfforts:[]})]);
    expect(isClaudeModel("claude-opus")).toBe(false);
    expect(isClaudeModel("claude-code/opus")).toBe(true);
    expect(nativeClaudeModel("claude-code/opus")).toBe("opus");
    expect(()=>nativeClaudeModel("gpt-6")).toThrow();
    expect(()=>nativeClaudeModel("claude-code/;echo unsafe")).toThrow();
  });
});
