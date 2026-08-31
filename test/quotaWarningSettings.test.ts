import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("quota warning settings UI", () => {
  it("renders independently committed 5-hour and weekly ranges", () => {
    const source = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");

    expect(source).toContain('patchAndSend("quotaWarningThreshold", value)');
    expect(source).toContain('value={props.settings.quotaWarningWeeklyThreshold}');
    expect(source).toContain("const WARNING_VALUES = Array.from({ length: 91 }, (_, index) => index)");
    expect(source).toContain("const WEEKLY_WARNING_VALUES = WARNING_VALUES");
    expect(source).toContain("const WARNING_SCALE_VALUES = [0, 20, 40, 60, 80, 90]");
    expect(source).toContain('patchAndSend("quotaWarningWeeklyThreshold", value)');
    expect(source).not.toContain("autoSwitchLockMinutesTitle");
  });

  it("lets Cloudflared domains be entered without a URL scheme", () => {
    const settingsSource = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");
    const onboardingSource = readFileSync("webview-src/dashboard/onboardingModal.tsx", "utf8");

    expect(settingsSource).toContain('placeholder="codex.example.com"');
    expect(settingsSource).toContain('type="text"');
    expect(onboardingSource).toContain('placeholder="codex.example.com"');
    expect(onboardingSource).toContain("no https:// required");
  });
});
