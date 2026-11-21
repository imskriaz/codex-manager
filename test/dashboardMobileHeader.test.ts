import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("mobile dashboard header", () => {
  it("scales browser typography independently of geometry and applies mobile rules after legacy skins", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    const finalRules = css.lastIndexOf("/* Final compact layout rules");
    expect(finalRules).toBeGreaterThan(css.lastIndexOf("/* Requests stay with their session"));
    expect(css.slice(finalRules)).toContain('html[data-dashboard-host="browser"] { --dashboard-text-scale: 1.155; }');
    // Fixed Browser/DevTools chrome is independent of dashboard text scaling.
    const dashboardRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) => !selector.includes('.workspace-browser'));
    for (const [, , declarations] of dashboardRules) expect(declarations).not.toMatch(/\bfont-size\s*:\s*[\d.]+px\b/);
    expect(css).toContain("font-size: calc(16px * var(--dashboard-text-scale, 1))");
    expect(css.slice(finalRules)).toContain(".cli-workspace .cli-composer.is-empty { display: grid;");
    expect(css.slice(finalRules)).toContain(".cli-workspace .cli-account-footer .cli-account-footer-account { display: flex;");
  });

  it("keeps card plan, reset credit, device and expiry on one line at every width", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(css).toMatch(/\.dashboard-view-cards \.saved-credit-summary\s*\{[^}]*flex-wrap:\s*nowrap;/);
    expect(css).not.toMatch(/\.dashboard-view-cards \.saved-credit-summary\s*\{[^}]*flex-wrap:\s*wrap;/);
    expect(css).toMatch(/\.saved-credit-summary \.saved-running-device\s*\{[^}]*flex:\s*1 1 auto;/);
    expect(css).toMatch(/\.saved-credit-summary \.saved-subscription-remaining,\s*\.saved-credit-summary \.saved-reset-badge\s*\{[^}]*flex:\s*none;/);
  });

  it("keeps one row and exposes header actions directly", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8").replace(/\r\n/g, "\n");
    expect(source).not.toContain("DashboardMobileActions");
    expect(source).toContain('id="privacyToggleButton"');
    expect(source).toContain('id="settingsOpenButton"');
    expect(source).toContain('id="aboutOpenButton"');
    expect(source).toContain('id="donateButton"');
    expect(css).toContain(".dashboard-density-compact .hero");
    expect(css).toContain("flex-direction: row;");
    expect(css).not.toContain("dashboard-mobile-actions");
    expect(css).toContain(".dashboard-density-compact .hero-settings .settings-btn");
    expect(css).toContain(".dashboard-content .hero { flex-wrap: nowrap;");
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
    expect(source).toContain('class="cli-dashboard-nav"');
    expect(source).toContain('aria-label="Dashboard"');
    expect(source).not.toContain('<button type="button" onClick={() => startNewChat()}><PlusIcon /><span>New chat</span></button>');
  });
});

it('keeps Account Center selectors beside search and More beside the account counts', () => {
  const source = readFileSync('webview-src/dashboard/main.tsx', 'utf8');
  expect(source).not.toContain('class="account-center-add"');
  const header = source.slice(source.indexOf('<div class="header accounts-section-header">'), source.indexOf('<div class="dashboard-account-toolbar">'));
  expect(header.includes('<WorkspaceMenu label="More account actions"')).toBe(true);
  const toolbar = source.slice(source.indexOf('<div class="dashboard-account-toolbar">'), source.indexOf('<div class="accounts-grid">', source.indexOf('<div class="dashboard-account-toolbar">')));
  expect(toolbar.includes('{displayFilters}')).toBe(true);
  expect(toolbar.includes('{viewToggle}')).toBe(true);
});


it("keeps Settings directly accessible at the top of every workspace sidebar", () => {
  const source = readFileSync("webview-src/dashboard/cliSessionsModal.tsx", "utf8");
  const header = source.slice(source.indexOf('class="cli-rail-header"'), source.indexOf('class="cli-primary-nav"'));
  expect(header).toContain('<IconButton label="Settings" className="cli-settings-shortcut"');
  expect(header).not.toContain('{props.officeFeatures ? <IconButton');
  expect(header).toContain('props.onSettings();');
});
