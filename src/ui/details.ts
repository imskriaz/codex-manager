import { onDidChangeConfiguration } from "../storage/configurationEvents";
import * as vscode from "vscode";
import { CodexManagerAccountRecord, CodexDailyUsageBreakdown } from "../core/types";
import { resolveAccountHealth, isHealthDismissed } from "../application/accounts/health";
import { resolveSubscriptionDisplay } from "../application/dashboard/buildDashboardState";
import { formatAccountStructure } from "../application/dashboard/copy";
import { getDashboardCopy } from "../application/dashboard/copy";
import type { DashboardThemeOption } from "../domain/dashboard/types";
import { getCodexManagerConfiguration, normalizeDashboardTheme } from "../infrastructure/config/extensionSettings";
import type { DashboardLanguage } from "../localization/languages";
import { getIntlLocale } from "../localization/languages";
import { detailCopyResources } from "../localization/resources/details";
import { getAutoSwitchRuntimeSnapshot } from "../presentation/workbench/autoSwitchState";
import { getTokenAutomationSnapshot } from "../presentation/workbench/tokenAutomationState";
import { fetchAccountDailyUsage, toVSCodeDailyUsage } from "../services/usage";
import { loadDailyTokenUsage } from "../services/dailyTokenUsage";
import { readDashboardDailyUsage } from "../services/dashboardUsageHistory";
import { AccountsRepository } from "../storage";
import {
  colorForPercentage,
  escapeHtml,
  escapeHtmlAttr,
  getLanguage,
  prettyAuthProvider,
  isUserFacingAdditionalQuotaLimit,
  resolveLongQuotaLabel
} from "../utils";
import { formatRelativeReset, formatTimestamp } from "../utils/time";

let detailsPanel: vscode.WebviewPanel | undefined;
let detailsPanelRequestId = 0;
let detailsPanelConfigWatcher: vscode.Disposable | undefined;

type DetailsUsageState = "loading" | "ready" | "empty" | "error";

type DetailsPanelState = {
  repo?: AccountsRepository;
  account?: CodexManagerAccountRecord;
  accountId?: string;
  styles?: WebviewStyles;
  scripts?: WebviewScripts;
  usageState: DetailsUsageState;
  usage?: CodexDailyUsageBreakdown;
  usageError?: string;
  usageFetchedAt?: number;
  privacyMode: boolean;
};

const detailsPanelState: DetailsPanelState = {
  usageState: "loading",
  privacyMode: false
};

export function openDetailsPanel(
  context: vscode.ExtensionContext,
  repo: AccountsRepository,
  account: CodexManagerAccountRecord
): void {
  const copy = getCopy();
  if (!detailsPanel) {
    detailsPanel = vscode.window.createWebviewPanel(
      "codexManagerDetails",
      `${copy.titlePrefix}: ${account.email}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        enableFindWidget: true
      }
    );

    detailsPanel.onDidDispose(() => {
      detailsPanelConfigWatcher?.dispose();
      detailsPanelConfigWatcher = undefined;
      detailsPanelState.repo = undefined;
      detailsPanelState.account = undefined;
      detailsPanelState.accountId = undefined;
      detailsPanelState.styles = undefined;
      detailsPanelState.scripts = undefined;
      detailsPanelState.usage = undefined;
      detailsPanelState.usageError = undefined;
      detailsPanelState.usageFetchedAt = undefined;
      detailsPanelState.usageState = "loading";
      detailsPanelState.privacyMode = false;
      detailsPanel = undefined;
    });

    detailsPanel.webview.onDidReceiveMessage(async (message: { type?: string; privacyMode?: boolean; accountId?: string }) => {
      if (!detailsPanelState.repo || !detailsPanelState.accountId) {
        return;
      }

      if (message.type === "details:set-privacy-mode") {
        if (typeof message.privacyMode !== "boolean") {
          void vscode.window.showErrorMessage("Privacy mode could not be updated because the request was invalid.");
          return;
        }
        try {
          await getCodexManagerConfiguration().update(
            "privacyMode",
            message.privacyMode,
            vscode.ConfigurationTarget.Global
          );
          detailsPanelState.privacyMode = message.privacyMode;
          await refreshDetailsPanel();
          void vscode.window.showInformationMessage(
            message.privacyMode
              ? "Privacy mode enabled across Codex Manager."
              : "Privacy mode disabled across Codex Manager."
          );
        } catch (error) {
          detailsPanelState.privacyMode = getPrivacyModePreference();
          await refreshDetailsPanel();
          void vscode.window.showErrorMessage(
            `Privacy mode could not be updated: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        return;
      }

      const current = await detailsPanelState.repo.getAccount(detailsPanelState.accountId);
      if (!current) {
        void vscode.window.showErrorMessage("This account no longer exists. Close its details and choose another account.");
        return;
      }
      if (message.type === "details:retry-usage" && message.accountId === current.id && detailsPanelState.usageState !== "loading") {
        await hydrateUsage(context, detailsPanelState.repo, current.id, ++detailsPanelRequestId);
      }
    });

    detailsPanelConfigWatcher = onDidChangeConfiguration((event) => {
      if (
        !detailsPanel ||
        (!event.affectsConfiguration("codexManager.displayLanguage") &&
          !event.affectsConfiguration("codexManager.dashboardTheme") &&
          !event.affectsConfiguration("codexManager.privacyMode") &&
          !event.affectsConfiguration("codexManager.quotaGreenThreshold") &&
          !event.affectsConfiguration("codexManager.quotaYellowThreshold"))
      ) {
        return;
      }

      detailsPanelState.privacyMode = getPrivacyModePreference();
      void refreshDetailsPanel();
    });
  } else {
    detailsPanel.title = `${copy.titlePrefix}: ${account.email}`;
    detailsPanel.reveal(vscode.ViewColumn.Beside, false);
  }

  const styles = getWebviewStyles(detailsPanel.webview, context.extensionUri, "details.css");
  const scripts = getWebviewScripts(detailsPanel.webview, context.extensionUri, "details.js");
  detailsPanelState.repo = repo;
  detailsPanelState.account = account;
  detailsPanelState.accountId = account.id;
  detailsPanelState.styles = styles;
  detailsPanelState.scripts = scripts;
  detailsPanelState.usage = undefined;
  detailsPanelState.usageError = undefined;
  detailsPanelState.usageFetchedAt = undefined;
  detailsPanelState.usageState = "loading";
  detailsPanelState.privacyMode = getPrivacyModePreference();
  const requestId = ++detailsPanelRequestId;
  void refreshDetailsPanel();

  void hydrateUsage(context, repo, account.id, requestId);
}

async function hydrateUsage(context: vscode.ExtensionContext, repo: AccountsRepository, accountId: string, requestId: number): Promise<void> {
  try {
    const saved = readDashboardDailyUsage(context, accountId);
    detailsPanelState.usage = saved ? toVSCodeDailyUsage(saved.usage) : undefined;
    detailsPanelState.usageFetchedAt = saved?.fetchedAt;
    detailsPanelState.usageError = undefined;
    detailsPanelState.usageState = "loading";
    await refreshDetailsPanel();
    const account = await repo.getAccount(accountId);
    if (!account) throw new Error("The account was removed while loading usage.");
    if (!detailsPanel || requestId !== detailsPanelRequestId || detailsPanelState.accountId !== accountId) {
      return;
    }

    const entry = await loadDailyTokenUsage(context, accountId, signal => fetchAccountDailyUsage(repo, account, 30, signal), { manual: true, accountLabel: account.email });
    if (!detailsPanel || requestId !== detailsPanelRequestId || detailsPanelState.accountId !== accountId) {
      return;
    }

    detailsPanelState.usageState = entry.usage.points.length ? "ready" : "empty";
    detailsPanelState.usage = toVSCodeDailyUsage(entry.usage);
    detailsPanelState.usageFetchedAt = entry.fetchedAt;
    await refreshDetailsPanel();
  } catch (error) {
    if (!detailsPanel || requestId !== detailsPanelRequestId || detailsPanelState.accountId !== accountId) {
      return;
    }

    detailsPanelState.usageState = "error";
    detailsPanelState.usageError = error instanceof Error ? error.message : String(error);
    await refreshDetailsPanel();
  }
}

export async function refreshDetailsPanel(): Promise<void> {
  if (
    !detailsPanel ||
    !detailsPanelState.repo ||
    !detailsPanelState.accountId ||
    !detailsPanelState.styles ||
    !detailsPanelState.scripts
  ) {
    return;
  }

  const panel = detailsPanel;
  const accountId = detailsPanelState.accountId;
  const requestId = detailsPanelRequestId;
  const repo = detailsPanelState.repo;
  let account;
  try { account = await repo.getAccount(accountId); }
  catch (error) {
    if (detailsPanel !== panel || requestId !== detailsPanelRequestId || detailsPanelState.accountId !== accountId) return;
    detailsPanelState.usageState = 'error';
    detailsPanelState.usageError = `Account details could not refresh: ${error instanceof Error ? error.message : String(error)}. Saved history was kept.`;
    if (detailsPanelState.account) renderDetails(detailsPanelState.account);
    return;
  }
  if (detailsPanel !== panel || requestId !== detailsPanelRequestId || detailsPanelState.accountId !== accountId) return;
  if (!account) {
    detailsPanel.dispose();
    return;
  }
  detailsPanelState.account = account;

  // Credentials can be missing or unreadable; hydration reports that failure in Usage details.
  const tokens = await repo.getTokens(account.id).catch(() => undefined);
  if (detailsPanel !== panel || requestId !== detailsPanelRequestId || detailsPanelState.accountId !== accountId) return;
  renderDetails(account, tokens);
}

function renderDetails(
  account: CodexManagerAccountRecord,
  tokens?: Awaited<ReturnType<AccountsRepository["getTokens"]>>
): void {
  if (!detailsPanel || !detailsPanelState.styles || !detailsPanelState.scripts) {
    return;
  }

  const copy = getCopy();
  const theme = getDetailsThemePreference();
  detailsPanel.title = `${copy.titlePrefix}: ${account.email}`;
  detailsPanel.webview.html = renderHtml(account, tokens, copy, detailsPanelState.styles, detailsPanelState.scripts, {
    theme,
    privacyMode: detailsPanelState.privacyMode,
    usageState: detailsPanelState.usageState,
    usage: detailsPanelState.usage,
    usageError: detailsPanelState.usageError,
    usageFetchedAt: detailsPanelState.usageFetchedAt
  });
}

type WebviewStyles = {
  shared: string;
  page: string;
};

type WebviewScripts = {
  page: string;
};

type SensitiveKind = "email" | "id" | "name";

function renderHtml(
  account: CodexManagerAccountRecord,
  tokens: Awaited<ReturnType<AccountsRepository["getTokens"]>> | undefined,
  copy: DetailCopy,
  styles: WebviewStyles,
  scripts: WebviewScripts,
  options: {
    theme: DashboardThemeOption;
    privacyMode: boolean;
    usageState: "loading" | "ready" | "empty" | "error";
    usage?: CodexDailyUsageBreakdown;
    usageError?: string;
    usageFetchedAt?: number;
  }
): string {
  const quota = account.quotaSummary;
  const accountStatus = account.isActive ? copy.currentlyActive : copy.savedAccount;
  const provider = prettyAuthProvider(account.authProvider);
  const identityName = account.accountName?.trim() ?? account.email;
  const workspaceLabel = formatAccountStructure(account.accountStructure, copy.lang);
  const workspaceValue = getDetailsWorkspaceValue(account, workspaceLabel);
  const dashboardCopy = getDashboardCopy(copy.lang);
  const subscription = resolveSubscriptionDisplay(account, tokens, dashboardCopy, copy.lang);
  const subscriptionStyle = subscription.color ? ` style="color:${escapeHtmlAttr(subscription.color)};"` : "";
  const longQuotaLabel = resolveLongQuotaLabel(
    account.planType,
    quota?.weeklyWindowMinutes,
    copy.lang,
    copy.weeklyQuota,
    "quota"
  );
  const health = resolveAccountHealth(account, tokens, getTokenAutomationSnapshot());
  const dismissedHealth = isHealthDismissed(account, health);
  const autoSwitchRuntime = getAutoSwitchRuntimeSnapshot();
  const autoSwitchLockedUntil =
    autoSwitchRuntime.lockedAccountId === account.id && typeof autoSwitchRuntime.lockedUntil === "number"
      ? autoSwitchRuntime.lockedUntil
      : undefined;
  const quotaCards = [
    ...(quota?.hourlyWindowPresent
      ? [
          `<div class="quota-card">
        <h2>${escapeHtml(copy.hourlyQuota)}</h2>
        <div class="quota-value" style="--metric-color:${colorForPercentage(quota?.hourlyPercentage)};">${renderQuotaValue(quota?.hourlyPercentage)}</div>
        <div class="meta">${escapeHtml(copy.reset)} ${renderLiveReset(quota?.hourlyResetTime, copy)}</div>
      </div>`
        ]
      : []),
    ...(quota?.weeklyWindowPresent
      ? [
          `<div class="quota-card">
        <h2>${escapeHtml(longQuotaLabel)}</h2>
        <div class="quota-value" style="--metric-color:${colorForPercentage(quota?.weeklyPercentage)};">${renderQuotaValue(quota?.weeklyPercentage)}</div>
        <div class="meta">${escapeHtml(copy.reset)} ${renderLiveReset(quota?.weeklyResetTime, copy)}</div>
      </div>`
        ]
      : []),
    ...(quota?.codeReviewWindowPresent
      ? [
          `<div class="quota-card">
        <h2>${escapeHtml(copy.reviewQuota)}</h2>
        <div class="quota-value" style="--metric-color:${colorForPercentage(quota?.codeReviewPercentage)};">${renderQuotaValue(quota?.codeReviewPercentage)}</div>
        <div class="meta">${escapeHtml(copy.reset)} ${renderLiveReset(quota?.codeReviewResetTime, copy)}</div>
      </div>`
        ]
      : []),
    ...(quota?.additionalRateLimits ?? []).filter(isUserFacingAdditionalQuotaLimit).flatMap((limit) => {
      const cards: string[] = [];
      if (limit.hourlyWindowPresent) {
        cards.push(`<div class="quota-card">
        <h2>${escapeHtml(`${limit.limitName} ${copy.hourlyQuota}`)}</h2>
        <div class="quota-value" style="--metric-color:${colorForPercentage(limit.hourlyPercentage)};">${renderQuotaValue(limit.hourlyPercentage)}</div>
        <div class="meta">${escapeHtml(copy.reset)} ${renderLiveReset(limit.hourlyResetTime, copy)}</div>
      </div>`);
      }
      if (limit.weeklyWindowPresent) {
        cards.push(`<div class="quota-card">
        <h2>${escapeHtml(`${limit.limitName} ${resolveLongQuotaLabel(undefined, limit.weeklyWindowMinutes, copy.lang, copy.weeklyQuota, "quota")}`)}</h2>
        <div class="quota-value" style="--metric-color:${colorForPercentage(limit.weeklyPercentage)};">${renderQuotaValue(limit.weeklyPercentage)}</div>
        <div class="meta">${escapeHtml(copy.reset)} ${renderLiveReset(limit.weeklyResetTime, copy)}</div>
      </div>`);
      }
      return cards;
    })
  ].join("");

  return `<!DOCTYPE html>
<html lang="${copy.lang}" ${renderDetailsThemeAttributes(options.theme)}>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styles.shared}" />
  <link rel="stylesheet" href="${styles.page}" />
</head>
<body ${renderDetailsBodyAttributes(options.privacyMode)}>
  <div class="shell">
    <section class="panel">
      <div class="panel-inner hero">
        <div class="hero-top">
          <div class="hero-title">
            <div class="hero-title-row">
              <h1>${renderSensitiveHtml(identityName, "name")}</h1>
              <button
                class="privacy-toggle"
                type="button"
                aria-pressed="false"
                aria-label="${escapeHtmlAttr(copy.hideSensitive)}"
                title="${escapeHtmlAttr(copy.hideSensitive)}"
                data-role="privacy-toggle"
                data-show-label="${escapeHtmlAttr(copy.showSensitive)}"
                data-hide-label="${escapeHtmlAttr(copy.hideSensitive)}"
              >
                <span class="privacy-icon privacy-icon-show">${renderEyeSvg()}</span>
                <span class="privacy-icon privacy-icon-hide">${renderEyeOffSvg()}</span>
              </button>
            </div>
            <div class="meta">${renderSensitiveHtml(account.email, "email")}</div>
            <div class="meta">${escapeHtml(copy.detailsSubtitle)}</div>
          </div>
          <div class="badges">
            ${account.isActive ? `<span class="pill active">${escapeHtml(copy.current)}</span>` : `<span class="pill">${escapeHtml(copy.saved)}</span>`}
            <span class="pill plan">${escapeHtml((account.planType ?? "unknown").toUpperCase())}</span>
            ${renderHealthBadge(health.kind, dismissedHealth, dashboardCopy)}
          </div>
        </div>
        <div class="summary">
          <div class="meta"><strong>${escapeHtml(workspaceLabel)}:</strong> ${renderSensitiveHtml(workspaceValue, "name", "-")}</div>
          <div class="meta"><strong>${escapeHtml(copy.login)}:</strong> ${escapeHtml(provider)}</div>
          <div class="meta"><strong>${escapeHtml(copy.loginTime)}:</strong> ${renderLiveTimestamp(account.loginAt, copy)}</div>
          <div class="meta"><strong>${escapeHtml(copy.subscription)}:</strong> <span${subscriptionStyle} title="${escapeHtmlAttr(subscription.title)}">${escapeHtml(subscription.text)}</span></div>
          <div class="meta"><strong>${escapeHtml(copy.userId)}:</strong> ${renderSensitiveHtml(account.userId ?? account.accountId, "id", "-")}</div>
          <div class="meta"><strong>${escapeHtml(copy.status)}:</strong> ${escapeHtml(accountStatus)}</div>
        </div>
        <div class="detail-actions">
          ${
            autoSwitchLockedUntil
              ? `<div class="detail-note"><strong>${escapeHtml(copy.autoSwitchLockedUntil)}:</strong> ${renderLiveTimestamp(autoSwitchLockedUntil, copy)}</div>`
              : ""
          }
        </div>
      </div>
    </section>

    <section class="quota-grid">${quotaCards}</section>

    <section class="usage-card">
      <div class="usage-head">
        <div class="usage-title-block">
          <h2>${escapeHtml(copy.usageTitle)}</h2>
          <div class="usage-note">Verified VS Code tokens · saved daily in UTC</div>
          <div class="meta">${escapeHtml(copy.usageSubtitle)}</div>
        </div>
        <div class="usage-range">${escapeHtml(copy.rangeLabel(options.usage?.days ?? 30))}</div>
      </div>
      ${options.usageState === "error" ? `<div class="usage-feedback" role="alert">${escapeHtml(options.usageError ?? copy.usageError)} <button type="button" data-role="retry-usage" data-account-id="${escapeHtmlAttr(account.id)}">Retry</button></div>` : ""}
      ${options.usageFetchedAt ? `<div class="meta">Saved ${escapeHtml(formatTimestamp(options.usageFetchedAt))}${options.usageState === "error" ? " · Refresh failed; saved history kept" : ""}</div>` : ""}
      ${renderUsageSection(options.usageState, options.usage, copy)}
    </section>

    <section class="meta-card">
      <h2>${escapeHtml(copy.metadata)}</h2>
      <div class="meta-grid">
        <div class="meta-box">
          <div class="label">${escapeHtml(copy.accountId)}</div>
          <div class="content">${renderSensitiveHtml(account.accountId, "id", "-")}</div>
        </div>
        <div class="meta-box">
          <div class="label">${escapeHtml(copy.organizationId)}</div>
          <div class="content">${renderSensitiveHtml(account.organizationId, "id", "-")}</div>
        </div>
        <div class="meta-box">
          <div class="label">${escapeHtml(copy.lastQuotaRefresh)}</div>
          <div class="content">${renderLiveTimestamp(account.lastQuotaAt, copy)}</div>
        </div>
        <div class="meta-box">
          <div class="label">${escapeHtml(copy.loginTime)}</div>
          <div class="content">${renderLiveTimestamp(account.loginAt, copy)}</div>
        </div>
      </div>
    </section>

  </div>
  <script src="${scripts.page}"></script>
</body>
</html>`;
}

export function getDetailsThemePreference(): DashboardThemeOption {
  return normalizeDashboardTheme(getCodexManagerConfiguration().get<string>("dashboardTheme", "auto"));
}

export function getPrivacyModePreference(): boolean {
  return getCodexManagerConfiguration().get<boolean>("privacyMode", false);
}

export function renderDetailsThemeAttributes(theme: DashboardThemeOption): string {
  return `data-theme="${theme}" data-theme-preference="${theme}"`;
}

export function renderDetailsBodyAttributes(privacyMode: boolean): string {
  const classAttr = privacyMode ? ' class="privacy-hidden"' : "";
  return `${classAttr} data-privacy-hidden="${privacyMode ? "true" : "false"}"`;
}

export function getDetailsWorkspaceValue(
  account: Pick<CodexManagerAccountRecord, "accountName" | "accountStructure">,
  fallback: string
): string {
  const name = account.accountName?.trim();
  if (name) {
    return name;
  }

  const structure = account.accountStructure?.trim().toLowerCase();
  return !structure || structure === "personal" ? fallback : "";
}

function getWebviewStyles(webview: vscode.Webview, extensionUri: vscode.Uri, pageStylesheet: string): WebviewStyles {
  const shared = vscode.Uri.joinPath(extensionUri, "media", "webview", "shared.css");
  const page = vscode.Uri.joinPath(extensionUri, "media", "webview", pageStylesheet);
  return {
    shared: webview.asWebviewUri(shared).toString(),
    page: webview.asWebviewUri(page).toString()
  };
}

function getWebviewScripts(webview: vscode.Webview, extensionUri: vscode.Uri, pageScript: string): WebviewScripts {
  const page = vscode.Uri.joinPath(extensionUri, "media", "webview", pageScript);
  return {
    page: webview.asWebviewUri(page).toString()
  };
}

function renderUsageSection(
  state: "loading" | "ready" | "empty" | "error",
  usage: CodexDailyUsageBreakdown | undefined,
  copy: DetailCopy
): string {
  if (state === "loading" && !usage) {
    return `<div class="usage-empty">${escapeHtml(copy.usageLoading)}</div>`;
  }

  if (state === "error") {
    if (!usage) return "";
  }

  if (!usage?.points.length) {
    return `<div class="usage-empty">${escapeHtml(copy.usageEmpty)}</div>`;
  }

  const firstPoint = usage.points[0];
  const lastPoint = usage.points[usage.points.length - 1];
  if (!firstPoint || !lastPoint) {
    return `<div class="usage-empty">${escapeHtml(copy.usageEmpty)}</div>`;
  }

  const max = usage.points.reduce((current, point) => Math.max(current, point.totalTokens), 0) || 1;
  const startLabel = formatUsageDate(firstPoint.date, copy.lang);
  const endLabel = formatUsageDate(lastPoint.date, copy.lang);
  const bars = usage.points
    .map((point, index) => {
      const totalValue = point.totalTokens;
      const height = Math.max(2, Math.round((totalValue / max) * 100));
      const usageTitle = escapeHtmlAttr(`${formatUsageDate(point.date, copy.lang)} · VS Code ${point.totalTokens.toLocaleString(getIntlLocale(copy.lang))} tokens`);
      const edgeClass = index === 0 ? " edge-left" : index === usage.points.length - 1 ? " edge-right" : "";
      const segments = `<div class="usage-segment" style="height:100%;--segment-color:#58a6ff"></div>`;
      return `<div class="usage-bar${totalValue <= 0 ? " is-zero" : ""}${edgeClass}" title="${usageTitle}" style="--bar-height:${height}%;">
        <div class="usage-bar-fill" style="height:${height}%;">${segments}</div>
      </div>`;
    })
    .join("");

  return `<div class="usage-chart">
    <div class="usage-bars">${bars}</div>
    <div class="usage-axis">
      <span>${escapeHtml(startLabel)}</span>
      <span class="usage-legends">VS Code</span>
      <span>${escapeHtml(endLabel)}</span>
    </div>
  </div>`;
}

function renderQuotaValue(value: number | undefined): string {
  return typeof value === "number" ? `${value}%` : "--";
}

function renderLiveReset(epochSeconds: number | undefined, copy: DetailCopy): string {
  if (!epochSeconds) {
    return copy.resetUnknown;
  }

  return `<span class="live-reset" data-reset-at="${epochSeconds}" data-reset-unknown="${escapeHtml(copy.resetUnknown)}">${escapeHtml(formatRelativeReset(epochSeconds))}</span>`;
}

function renderLiveTimestamp(epochMs: number | undefined, copy: DetailCopy): string {
  if (!epochMs) {
    return copy.never;
  }

  return `<span class="live-timestamp" data-epoch-ms="${epochMs}" data-never="${escapeHtml(copy.never)}">${escapeHtml(formatTimestamp(epochMs))}</span>`;
}

function renderSensitiveHtml(value: string | undefined, kind: SensitiveKind, fallback = "—"): string {
  const normalized = value?.trim();
  if (!normalized) {
    return escapeHtml(fallback);
  }

  return `<span class="privacy-sensitive"><span class="privacy-sensitive-raw">${escapeHtml(normalized)}</span><span class="privacy-sensitive-masked">${escapeHtml(maskSensitiveValue(normalized, kind))}</span></span>`;
}

function maskSensitiveValue(value: string, kind: SensitiveKind): string {
  void kind;
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function renderEyeSvg(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"></circle></svg>`;
}

function renderEyeOffSvg(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M10.6 5.7A12.6 12.6 0 0 1 12 5.6c6.7 0 10.5 6.4 10.5 6.4a18.4 18.4 0 0 1-4 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M6.2 7.2A18.8 18.8 0 0 0 1.5 12s3.8 6 10.5 6c1.6 0 3-.3 4.3-.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M9.9 9.8A3.2 3.2 0 0 0 14.2 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

function formatUsageDate(input: string, lang: DashboardLanguage): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return input;
  }

  return new Intl.DateTimeFormat(getIntlLocale(lang), { month: "short", day: "numeric" }).format(date);
}

type DetailCopy = {
  lang: DashboardLanguage;
  titlePrefix: string;
  detailsSubtitle: string;
  current: string;
  saved: string;
  disabledTag: string;
  authErrorTag: string;
  quotaErrorTag: string;
  showSensitive: string;
  hideSensitive: string;
  currentlyActive: string;
  savedAccount: string;
  teamName: string;
  login: string;
  loginTime: string;
  subscription: string;
  userId: string;
  status: string;
  hourlyQuota: string;
  weeklyQuota: string;
  reviewQuota: string;
  reset: string;
  usageTitle: string;
  usageHint: string;
  usageSubtitle: string;
  usageLoading: string;
  usageEmpty: string;
  usageError: string;
  rangeLabel: (days: number) => string;
  metadata: string;
  accountId: string;
  organizationId: string;
  lastQuotaRefresh: string;
  resetUnknown: string;
  never: string;
  lockAutoSwitchBtn: string;
  unlockAutoSwitchBtn: string;
  autoSwitchLockedUntil: string;
};

function getCopy(): DetailCopy {
  const lang = getLanguage();
  const resource = detailCopyResources[lang];
  return {
    lang,
    ...resource,
    rangeLabel: (days) => resource.rangeLabelTemplate.replace("{days}", String(days))
  };
}

function renderHealthBadge(
  kind: ReturnType<typeof resolveAccountHealth>["kind"],
  dismissed: boolean,
  copy: ReturnType<typeof getDashboardCopy>
): string {
  if (dismissed) {
    return "";
  }

  switch (kind) {
    case "healthy":
      return `<span class="pill ok">${escapeHtml(copy.tokenAutomationHealthy)}</span>`;
    case "expiring":
      return `<span class="pill warning">${escapeHtml(copy.tokenAutomationExpiring)}</span>`;
    case "reauthorize":
      return `<span class="pill error">${escapeHtml(copy.tokenAutomationReauthorize)}</span>`;
    case "refresh_failed":
      return `<span class="pill error">${escapeHtml(copy.tokenAutomationRefreshFailed)}</span>`;
    case "disabled":
      return `<span class="pill error">${escapeHtml(copy.tokenAutomationDisabled)}</span>`;
    case "quota":
      return `<span class="pill warning">${escapeHtml(copy.tokenAutomationQuota)}</span>`;
    default:
      return "";
  }
}
