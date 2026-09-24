import { describe, expect, it } from "vitest";
import { getActionTimeoutMs } from "../webview-src/dashboard/host";

describe("dashboard action timeouts", () => {
  it("allows quota refreshes enough time for quota and subscription requests", () => {
    expect(getActionTimeoutMs("refresh")).toBe(120_000);
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
