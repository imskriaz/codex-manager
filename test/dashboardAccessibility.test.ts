import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("dashboard accessibility and interaction flow", () => {
  it("keeps modal focus contained and supports Escape dismissal", () => {
    const primitives = readFileSync("webview-src/dashboard/primitives.tsx", "utf8");
    expect(primitives).toContain('event.key === "Escape"');
    expect(primitives).toContain('event.key !== "Tab"');
    expect(primitives).toContain('role="dialog"');
    expect(primitives).toContain('aria-modal="true"');
    expect(primitives).toContain("previouslyFocused.focus()");
  });

  it("gives custom settings and announcement dialogs names and keyboard handling", () => {
    const settings = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");
    const announcements = readFileSync("webview-src/dashboard/announcementCenter.tsx", "utf8");
    for (const source of [settings, announcements]) {
      expect(source).toContain('role="dialog"');
      expect(source).toContain('aria-modal="true"');
      expect(source).toContain("onKeyDown={");
    }
    expect(settings).toContain('aria-label={props.copy.closeModal}');
  });

  it("organizes settings into labelled, keyboard-operable tab panels", () => {
    const settings = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");
    expect(settings).toContain('role="tablist"');
    expect(settings).toContain('role="tab"');
    expect(settings).toContain('role="tabpanel"');
    expect(settings).toContain('event.key === "ArrowRight"');
    expect(settings).toContain('event.key === "ArrowLeft"');
    expect(settings).toContain('aria-selected={activeTab === tab.id}');
  });

  it("announces initial loading and exposes a main landmark and skip link", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("Loading…");
    expect(source).toContain('class="loading-screen"');
    expect(source).toContain('class="loading-shine"');
    expect(source).toContain('class="skip-link"');
    expect(source).toMatch(/<main\r?\n\s+id="dashboard-main"/);
  });

  it("uses a labelled login form with password-manager and error semantics", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain('<label for="dashboard-password">Password</label>');
    expect(source).toContain('autocomplete="current-password"');
    expect(source).toContain('role="alert"');
    expect(source).toContain('<button type="submit">Unlock dashboard</button>');
  });

  it("preserves visible keyboard focus even where component styles remove outlines", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(css).toContain("button:focus-visible");
    expect(css).toContain("outline: 2px solid var(--accent-blue) !important");
    expect(css).toContain("overscroll-behavior: contain");
  });

  it("keeps the composer focus ring on its surface instead of the textarea", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(css).toContain(".cli-workspace .cli-composer:focus-within");
    expect(css).toContain(".cli-workspace .cli-composer textarea:focus-visible");
    expect(css).toContain("outline: none !important;");
  });

  it("labels settings toggles and range controls for assistive technology", () => {
    const controls = readFileSync("webview-src/dashboard/settingsControls.tsx", "utf8");
    expect(controls).toContain("aria-label={props.title}");
    expect(controls).toContain('aria-label={`${props.copy.colorThresholdYellowTitle} threshold`}');
    expect(controls).toContain('aria-label={`${props.copy.colorThresholdGreenTitle} threshold`}');
    expect(controls).toContain("aria-label={props.description(currentValue)}");
  });

  it("keeps the compact account surface within the viewport", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(css).toContain("/* Utility console polish:");
    expect(css).toContain(".account-count-badges { width: 100%; box-sizing: border-box; }");
    expect(css).toContain(".saved-card::before { display: none; }");
  });

  it("shows a live indicator only for an active WebSocket and sorts by email address", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(source).toContain("isBrowserDashboard && realtimeConnected");
    expect(source).toContain("WebSocket real-time updates are active");
    expect(source).toContain('if (sort === "email")');
    expect(source).toContain('"Email Address"');
  });

  it("keeps the announcements bell out of the dashboard toolbar", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(source).not.toContain('id="announcementsButton"');
    expect(source).not.toContain("announcement-button-badge");
  });

  it("queues concurrent notifications without allowing background result spam", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const feedback = readFileSync("webview-src/dashboard/actionFeedback.ts", "utf8");
    expect(source).toContain("dashboard-notice-stack");
    expect(source).toContain(".slice(-4)");
    expect(feedback).toContain('"listCodexCliSessions"');
    expect(feedback).toContain("completed.`");
  });
});
