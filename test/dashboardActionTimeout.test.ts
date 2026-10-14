import { describe, expect, it } from "vitest";
import { BLOCKING_GLOBAL_ACTIONS, getActionTimeoutMs } from "../webview-src/dashboard/host";

describe("dashboard action timeouts", () => {
  it("keeps unrelated controls usable during sync, exports, OAuth and quota batches", () => {
    for (const action of ["syncNow", "configureEncryptedSync", "exportBackup", "addAccount", "refreshAll", "batchRefresh"] as const)
      expect(BLOCKING_GLOBAL_ACTIONS.has(action)).toBe(false);
    expect(BLOCKING_GLOBAL_ACTIONS.has("unloadAuth")).toBe(true);
    expect(getActionTimeoutMs("batchRefresh", 4)).toBe(960_000);
    expect(getActionTimeoutMs("refreshAll", 3)).toBe(720_000);
  });
  it("allows quota refreshes enough time for quota and subscription requests", () => {
    expect(getActionTimeoutMs("refresh")).toBe(240_000);
    expect(getActionTimeoutMs("refreshToken")).toBe(120_000);
    expect(getActionTimeoutMs("enableAllValid")).toBe(30_000);
    expect(getActionTimeoutMs("disableAll")).toBe(30_000);
  });

  it("waits for both Settings Sync passes before timing out the dashboard action", () => {
    expect(getActionTimeoutMs("configureEncryptedSync")).toBe(135_000);
    expect(getActionTimeoutMs("syncNow")).toBe(135_000);
  });

  it("allows a CLI start or send to finish its full 15-minute run and report a result", () => {
    expect(getActionTimeoutMs("startCodexCliSession")).toBe(915_000);
    expect(getActionTimeoutMs("sendCodexCliSessionMessage")).toBe(915_000);
  });
});
