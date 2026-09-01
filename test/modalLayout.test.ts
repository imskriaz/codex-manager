import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("dashboard modal layout", () => {
  it("keeps action confirmations compact after the settings modal skin", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    const settingsSkin = css.lastIndexOf("/* Settings control center:");
    const compactRules = css.lastIndexOf("/* Action dialogs stay intentionally small.");

    expect(compactRules).toBeGreaterThan(settingsSkin);
    expect(css).toMatch(/\.dashboard-modal-compact\s*\{[\s\S]*?width:\s*min\(520px/);
    expect(css).toMatch(/\.dashboard-confirm-modal\s*\{[\s\S]*?width:\s*min\(480px/);
    expect(css).toMatch(/--dashboard-z-overlay:\s*30000/);
    expect(css).toMatch(/\.overlay:has\(\.dashboard-confirm-modal\),[\s\S]*?z-index:\s*var\(--dashboard-z-action\)/);
    expect(css).toMatch(/\.dashboard-modal-compact \.dashboard-modal-body\s*\{[\s\S]*?gap:\s*8px/);
  });
});
