import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("mobile dashboard header", () => {
  it("scales browser typography independently of geometry and applies mobile rules after legacy skins", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    const finalRules = css.lastIndexOf("/* Final compact layout rules");
    expect(finalRules).toBeGreaterThan(css.lastIndexOf("/* Requests stay with their session"));
    expect(css.slice(finalRules)).toContain('html[data-dashboard-host="browser"] { --dashboard-text-scale: 1.1; }');
    expect(css).not.toMatch(/\bfont-size\s*:\s*[\d.]+px\b/);
    expect(css).toContain("font-size: calc(16px * var(--dashboard-text-scale, 1))");
    expect(css.slice(finalRules)).toContain(".cli-workspace .cli-composer.is-empty { display: grid;");
    expect(css.slice(finalRules)).toContain(".cli-workspace .cli-account-footer .cli-account-footer-account { display: grid; }");
  });

  it("keeps card plan, reset credit, device and expiry on one line at every width", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(css).toMatch(/\.dashboard-view-cards \.saved-credit-summary\s*\{[^}]*flex-wrap:\s*nowrap;/);
    expect(css).not.toMatch(/\.dashboard-view-cards \.saved-credit-summary\s*\{[^}]*flex-wrap:\s*wrap;/);
    expect(css).toMatch(/\.saved-credit-summary \.saved-running-device\s*\{[^}]*flex:\s*1 1 auto;/);
    expect(css).toMatch(/\.saved-credit-summary \.saved-subscription-remaining,\s*\.saved-credit-summary \.saved-reset-badge\s*\{[^}]*flex:\s*none;/);
  });

  it("keeps one row and exposes secondary actions through overflow", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8").replace(/\r\n/g, "\n");
    expect(source).toContain("function DashboardMobileActions");
    expect(source).toContain('class="dashboard-mobile-actions"');
    expect(source).toContain('aria-label={menuLabel}');
    expect(source).toContain('closeMenu(event); props.onDonate()');
    expect(source).toContain('Donate');
    expect(css).toContain(".dashboard-density-compact .hero");
    expect(css).toContain("flex-direction: row;");
    expect(css).toContain(".dashboard-mobile-actions-menu");
    expect(css).toMatch(/@media \(min-width: 601px\)\s*\{\s*\.dashboard-mobile-actions\s*\{ display: none;/);
  });

  it("keeps session rows compact while transcript actions overlay on hover", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8").replace(/\r\n/g, "\n");
    expect(css).toContain(".cli-session-spinner { display: inline-block;");
    expect(css).toContain(".cli-workspace .cli-session-row-main { min-height: 27px;");
    expect(css).toContain(".cli-workspace .cli-session-row-actions { top: 50%;");
    expect(css).toContain("padding-right: 8px;");
    expect(css).toContain(".cli-session-message .cli-message-actions {\n  position: absolute;");
    expect(css).toContain(".cli-session-message:hover .cli-message-actions,");
    expect(css).toContain(".cli-session-message .cli-message-actions:focus-within { opacity: 1; pointer-events: auto; }");
  });

  it("keeps the rail navigation compact and makes the Codex mark a dashboard home", () => {
    const source = readFileSync("webview-src/dashboard/cliSessionsModal.tsx", "utf8");
    expect(source).toContain("cli-new-chat-icon");
    expect(source).toContain('aria-label="Open dashboard"');
    expect(source).not.toContain('<button type="button" onClick={() => startNewChat()}><PlusIcon /><span>New chat</span></button>');
  });
});
