import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
  resolveOverviewContextAction,
  resolveOverviewRefreshMode,
  resolveOverviewPopoverPosition,
  resolveOverviewToolbarActionCount,
  resolveOverviewToolbarLabel,
  resolveResetCreditBadgeLabel
} from "../webview-src/dashboard/overviewSection";

describe("overview actions", () => {
  it("uses the current account action slot to unload with a reload icon", () => {
    const card = readFileSync("webview-src/dashboard/savedAccountCard.tsx", "utf8");

    expect(card).toContain("icon={account.isActive ? renderReloadIcon() : renderSwitchIcon()}");
    expect(card).toContain(
      'onAction(account.isActive ? "unloadAuth" : "switch", account.isActive ? undefined : account.id)'
    );
  });

  it("keeps onboarding available without exposing it in the More menu", () => {
    const overview = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");

    expect(overview).toContain("overview-more-menu");
    expect(overview).not.toContain('resolveOverviewMenuLabel("onboard", props.lang)');
  });

  it("places the connected-PC picker beside Codex Manager and removes duplicate selectors", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const overview = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(main).toContain("PcPickerControl");
    expect(main).toContain("accountsByPeerId={Object.fromEntries(");
    expect(main).toContain("${syncLabel} · ${enabledCount} ${enabledLabel}");
    expect(main).toContain("${accounts.length - enabledCount} ${disabledLabel}");
    expect(main).toContain("Number.isFinite(peer.sessionCount)");
    expect(main).toContain("${disabledLabel}${sessionSummary}");
    expect(main).toContain('class={`brand ${isBrowserDashboard ? "has-pc-picker" : ""}`}');
    expect(main).not.toContain('class="dashboard-select-control dashboard-pc-control"');
    expect(overview).not.toContain(
      'class="overview-session-meta overview-meta-item overview-meta-item-wide" role="status"'
    );
    expect(css).toContain(".dashboard-pc-picker-trigger");
    expect(css).toContain(".dashboard-pc-picker-popover");
  });

  it("shows PC status before opening session management", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(main).toContain("<CliSessionsMenu");
    expect(main).toContain('aria-haspopup="dialog"');
    expect(main).toContain('const heading = isZh ? "电脑状态"');
    expect(main).toContain(': "Manage sessions"');
    expect(main).toMatch(/setCliSessionsMenuOpen\(false\);\r?\n\s+openCliSessions\(\);/);
    expect(main).not.toContain("onClick={openCliSessions}");
    expect(css).toContain(".cli-sessions-popover");
    expect(css).toContain(".cli-sessions-pc-state.is-online");
    expect(css).toContain(".cli-sessions-manage");
  });

  it("opens a picker from Switch and exposes Reload for a queued target", () => {
    const overview = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");

    expect(overview).toContain("props.onSwitchAccount();");
    expect(overview).not.toContain("props.onSwitchAccount(switchTarget.id)");
    expect(main).toContain("openBrowserSwitchPicker()");
    expect(main).toContain('setBrowserActionRequest({ kind: "switch"');
    expect(
      resolveOverviewContextAction(
        {
          isActive: false,
          isCurrentWindowAccount: false,
          switchQueued: true,
          runningDeviceName: undefined,
          runningOnThisDevice: undefined
        },
        false
      )
    ).toBe("reload");
  });

  it("uses quota refresh before encrypted sync is enabled", () => {
    expect(resolveOverviewRefreshMode(false)).toBe("quota");
  });

  it("uses sync after passphrase setup enables encrypted sync", () => {
    expect(resolveOverviewRefreshMode(true)).toBe("sync");
  });

  it("keeps toolbar labels compact", () => {
    expect(
      ["add", "import", "sync", "setup", "refresh", "lock", "disableRescue"].map((action) =>
        resolveOverviewToolbarLabel(
          action as "add" | "import" | "sync" | "setup" | "refresh" | "lock" | "disableRescue",
          "en"
        )
      )
    ).toEqual(["Add", "Import", "Sync", "Set Up", "Refresh", "Lock", "Rescue"]);
  });

  it("distributes the full toolbar across every visible action", () => {
    expect(resolveOverviewToolbarActionCount(true, true, false)).toBe(4);
    expect(resolveOverviewToolbarActionCount(true, true, true)).toBe(4);
    expect(resolveOverviewToolbarActionCount(true, false, true)).toBe(4);
    expect(resolveOverviewToolbarActionCount(false, false, true)).toBe(4);
  });

  it("keeps the overview layout mounted with inline account controls when no account is loaded", () => {
    const overview = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(overview).toContain("createBlankOverviewAccount(copy)");
    expect(overview).toContain("placeholder={!providedAccount}");
    expect(overview).toContain("!providedAccount ||");
    expect(overview).toContain("overview-inline-add-panel");
    expect(main).toContain("emptyAccountContent={!overviewAccount ? renderAddAccount(true, true) : undefined}");
    expect(overview).toContain('resolveOverviewToolbarLabel("sync", props.lang)');
  });

  it("positions the More menu in the viewport-level layer below its trigger", () => {
    expect(resolveOverviewPopoverPosition({ bottom: 80, right: 334 }, 357)).toEqual({ top: 85, right: 23 });
    expect(resolveOverviewPopoverPosition({ bottom: 80, right: 355 }, 357)).toEqual({ top: 85, right: 8 });

    const source = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");
    expect(source).toContain('class="claim-popover claim-popover-portal overview-more-menu"');
    expect(source).toContain("morePopoverContentRef.current?.contains(target)");
    expect(source).toMatch(/overview-more-menu[\s\S]*document\.body/);
  });

  it("keeps Lock and Unlock available in the More menu alongside Sessions", () => {
    const source = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");

    expect(source).toContain('account.autoSwitchLockedUntil ? "unlock" : "lock"');
    expect(source).toContain("openLockDialog(event.currentTarget)");
    expect(source).toContain("props.onSetAutoSwitchLock(0)");
    expect(source).toContain("props.onOpenCliSessions!");
  });

  it("refreshes all account quotas from the More menu", () => {
    const source = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");

    expect(source).toContain("props.onRefreshAll();");
    expect(source).toContain("props.copy.refreshAll");
    expect(source).toContain("disabled={props.refreshAllPending}");
  });

  it("offers Disable All in More and routes it as a global dashboard action", () => {
    const overview = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");

    expect(overview).toContain('resolveOverviewMenuLabel("disableAll", props.lang)');
    expect(overview).toContain("props.onDisableAll();");
    expect(main).toContain('onDisableAll={() => sendAction("disableAll")}');
  });

  it("offers Enable All in More and routes only valid accounts through the bulk action", () => {
    const overview = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");

    expect(overview).toContain('resolveOverviewMenuLabel("enableAll", props.lang)');
    expect(overview).toContain("props.onEnableAllValid();");
    expect(overview).toContain("Enable accounts with valid credentials that do not require reauthorization.");
    expect(main).toContain('onEnableAllValid={() => sendAction("enableAllValid")}');
  });

  it("completes switch or unload feedback before scheduling the reload", () => {
    const overview = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const panel = readFileSync("src/presentation/dashboard/panel.ts", "utf8");
    const browserServer = readFileSync("src/services/webDashboardServer.ts", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(overview).toContain('resolveOverviewMenuLabel("unload", props.lang)');
    expect(overview).toContain("props.onUnloadAuth()");
    expect(main).toContain('onUnloadAuth={() => sendAction("unloadAuth")}');
    expect(main).toContain('handleAccountAction("reloadPrompt", overviewAccount.id, { forceReload: true })');
    expect(panel.indexOf("await this.postActionResult(")).toBeLessThan(panel.indexOf("scheduleExtensionHostReload("));
    expect(browserServer.indexOf("this.sendJson(response, { messages });")).toBeLessThan(
      browserServer.indexOf("if (reloadAfterResponse)")
    );
    expect(panel).toContain("result.payload?.reloadScheduled === true");
    expect(browserServer).toContain("result.payload?.reloadScheduled === true");
    expect(browserServer).toContain('message.action === "switch" ? "The account switched"');
    expect(css).toMatch(/\.overview-more-menu\s*\{[\s\S]*?display:\s*grid;/);
    expect(css).toMatch(/\.overview-more-menu\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2/);
    expect(css).toContain(".overview-more-menu .claim-popover-title");
  });

  it("keeps all four account actions in one icon-only row on mobile", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(css).toMatch(
      /\.overview-bottom-row \.overview-actions:not\(\.overview-empty-actions\) \.toolbar \{\r?\n\s+grid-template-columns: repeat\(4, minmax\(0, 1fr\)\) !important;/
    );
    expect(css).toMatch(
      /\.overview-bottom-row \.overview-actions:not\(\.overview-empty-actions\) \.toolbar-btn \.button-label \{\r?\n\s+display: none;/
    );
  });

  it("keeps account badges on one horizontal row and lets search fill the toolbar", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(css).toMatch(/\.account-count-badges \{[\s\S]*?flex-wrap: nowrap;/);
    expect(css).toMatch(/\.dashboard-account-toolbar \.account-search-control \{[\s\S]*?flex: 1 1 140px;/);
    expect(css).toMatch(/\.dashboard-account-toolbar \.dashboard-view-controls \{[\s\S]*?margin-left: 0;/);
  });

  it("keeps reset availability in the compact badge instead of a second quota block", () => {
    const source = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(source).toContain('class="overview-reset-credit"');
    expect(resolveResetCreditBadgeLabel("en")).toBe("Reset");
    expect(source).toContain("resolveResetCreditBadgeLabel(props.lang)");
    expect(source).not.toContain("overview-quota-notice");
    expect(source).not.toContain("Weekly quota remaining");
    expect(source).not.toContain("Auto-switch is enabled");
    expect(css).not.toContain(".overview-quota-notice");
  });

  it("renders every visible metric and uses an in-app graph tooltip", () => {
    const overview = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");
    const state = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(overview).toContain('typeof metric.percentage === "number"');
    expect(overview).toContain("usage-graph-tooltip");
    expect(overview).toContain("onMouseEnter");
    expect(overview).toContain("usage-graph-settings-popover");
    expect(overview).toContain("onLoadDailyUsage");
    expect(overview).toContain('graphMode === "tokens"');
    expect(state).toContain("availableMetrics");
    expect(state).toContain('"login-date"');
    expect(state).toContain('"account-type"');
  });
});
