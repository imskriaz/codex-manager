import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("dashboard accessibility and interaction flow", () => {
  it("keeps modal focus contained and supports Escape dismissal", () => {
    const primitives = readFileSync("webview-src/dashboard/primitives.tsx", "utf8");
    expect(primitives).toContain("useLayoutEffect(() => {");
    expect(primitives).not.toContain("const focusFrame");
    expect(primitives).toContain('event.key === "Escape"');
    expect(primitives).toContain('event.key !== "Tab"');
    expect(primitives).toContain('role="dialog"');
    expect(primitives).toContain('aria-modal="true"');
    expect(primitives).toContain("previouslyFocused.focus({ preventScroll: true })");
    expect(primitives).not.toContain("if (open && document.activeElement === document.body)");
  });

  it("does not poll or animate the settings surface while the composer is active", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(main).not.toContain("setInterval(refreshLogConsole");
    expect(main).toContain("Use Refresh to query again.");
    expect(css).not.toContain("animation: settings-panel-enter");
    const actions = readFileSync("webview-src/dashboard/actionHooks.ts", "utf8");
    const board = readFileSync("webview-src/dashboard/taskBoard.tsx", "utf8");
    expect(actions).not.toContain("setInterval");
    expect(board).not.toContain("timer = setTimeout(() => { void poll()");
    expect(main).not.toContain('window.setInterval(refresh, session.status');
  });

  it("gives custom settings dialogs names and keyboard handling", () => {
    const settings = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");
    for (const source of [settings]) {
      expect(source).toContain('role="dialog"');
      expect(source).toContain('aria-modal="true"');
      expect(source).toContain("onKeyDown={");
    }
    expect(settings).toContain("aria-label={props.copy.closeModal}");
  });

  it("organizes settings into labelled, keyboard-operable tab panels", () => {
    const settings = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");
    expect(settings).toContain('role="tablist"');
    expect(settings).toContain('role="tab"');
    expect(settings).toContain('role="tabpanel"');
    expect(settings).toContain('event.key === "ArrowRight"');
    expect(settings).toContain('event.key === "ArrowLeft"');
    expect(settings).toContain("aria-selected={activeTab === tab.id}");
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

  it("places the shared password in General instead of the data and sync panel", () => {
    const settings = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");
    const generalPanel = settings.indexOf('id="settings-panel-general"');
    const passwordSetting = settings.indexOf('data-setting="shared-password"');
    const dataPanel = settings.indexOf('id="settings-panel-data"');

    expect(generalPanel).toBeGreaterThanOrEqual(0);
    expect(passwordSetting).toBeGreaterThan(generalPanel);
    expect(passwordSetting).toBeLessThan(dataPanel);
    expect(settings.slice(dataPanel)).not.toContain("onClick={props.onConfigureSync}");
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
    expect(controls).toContain("aria-label={`${props.copy.colorThresholdYellowTitle} threshold`}");
    expect(controls).toContain("aria-label={`${props.copy.colorThresholdGreenTitle} threshold`}");
    expect(controls).toContain("aria-label={props.description(currentValue)}");
  });

  it("keeps the compact account surface within the viewport", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(css).toContain("/* Utility console polish:");
    expect(css).toContain(".account-count-badges { width: 100%; box-sizing: border-box; }");
    expect(css).toContain(".saved-card::before { display: none; }");
  });

  it("removes the redundant live badge and retains email sorting", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(source).not.toContain('class="dashboard-live-status"');
    expect(source).toContain('if (sort === "email")');
    expect(source).toContain('"Email Address"');
  });

  it("keeps the announcements bell out of the dashboard toolbar", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(source).not.toContain('id="announcementsButton"');
    expect(source).not.toContain("announcement-button-badge");
  });

  it("shows only the newest notification without allowing background result spam", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const feedback = readFileSync("webview-src/dashboard/actionFeedback.ts", "utf8");
    expect(source).toContain("dashboard-notice-stack");
    expect(source).toContain("createDashboardToastController(setNotice)");
    expect(source).not.toContain(".slice(-4)");
    expect(feedback).toContain('"listCodexCliSessions"');
    expect(feedback).toContain("done.`");
  });

  it("keeps maintenance actions grouped behind separate confirmation and result dialogs", () => {
    const tools = readFileSync("webview-src/dashboard/maintenanceTools.tsx", "utf8");
    const queue = readFileSync("webview-src/dashboard/sessionQueueControl.tsx", "utf8");
    expect(tools).toContain("Archive Management");
    expect(tools).toContain("Codex Manager");
    expect(tools).toContain("About Codex");
    expect(tools).toContain('className="maintenance-confirm-modal"');
    expect(tools).toContain('className="maintenance-result-modal"');
    expect(tools).not.toContain('"Goal manager"');
    expect(queue).toContain("Auto Resume");
    expect(queue).toContain("Queue and Auto Resume options");
    expect(queue).toContain("is-auto-resume-icon");
    expect(queue).toContain("is-queue-badge");
    expect(queue).toContain("cli-session-control-markers");
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(main).toContain('cli-sessions-running-row ${running ? "is-running" : "is-interrupted"}');
    expect(css).toContain(".cli-sessions-running-row.is-running .cli-sessions-running-title");
    expect(tools).toContain('class={`maintenance-report${storage ? " has-storage" : ""}`}');
    const settings = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");
    const webDashboard = settings.indexOf('props.lang === "zh" ? "浏览器面板"');
    const taskBoard = settings.indexOf('title="Project task board"');
    const dashboardApi = settings.indexOf('title="Dashboard API"');
    expect(webDashboard).toBeGreaterThanOrEqual(0);
    expect(taskBoard).toBeGreaterThan(webDashboard);
    expect(dashboardApi).toBeGreaterThan(taskBoard);
    expect(tools.indexOf('class="maintenance-sort"')).toBeLessThan(tools.indexOf('class="maintenance-selected-count"'));
    expect(tools).not.toContain('aria-label="Sessions Management"');
  });
});
