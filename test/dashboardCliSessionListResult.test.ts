import { describe, expect, it } from "vitest";
import { classifyCliSessionListResult } from "../webview-src/dashboard/cliSessionListResult";

describe("dashboard session-list result routing", () => {
  it("ignores stale realtime pushes without consuming a pending manual refresh", () => {
    expect(classifyCliSessionListResult("realtime-cli-1", 5, 5, "manual-1")).toEqual({
      apply: false,
      explicitRefresh: false,
      nextRealtimeRevision: 5
    });
  });

  it("acknowledges a matching manual refresh without replacing newer sessions", () => {
    expect(classifyCliSessionListResult("manual-1", 5, 5, "manual-1")).toEqual({
      apply: false,
      explicitRefresh: true,
      nextRealtimeRevision: 5
    });
  });

  it("advances the revision for fresh pushes without claiming manual-refresh completion", () => {
    expect(classifyCliSessionListResult("realtime-cli-2", 6, 5, "manual-1")).toEqual({
      apply: true,
      explicitRefresh: false,
      nextRealtimeRevision: 6
    });
  });

  it("rejects an older direct list response after a newer realtime revision", () => {
    expect(classifyCliSessionListResult("request-1", 5, 8)).toEqual({
      apply: false,
      explicitRefresh: false,
      nextRealtimeRevision: 8
    });
  });

  it('keeps a newer push when a direct response has no revision', () => {
    expect(classifyCliSessionListResult('request-1', undefined, 8, undefined, 5).apply).toBe(false);
    expect(classifyCliSessionListResult('request-1', undefined, 8, 'request-1', 5)).toMatchObject({apply:false,explicitRefresh:true});
    expect(classifyCliSessionListResult('request-2', undefined, 8, undefined, 8).apply).toBe(true);
    expect(classifyCliSessionListResult('legacy', undefined, 8).apply).toBe(true);
  });

  it('accepts an authoritative full list at the same revision as a partial push', () => {
    expect(classifyCliSessionListResult('request-1', 8, 8).apply).toBe(true);
    expect(classifyCliSessionListResult('realtime-peer-pc-1', 8, 8).apply).toBe(false);
  });
});
