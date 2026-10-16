import { describe, expect, it } from "vitest";
import { getActionTimeoutMs } from "../webview-src/dashboard/host";
import fs from "node:fs";
import path from "node:path";

describe("dashboard action timeouts", () => {
  it("does not show a banner for optional live-channel reconnects", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../webview-src/dashboard/main.tsx"), "utf8");
    expect(source).toContain('(browserHostStage === "unreachable" || browserHostStage === "offline")');
    expect(source).not.toContain("Live updates paused");
    expect(source).not.toContain("Checking the live channel");
  });

  it("never disables unrelated controls for a pending global action", () => {
    for (const file of ["host.ts", "actionHooks.ts", "main.tsx"]) {
      const source = fs.readFileSync(path.resolve(__dirname, "../webview-src/dashboard", file), "utf8");
      expect(source).not.toMatch(/BLOCKING_GLOBAL_ACTIONS|hasGlobalPendingAction/);
    }
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
