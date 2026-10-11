import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("mobile dashboard header", () => {
  it("keeps one row and exposes secondary actions through overflow", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(source).toContain("function DashboardMobileActions");
    expect(source).toContain('class="dashboard-mobile-actions"');
    expect(source).toContain('aria-label={menuLabel}');
    expect(css).toContain(".dashboard-density-compact .hero");
    expect(css).toContain("flex-direction: row;");
    expect(css).toContain(".dashboard-mobile-actions-menu");
  });

  it("keeps session rows two lines while actions overlay on hover", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(css).toContain(".cli-session-spinner { display: inline-block;");
    expect(css).toContain(".cli-workspace .cli-session-row-main { min-height: 27px;");
    expect(css).toContain(".cli-workspace .cli-session-row-actions { top: 50%;");
    expect(css).toContain("padding-right: 8px;");
    expect(css).toContain(".cli-workspace .cli-message-actions {\n  position: absolute;");
    expect(css).toContain(".cli-workspace .cli-message-action-menu {\n  position: absolute;");
  });

  it("keeps the rail navigation compact and makes the Codex mark a dashboard home", () => {
    const source = readFileSync("webview-src/dashboard/cliSessionsModal.tsx", "utf8");
    expect(source).toContain("cli-new-chat-icon");
    expect(source).toContain('aria-label="Open dashboard"');
    expect(source).not.toContain('<button type="button" onClick={() => startNewChat()}><PlusIcon /><span>New chat</span></button>');
  });
});
