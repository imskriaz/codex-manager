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
});
