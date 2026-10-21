import { describe, expect, it } from "vitest";
import { createActionRequestId, getActionTimeoutMs, isAutomaticRequest } from "../webview-src/dashboard/host";
import fs from "node:fs";
import path from "node:path";
import { getPeerActionTimeoutMs } from "../src/services/webDashboardServer";

describe("dashboard action timeouts", () => {
  it("keeps manual resume within both browser and remote action deadlines", () => {
    expect(getActionTimeoutMs("resumeCodexSessions")).toBe(75_000);
    expect(getPeerActionTimeoutMs("resumeCodexSessions")).toBe(75_000);
  });
  it("keeps token history timeouts in chart settings", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../webview-src/dashboard/actionHooks.ts"), "utf8");
    expect(source).toContain('request.action !== "getDailyUsage"');
    expect(source).toContain('request.action !== "getUsageGraph"');
    expect(source).toContain("onActionTimeoutRef.current?.(request.action, request.requestId)");
  });
  it("keeps automatic timeouts quiet while still updating the initiating session view", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../webview-src/dashboard/actionHooks.ts"), "utf8");
    expect(source).toMatch(/if \(!isAutomaticRequest\(request\.requestId\)[^;]*onNotice\(noticeFromActionTimeout\(request\.action\)\);/);
    expect(source).toContain("onActionTimeoutRef.current?.(request.action, request.requestId)");
    expect(source).toContain("createActionRequestId(payload?.automatic)");
    expect(isAutomaticRequest(createActionRequestId(true))).toBe(true);
    expect(isAutomaticRequest(createActionRequestId())).toBe(false);
    expect(isAutomaticRequest("realtime-cli-123")).toBe(true);
  });
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
    for (const action of ["startProjectTask","startProjectSubtask"] as const) { expect(getActionTimeoutMs(action)).toBe(915_000); expect(getPeerActionTimeoutMs(action)).toBe(915_000); }
    expect(getActionTimeoutMs('moveProjectTask')).toBe(65_000); expect(getPeerActionTimeoutMs('moveProjectTask')).toBe(65_000);
    expect(getActionTimeoutMs("startCodexCliSession")).toBe(915_000);
    expect(getActionTimeoutMs("sendCodexCliSessionMessage")).toBe(915_000);
  });
});
