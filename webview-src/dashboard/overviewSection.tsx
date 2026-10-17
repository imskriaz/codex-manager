import type { useTokenHistoryRefresh } from "./tokenHistoryRefresh";
import { createPortal } from "preact/compat";
import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  DashboardAccountViewModel,
  DashboardCopy,
  DashboardSettings,
  DashboardState,
  DashboardDailyUsageCacheEntry,
  DashboardUsageGraphData,
  DashboardUsageGraphQuery
} from "../../src/domain/dashboard/types";
import type { DashboardUsageSample } from "../../src/domain/dashboard/types";
import { formatRelativeTimestamp, formatTimestamp, getSensitiveDisplayValue, resolveLockMinutes } from "./helpers";
import { formatAccountUsageDuration } from "../../src/utils/accountUsage";
import { ActionButton } from "./primitives";
import { MetricGauge } from "./accountMetricPrimitives";
import { AccountAccessIcon, EyeIcon, EyeOffIcon, renderRefreshIcon, ResetCreditIcon } from "./icons";
import { loadUsageGraphPreferences, saveUsageGraphPreferences, type UsageGraphPreferences, type UsageGraphRange } from "./preferences";

export type { DashboardUsageSample } from "../../src/domain/dashboard/types";

function createBlankOverviewAccount(copy: DashboardCopy): DashboardAccountViewModel {
  return {
    id: "overview-placeholder",
    displayName: "",
    email: "",
    authProviderLabel: "",
    accountStructureLabel: "",
    workspaceLabel: "",
    isTeamWorkspace: false,
    subscriptionText: "",
    subscriptionTitle: "",
    addMethodLabel: "",
    addedAtLabel: "",
    planTypeLabel: "",
    isActive: false,
    switchQueued: false,
    isCurrentWindowAccount: false,
    enabled: false,
    queuePriority: false,
    tokenRefreshEnabled: false,
    canRefreshToken: false,
    showInStatusBar: false,
    canToggleStatusBar: false,
    statusToggleTitle: "",
    hasQuota402: false,
    healthKind: "healthy",
    healthLabel: "",
    dismissedHealth: false,
    metrics: [
      { key: "hourly", label: copy.hourlyLabel, period: "hourly", visible: true },
      { key: "weekly", label: copy.weeklyLabel, period: "weekly", visible: true }
    ]
  };
}

export function OverviewSection(props: {
  account?: DashboardAccountViewModel;
  accounts?: DashboardAccountViewModel[];
  hasAccounts: boolean;
  lang: DashboardState["lang"];
  copy: DashboardCopy;
  settings: DashboardSettings;
  now: number;
  privacyMode: boolean;
  privacyPending: boolean;
  onPrivacyToggle: () => void;
  disabled: boolean;
  addPending: boolean;
  refreshAllPending: boolean;
  consumeResetCreditPending: boolean;
  emptyAccountContent?: ComponentChildren;
  metricPriority?: string;
  usageGraphData?: DashboardUsageGraphData;
  usageGraphPending?: boolean;
  usageGraphError?: string;
  usageGraphRevision?: string;
  usageGraphSource?: string;
  usageGraphPaused?: boolean;
  onLoadUsageGraph?: (query: DashboardUsageGraphQuery) => void;
  dailyUsagePending?: boolean;
  dailyUsageError?: string;
  tokenHistoryRefresh?: ReturnType<typeof useTokenHistoryRefresh>;
  onSetAutoSwitchLock: (minutes: number) => void;
  onAddAccount: () => void;
  onOnboard: () => void;
  onRefreshAll: () => void;
  onConfigureSync: () => void;
  onSyncNow: () => void;
  syncPending: boolean;
  switchPending: boolean;
  reloadPending: boolean;
  registryOverridePending: boolean;
  onSetRegistryOverride: (enabled: boolean) => void;
  onConsumeResetCredit: () => void;
  onSwitchAccount: (accountId?: string) => void;
  onReloadAccount: () => void;
  onUnloadAuth: () => void;
  onEnableAllValid: () => void;
  onDisableAll: () => void;
  showCliSessions?: boolean;
  onOpenCliSessions?: () => void;
  onOpenCodex: () => void;
  onResumeSessions: () => void;
  resumeSessionsPending: boolean;
  codexOpenPending: boolean;
}) {
  const { account: providedAccount, copy, settings, now, hasAccounts, privacyMode } = props;
  const account = providedAccount ?? createBlankOverviewAccount(copy);
  const blankValue = "\u00a0";
  const emptyTitle = hasAccounts ? copy.noActiveAccountTitle : copy.empty;
  const emptySub = hasAccounts ? copy.noActiveAccountSub : copy.savedAccountsSub;
  const teamNameDisplay =
    account?.isTeamWorkspace && account.accountName?.trim()
      ? getSensitiveDisplayValue(account.accountName, privacyMode, "name", account.accountName)
      : undefined;
  const hasResetCredit = (account?.resetCreditsAvailable ?? 0) > 0;
  const toolbarActionCount = resolveOverviewToolbarActionCount(
    hasAccounts,
    Boolean(providedAccount),
    settings.encryptedSyncRegistryOverrideEnabled
  );
  const [lockDialogOpen, setLockDialogOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [lockMinutes, setLockMinutes] = useState(() => resolveLockMinutes(settings.autoSwitchLockMinutes));
  const lockPopoverContentRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const morePopoverContentRef = useRef<HTMLDivElement>(null);
  const [lockPopoverPosition, setLockPopoverPosition] = useState({ top: 0, right: 0 });
  const [morePopoverPosition, setMorePopoverPosition] = useState({ top: 0, right: 0 });
  const contextAction = account
    ? resolveOverviewContextAction(account, settings.encryptedSyncRegistryOverrideEnabled)
    : "switch";
  const runRefreshAll = (): void => {
    props.onRefreshAll();
  };
  const openLockDialog = (trigger: HTMLElement): void => {
    const rect = trigger.getBoundingClientRect();
    setLockPopoverPosition({ top: rect.bottom + 5, right: Math.max(8, window.innerWidth - rect.right) });
    setMoreOpen(false);
    setLockMinutes(resolveLockMinutes(settings.autoSwitchLockMinutes));
    setLockDialogOpen(true);
  };
  const toggleMoreMenu = (): void => {
    if (!moreOpen) {
      const rect = moreRef.current?.getBoundingClientRect();
      if (rect) setMorePopoverPosition(resolveOverviewPopoverPosition(rect, window.innerWidth, window.innerHeight, 0));
    }
    setMoreOpen((open) => !open);
  };
  useEffect(() => {
    if (!moreOpen) return;
    const updatePosition = (): void => {
      const rect = moreRef.current?.getBoundingClientRect();
      if (rect) setMorePopoverPosition(resolveOverviewPopoverPosition(rect, window.innerWidth, window.innerHeight, morePopoverContentRef.current?.getBoundingClientRect().height ?? 0));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [moreOpen]);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!moreRef.current?.contains(target) && !morePopoverContentRef.current?.contains(target)) setMoreOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [moreOpen]);
  useEffect(() => {
    if (!lockDialogOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!lockPopoverContentRef.current?.contains(target)) setLockDialogOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLockDialogOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [lockDialogOpen]);
  const overviewMetrics = account
    ? account.metrics
        .filter(
          (metric) => metric.visible && (typeof metric.percentage === "number" || metric.percentage === undefined)
        )
        .sort((left, right) => {
          const priority = (key: string): number =>
            props.metricPriority && key.includes(props.metricPriority) ? 0 : key.includes("weekly") ? 1 : 2;
          return priority(left.key) - priority(right.key);
        })
    : [];

  return (
    <>
      <div class="overview-shell">
        {providedAccount ? (
          <div class="overview-account">
            <div class="overview-account-main">
              <div class="overview-account-header">
                <div class="overview-account-identity-line">
                  <div class="overview-account-email">
                    {providedAccount ? getSensitiveDisplayValue(account.email, privacyMode, "email") : blankValue}
                  </div>
                  <div class="overview-account-tags">
                    <span class="pill plan">{providedAccount ? account.planTypeLabel : blankValue}</span>
                    {hasResetCredit ? (
                      <button
                        class="overview-reset-credit"
                        type="button"
                        title={formatResetCreditsTitle(account, copy)}
                        aria-label={formatResetCreditsTitle(account, copy)}
                        disabled={props.disabled || props.consumeResetCreditPending}
                        onClick={props.onConsumeResetCredit}
                      >
                        {props.consumeResetCreditPending ? (
                          <span class="saved-toggle-spinner" aria-hidden="true"></span>
                        ) : (
                          <ResetCreditIcon />
                        )}
                        <span class="saved-reset-count">{account.resetCreditsAvailable}</span>
                      </button>
                    ) : null}
                  </div>
                </div>
                {teamNameDisplay ? <div class="overview-account-workspace">{teamNameDisplay}</div> : null}
              </div>
              <div class="overview-meta">
                <div class="overview-meta-item overview-meta-item-subscription">
                  <span class="grid-label">{resolveOverviewLabel("subscription", props.lang)}</span>
                  <span class="meta-value" title={account.subscriptionTitle}>
                    {providedAccount ? account.subscriptionText : blankValue}
                  </span>
                </div>
                <div class="overview-meta-item">
                  <span class="grid-label">{resolveOverviewLabel("workspace", props.lang)}</span>
                  <span class="meta-value">{providedAccount ? account.workspaceLabel : blankValue}</span>
                </div>
                <div class="overview-meta-item">
                  <span class="grid-label">{resolveOverviewLabel("login", props.lang)}</span>
                  <span class="meta-value" title={formatTimestamp(account.loginAt, account.addedAtLabel)}>
                    {providedAccount
                      ? formatCompactDate(account.loginAt, props.lang, account.addedAtLabel)
                      : blankValue}
                  </span>
                </div>
                <div class="overview-meta-item overview-meta-item-wide">
                  <span class="grid-label">{copy.accountId}</span>
                  <span class="meta-value" title={account.accountId}>
                    {providedAccount
                      ? getSensitiveDisplayValue(account.accountId, privacyMode, "id", copy.unknown)
                      : blankValue}
                  </span>
                </div>
                <div class="overview-session-meta overview-meta-item overview-meta-item-wide">
                  <OverviewSessionValue
                    label={resolveOverviewLabel("session", props.lang)}
                    value={providedAccount ? formatAccountUsageDuration(account, now, props.lang) : blankValue}
                    title={resolveUsageDurationTitle(props.lang)}
                  />
                  <OverviewSessionValue
                    label={copy.lastRefresh}
                    value={
                      providedAccount
                        ? formatRelativeTimestamp(account.lastQuotaAt, now, copy.never, props.lang)
                        : blankValue
                    }
                    title={formatTimestamp(account.lastQuotaAt, copy.never)}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div class="overview-account overview-inline-add-panel" id="inline-add-account-panel">
            {props.emptyAccountContent}
          </div>
        )}
        <div class="overview-main">
          {account ? (
            <UsageGraph
              accounts={props.accounts ?? []}
              now={now}
              privacyMode={privacyMode}
              lang={props.lang}
              usageGraphData={props.usageGraphData}
              usageGraphPending={props.usageGraphPending}
              usageGraphError={props.usageGraphError}
              usageGraphRevision={props.usageGraphRevision}
              usageGraphSource={props.usageGraphSource}
              usageGraphPaused={props.usageGraphPaused}
              onLoadUsageGraph={props.onLoadUsageGraph}
              automaticTokenHistory={props.settings.dailyTokenUsageEnabled === true}
              dailyUsagePending={props.dailyUsagePending}
              dailyUsageError={props.dailyUsageError}
              tokenHistoryRefresh={props.tokenHistoryRefresh}
            />
          ) : null}
          <div class="overview-bottom-row">
            <div class="overview-metrics">
              {account ? (
                <div class="metrics">
                  {overviewMetrics.map((metric) => (
                    <MetricGauge
                      key={metric.key}
                      metric={metric}
                      lang={props.lang}
                      settings={settings}
                      copy={copy}
                      now={now}
                      placeholder={!providedAccount}
                    />
                  ))}
                </div>
              ) : (
                <div class="overview-empty-copy">
                  <div class="overview-empty-copy-title">
                    {!hasAccounts && settings.encryptedSyncEnabled
                      ? props.lang === "zh"
                        ? "正在等待同步账号"
                        : props.lang === "zh-hant"
                          ? "正在等待同步帳號"
                          : "Waiting for synced accounts"
                      : emptyTitle}
                  </div>
                  <div class="overview-empty-copy-sub">
                    {!hasAccounts && settings.encryptedSyncEnabled
                      ? props.lang === "zh"
                        ? "新电脑会自动加载其他电脑的账号；也可以立即同步。"
                        : props.lang === "zh-hant"
                          ? "新電腦會自動載入其他電腦的帳號；也可以立即同步。"
                          : "This new PC will load accounts from your other PCs automatically, or sync now."
                      : !hasAccounts
                        ? props.lang === "zh"
                          ? "设置加密同步后，可在其他电脑安全加载账号。"
                          : props.lang === "zh-hant"
                            ? "設定加密同步後，可在其他電腦安全載入帳號。"
                            : "Import or add accounts on this PC. Sessions and tokens stay local unless full sync is explicitly enabled."
                        : emptySub}
                  </div>
                </div>
              )}
            </div>
            <div class={`overview-actions ${!hasAccounts ? "overview-empty-actions" : ""}`}>
              <div class="toolbar" style={{ gridTemplateColumns: `repeat(${toolbarActionCount}, minmax(0, 1fr))` }}>
                <ActionButton
                  class="toolbar-btn add-account-btn"
                  icon={<AccountAccessIcon />}
                  label={copy.addAccount}
                  pending={props.addPending}
                  disabled={props.disabled}
                  onClick={props.onAddAccount}
                >
                  {resolveOverviewToolbarLabel("add", props.lang)}
                </ActionButton>
                <ActionButton
                  class="toolbar-btn"
                  icon={renderRefreshIcon()}
                  label={resolveSyncNowLabel(props.lang)}
                  pending={props.syncPending}
                  disabled={props.disabled}
                  onClick={props.onSyncNow}
                >
                  {resolveOverviewToolbarLabel("sync", props.lang)}
                </ActionButton>
                <ActionButton
                  class="toolbar-btn"
                  icon={renderRefreshIcon()}
                  label={props.copy.refreshAll}
                  pending={props.refreshAllPending}
                  // disabled={props.refreshAllPending} is the primary refresh guard.
                  disabled={props.refreshAllPending || props.disabled || !hasAccounts}
                  onClick={runRefreshAll}
                >
                  {/* Fixed toolbar refresh replaces the former More-menu item. */}
                  {resolveOverviewToolbarLabel("refresh", props.lang)}
                </ActionButton>
                <div class="overview-more-wrap" ref={moreRef}>
                  <ActionButton
                    class="toolbar-btn"
                    icon={<span class="overview-action-symbol">⋯</span>}
                    label={resolveOverviewToolbarLabel("more", props.lang)}
                    disabled={props.disabled}
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    onClick={toggleMoreMenu}
                  >
                    {resolveOverviewToolbarLabel("more", props.lang)}
                  </ActionButton>
                  {moreOpen
                    ? createPortal(
                        <div
                          ref={morePopoverContentRef}
                          class="claim-popover claim-popover-portal overview-more-menu"
                          role="menu"
                          aria-label={resolveOverviewToolbarLabel("more", props.lang)}
                          style={{ top: `${morePopoverPosition.top}px`, right: `${morePopoverPosition.right}px` }}
                        >
                          <div class="claim-popover-title">{resolveOverviewToolbarLabel("more", props.lang)}</div>
                          <button type="button" role="menuitem" disabled={props.privacyPending} onClick={() => { setMoreOpen(false); props.onPrivacyToggle(); }}>
                            {privacyMode ? <EyeOffIcon /> : <EyeIcon />}{privacyMode ? copy.showSensitive : copy.hideSensitive}
                          </button>
                          {providedAccount && contextAction !== "switch" ? (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMoreOpen(false);
                                props.onSwitchAccount();
                              }}
                            >
                              ⇄ {resolveOverviewMenuLabel("switch", props.lang)}
                            </button>
                          ) : null}
                          {providedAccount ? (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMoreOpen(false);
                                props.onReloadAccount();
                              }}
                            >
                              ↻ {resolveOverviewMenuLabel("reload", props.lang)}
                            </button>
                          ) : null}
                          {providedAccount ? (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMoreOpen(false);
                                props.onUnloadAuth();
                              }}
                            >
                              ⏏ {resolveOverviewMenuLabel("unload", props.lang)}
                            </button>
                          ) : null}
                          {props.accounts?.some((candidate) => candidate.enabled === false) ? (
                            <button
                              type="button"
                              role="menuitem"
                              disabled={!providedAccount || props.switchPending}
                              onClick={() => {
                                setMoreOpen(false);
                                props.onEnableAllValid();
                              }}
                              title={resolveOverviewEnableAllHint(props.lang)}
                            >
                              ⊕ {resolveOverviewMenuLabel("enableAll", props.lang)}
                            </button>
                          ) : null}
                          {props.accounts?.some((candidate) => candidate.enabled !== false) ? (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMoreOpen(false);
                                props.onDisableAll();
                              }}
                            >
                              ⊘ {resolveOverviewMenuLabel("disableAll", props.lang)}
                            </button>
                          ) : null}
                          {providedAccount && contextAction !== "rescue" ? (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMoreOpen(false);
                                props.onSetRegistryOverride(!settings.encryptedSyncRegistryOverrideEnabled);
                              }}
                            >
                              🛟{" "}
                              {resolveOverviewMenuLabel(
                                settings.encryptedSyncRegistryOverrideEnabled ? "rescueOff" : "rescue",
                                props.lang
                              )}
                            </button>
                          ) : null}
                          {providedAccount ? (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={(event) => {
                                if (account.autoSwitchLockedUntil) {
                                  setMoreOpen(false);
                                  props.onSetAutoSwitchLock(0);
                                } else {
                                  openLockDialog(event.currentTarget);
                                }
                              }}
                            >
                              {account.autoSwitchLockedUntil ? "🔓" : "🔒"}{" "}
                              {resolveOverviewMenuLabel(account.autoSwitchLockedUntil ? "unlock" : "lock", props.lang)}
                            </button>
                          ) : null}
                          {props.showCliSessions ? <>
                            <button type="button" role="menuitem" disabled={props.codexOpenPending} onClick={() => { setMoreOpen(false); props.onOpenCodex(); }}>◈ Codex</button>
                            <button type="button" role="menuitem" disabled={props.resumeSessionsPending} onClick={() => { setMoreOpen(false); props.onResumeSessions(); }}>↻ Resume</button>
                          </> : null}
                          {props.showCliSessions && props.onOpenCliSessions ? (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMoreOpen(false);
                                props.onOpenCliSessions!();
                              }}
                            >
                              ◉ Show All Sessions
                            </button>
                          ) : null}
                        </div>,
                        document.body
                      )
                    : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {providedAccount ? (
        <LockDialog
          account={providedAccount}
          open={lockDialogOpen}
          position={lockPopoverPosition}
          lang={props.lang}
          lockMinutes={lockMinutes}
          setLockMinutes={setLockMinutes}
          onSetAutoSwitchLock={props.onSetAutoSwitchLock}
          onClose={() => setLockDialogOpen(false)}
          contentRef={lockPopoverContentRef}
        />
      ) : null}
    </>
  );
}

export function resolveOverviewContextAction(
  account: Pick<
    DashboardAccountViewModel,
    | "isActive"
    | "isCurrentWindowAccount"
    | "switchQueued"
    | "runningDeviceName"
    | "runningOnThisDevice"
    | "runningDeviceOnline"
  >,
  registryOverrideEnabled: boolean
): "switch" | "reload" | "rescue" {
  if (account.switchQueued || (account.isActive && !account.isCurrentWindowAccount)) return "reload";
  if (
    account.runningDeviceName &&
    !account.runningOnThisDevice &&
    account.runningDeviceOnline !== false &&
    !registryOverrideEnabled
  )
    return "rescue";
  return "switch";
}

/*
 * The lock dialog is rendered below the toolbar markup. Keep it separate from
 * the compact contextual action row so Lock remains available through More.
 */
function LockDialog(props: {
  account: DashboardAccountViewModel;
  open: boolean;
  position: { top: number; right: number };
  lang: DashboardState["lang"];
  lockMinutes: number;
  setLockMinutes: (minutes: number) => void;
  onSetAutoSwitchLock: (minutes: number) => void;
  onClose: () => void;
  contentRef: preact.RefObject<HTMLDivElement>;
}) {
  return props.open && !props.account.autoSwitchLockedUntil
    ? createPortal(
        <div
          ref={props.contentRef}
          class="claim-popover claim-popover-portal auto-switch-lock-popover"
          role="dialog"
          aria-label={resolveLockDialogText("title", props.lang)}
          style={{ top: `${props.position.top}px`, right: `${props.position.right}px` }}
        >
          <div class="claim-popover-head">
            <div class="claim-popover-title">{resolveLockDialogText("title", props.lang)}</div>
            <button
              class="claim-popover-close"
              type="button"
              aria-label={resolveLockDialogText("cancel", props.lang)}
              onClick={props.onClose}
            >
              ×
            </button>
          </div>
          <form
            class="auto-switch-lock-form"
            onSubmit={(event) => {
              event.preventDefault();
              const minutes = Math.max(1, Math.min(120, Math.round(props.lockMinutes)));
              props.onSetAutoSwitchLock(minutes);
              props.onClose();
            }}
          >
            <label class="auto-switch-lock-field">
              <span>{resolveLockDialogText("minutes", props.lang)}</span>
              <input
                class="modal-input"
                type="number"
                min="1"
                max="120"
                step="1"
                value={props.lockMinutes}
                onInput={(event) => props.setLockMinutes(event.currentTarget.valueAsNumber || 1)}
              />
            </label>
            <div class="claim-popover-actions">
              <button class="claim-popover-action is-secondary" type="button" onClick={props.onClose}>
                {resolveLockDialogText("cancel", props.lang)}
              </button>
              <button class="claim-popover-action is-primary" type="submit">
                {resolveLockDialogText("apply", props.lang)}
              </button>
            </div>
          </form>
        </div>,
        document.body
      )
    : null;
}

export function resolveOverviewPopoverPosition(
  triggerRect: Pick<DOMRect, "bottom" | "right">,
  viewportWidth: number,
  viewportHeight: number,
  menuHeight: number
): { top: number; right: number } {
  return {
    top: Math.max(8, Math.min(triggerRect.bottom + 5, viewportHeight - menuHeight - 8)),
    right: Math.max(8, viewportWidth - triggerRect.right)
  };
}

function resolveLockDialogText(key: "title" | "minutes" | "apply" | "cancel", lang: DashboardState["lang"]): string {
  const zh = lang === "zh";
  const hant = lang === "zh-hant";
  const copy = {
    title: zh ? "锁定自动切换" : hant ? "鎖定自動切換" : "Lock Auto Switch",
    minutes: zh ? "锁定分钟数" : hant ? "鎖定分鐘數" : "Minutes",
    apply: zh ? "应用" : hant ? "套用" : "Apply",
    cancel: zh ? "取消" : hant ? "取消" : "Cancel"
  };
  return copy[key];
}

export type UsageSegment = { key: string; used: number; color: string };
export type UsageEvent = { at: number; accountId: string; used: number; segments?: UsageSegment[] };
const USAGE_GRAPH_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#f0883e"];
const USAGE_GRAPH_MAX_COLOR_KEYS = 6;
const USAGE_GRAPH_MINUTE_MS = 60_000;
const USAGE_GRAPH_MAX_DISTRIBUTION_MINUTES = 60;
const USAGE_GRAPH_RANGES: Array<{ key: UsageGraphRange; label: string; durationMs: number }> = [
  { key: "1h", label: "1H", durationMs: 60 * 60 * 1000 },
  { key: "3h", label: "3H", durationMs: 3 * 60 * 60 * 1000 },
  { key: "6h", label: "6H", durationMs: 6 * 60 * 60 * 1000 },
  { key: "24h", label: "24H", durationMs: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7D", durationMs: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "30D", durationMs: 30 * 24 * 60 * 60 * 1000 }
];
const USAGE_GRAPH_VIEWBOX_HEIGHT = 56;
const USAGE_GRAPH_BASELINE = 52;
const USAGE_GRAPH_MAX_BAR_HEIGHT = 42;

type UsageGraphBar = { event: UsageEvent; x: number; width: number; height: number; bucketStart: number; bucketEnd: number };
type UsageGraphAnchor = Pick<DOMRect, "left" | "right" | "top" | "bottom">;
export const formatTokenCount = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format;
const USAGE_EXACT_NUMBER = new Intl.NumberFormat("en", { maximumFractionDigits: 3 });

export function resolveUsageAxisMaximum(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.min(Number.MAX_VALUE, ([1, 2, 5, 10].find(step => step * magnitude >= value) ?? 10) * magnitude);
}

export function layoutUsageGraphBars(events: readonly UsageEvent[], from: number, to: number, buckets: number, maximum: number): UsageGraphBar[] {
  if (![from, to, buckets, maximum].every(Number.isFinite) || to <= from || !Number.isInteger(buckets) || buckets < 1 || maximum <= 0) return [];
  const duration = (to - from) / buckets;
  const groups = new Map<number, UsageEvent[]>();
  for (const event of events) {
    if (!Number.isFinite(event.at) || !Number.isFinite(event.used) || event.used < 0 || event.at < from || event.at > to) continue;
    const bucket = Math.min(buckets - 1, Math.floor((event.at - from) / duration));
    const group = groups.get(bucket) ?? [];
    group.push(event);
    groups.set(bucket, group);
  }
  const slotWidth = 100 / buckets;
  const width = slotWidth * 0.72 / Math.max(1, ...[...groups.values()].map(group => group.length));
  return [...groups.entries()].sort(([a], [b]) => a - b).flatMap(([bucket, group]) =>
    group.sort((a, b) => a.accountId.localeCompare(b.accountId)).map((event, index) => ({
      event,
      x: bucket * slotWidth + slotWidth / 2 + (index - (group.length - 1) / 2) * width * 1.12 - width / 2,
      width,
      height: Math.max(0, Math.min(1, event.used / maximum)) * USAGE_GRAPH_MAX_BAR_HEIGHT,
      bucketStart: from + bucket * duration,
      bucketEnd: from + (bucket + 1) * duration
    }))
  );
}

export function positionUsageGraphTooltip(anchor: UsageGraphAnchor, width: number, height: number, viewportWidth: number, viewportHeight: number): { left: number; top: number } {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const safeViewportWidth = Number.isFinite(viewportWidth) ? Math.max(16, viewportWidth) : 16;
  const safeViewportHeight = Number.isFinite(viewportHeight) ? Math.max(16, viewportHeight) : 16;
  const maxLeft = Math.max(8, safeViewportWidth - safeWidth - 8);
  const left = Math.max(8, Math.min(maxLeft, (anchor.left + anchor.right - safeWidth) / 2));
  const above = anchor.top - safeHeight - 10;
  const maxTop = Math.max(8, safeViewportHeight - safeHeight - 8);
  const top = above >= 8 ? Math.min(maxTop, above) : Math.max(8, Math.min(maxTop, anchor.bottom + 10));
  return { left, top };
}

function readTooltipViewport(): { width: number; height: number } {
  const viewport = window.visualViewport;
  return { width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight };
}

function observeTooltipLayout(element: HTMLDivElement, update: () => void): () => void {
  update();
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
  observer?.observe(element);
  window.addEventListener("resize", update);
  window.visualViewport?.addEventListener("resize", update);
  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("resize", update);
  };
}

export function summarizeUsageSegments(segments: readonly UsageSegment[]): UsageSegment[] {
  const rows = segments.filter(segment => Number.isFinite(segment.used) && segment.used > 0).sort((a, b) => b.used - a.used);
  return rows.length <= 4 ? rows : [...rows.slice(0, 3), { key: "Other sources", used: rows.slice(3).reduce((sum, row) => sum + row.used, 0), color: "currentColor" }];
}

function UsageGraph(props: {
  automaticTokenHistory: boolean;
  accounts: DashboardAccountViewModel[];
  now: number;
  privacyMode: boolean;
  lang: DashboardState["lang"];
  usageGraphData?: DashboardUsageGraphData;
  usageGraphPending?: boolean;
  usageGraphError?: string;
  usageGraphRevision?: string;
  usageGraphSource?: string;
  usageGraphPaused?: boolean;
  onLoadUsageGraph?: (query: DashboardUsageGraphQuery) => void;
  dailyUsagePending?: boolean;
  dailyUsageError?: string;
  tokenHistoryRefresh?: ReturnType<typeof useTokenHistoryRefresh>;
}) {
  const [preferences, setPreferences] = useState(loadUsageGraphPreferences);
  const preferencesRef = useRef(preferences);
  const [preferenceSaveFailed, setPreferenceSaveFailed] = useState(false);
  const { mode: graphMode, windowOffset } = preferences;
  const range = graphMode === "tokens" ? preferences.tokenRange : preferences.quotaRange;
  const updatePreferences = (patch: Partial<UsageGraphPreferences>): void => {
    const next = { ...preferencesRef.current, ...patch };
    preferencesRef.current = next;
    setPreferences(next);
    setPreferenceSaveFailed(!saveUsageGraphPreferences(next));
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [hovered, setHovered] = useState<{ bar: UsageGraphBar; anchor: UsageGraphAnchor }>();
  const [accountSummary, setAccountSummary] = useState<{ anchor: UsageGraphAnchor; pinned: boolean }>();
  const summaryButtonRef = useRef<HTMLButtonElement>(null);
  const summaryPanelRef = useRef<HTMLDivElement>(null);
  const summaryCloseTimer = useRef<ReturnType<typeof setTimeout>>();
  const barTooltipRef = useRef<HTMLDivElement>(null);
  const barCloseTimer = useRef<ReturnType<typeof setTimeout>>();
  const keepBarTooltipOpen = (): void => { clearTimeout(barCloseTimer.current); };
  const dismissBarTooltipLater = (): void => {
    keepBarTooltipOpen();
    barCloseTimer.current = setTimeout(() => setHovered(undefined), 150);
  };
  useEffect(() => () => clearTimeout(barCloseTimer.current), []);
  const tooltipId = useId();
  const summaryTooltipId = useId();
  const keepSummaryOpen = (): void => { clearTimeout(summaryCloseTimer.current); };
  const dismissSummaryLater = (): void => {
    keepSummaryOpen();
    if (!accountSummary?.pinned) summaryCloseTimer.current = setTimeout(() => setAccountSummary(current => current?.pinned ? current : undefined), 150);
  };
  useEffect(() => () => clearTimeout(summaryCloseTimer.current), []);
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    if (!settingsOpen) { setMenuPosition(undefined); return; }
    const menu = menuRef.current?.getBoundingClientRect();
    const anchor = menuButtonRef.current?.getBoundingClientRect();
    if (menu && anchor) {
      const viewport = readTooltipViewport();
      const position = positionUsageGraphTooltip(anchor, menu.width, menu.height, viewport.width, viewport.height);
      const left = Math.max(8, Math.min(Math.max(8, viewport.width - menu.width - 8), anchor.right - menu.width));
      setMenuPosition(previous => previous?.left === left && previous.top === position.top ? previous : { left, top: position.top });
    }
  }, [settingsOpen, graphMode, props.accounts.length, props.tokenHistoryRefresh?.statuses]);
  useLayoutEffect(() => { if (settingsOpen) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); }, [settingsOpen]);
  const graphStageRef = useRef<HTMLDivElement>(null);
  const loadQueryRef = useRef(props.onLoadUsageGraph);
  loadQueryRef.current = props.onLoadUsageGraph;
  const accountMap = useMemo(() => new Map(props.accounts.map((account, index) => [account.id, {
    label: getSensitiveDisplayValue(account.email, props.privacyMode, "email"),
    color: USAGE_GRAPH_COLORS[index % USAGE_GRAPH_COLORS.length]!,
    device: account.runningDeviceName ? getSensitiveDisplayValue(account.runningDeviceName, props.privacyMode, "name") : undefined,
  }])), [props.accounts, props.privacyMode]);
  const availableRanges = graphMode === "tokens" ? USAGE_GRAPH_RANGES.filter(candidate => candidate.durationMs >= 86_400_000) : USAGE_GRAPH_RANGES;
  const activeRange = availableRanges.some(candidate => candidate.key === range) ? range : graphMode === "tokens" ? "30d" : "1h";
  const rangeDuration = USAGE_GRAPH_RANGES.find(candidate => candidate.key === activeRange)!.durationMs;
  const queryWindow = useMemo(() => {
    const end = graphMode === "tokens" ? (Math.floor(props.now / 86_400_000) + 1) * 86_400_000 : props.now;
    return { mode: graphMode, from: end - (windowOffset + 1) * rangeDuration, to: end - windowOffset * rangeDuration };
  }, [graphMode, rangeDuration, windowOffset, props.usageGraphRevision, props.usageGraphSource]);
  useEffect(() => { if (!props.usageGraphPaused) loadQueryRef.current?.(queryWindow); }, [queryWindow, props.usageGraphPaused]);
  const data = props.usageGraphData?.mode === graphMode ? props.usageGraphData : undefined;
  const graphStartAt = data?.from ?? queryWindow.from;
  const graphEndAt = data?.to ?? queryWindow.to;
  const duration = graphEndAt - graphStartAt;
  const displayedRange = USAGE_GRAPH_RANGES.find(candidate => candidate.durationMs === duration)?.key ?? activeRange;
  const bucketCount = graphMode === "tokens" ? Math.max(1, Math.round(duration / 86_400_000)) : resolveUsageGraphBucketCount(displayedRange);
  const dailyUsageCache = useMemo(() => (data?.dailyUsageCache ?? []).filter(entry => accountMap.has(entry.accountId)), [data, accountMap]);
  const events = useMemo(() => graphMode === "tokens"
    ? buildDailyTokenUsageEvents(dailyUsageCache).filter(event => event.at >= graphStartAt && event.at < graphEndAt)
    : aggregateUsageEvents(buildUsageEvents(selectUsageHistoryWindow(data?.history ?? [], graphStartAt, graphEndAt),
        { from: graphStartAt, to: graphEndAt, buckets: bucketCount }), graphStartAt, duration, bucketCount),
    [data, graphMode, dailyUsageCache, graphStartAt, graphEndAt, duration, bucketCount]);
  const usageByAccount = useMemo(() => {
    const totals = new Map<string, number>();
    for (const event of events) totals.set(event.accountId, (totals.get(event.accountId) ?? 0) + event.used);
    return totals;
  }, [events]);
  const cacheByAccount = useMemo(() => new Map(dailyUsageCache.map(entry => [entry.accountId, entry])), [dailyUsageCache]);
  const missingUsageAccounts = props.accounts.filter(account => {
    const entry = cacheByAccount.get(account.id);
    return !entry || entry.usage.points.some(point => point.unit !== "tokens" || point.extensionTokens === undefined);
  });
  useEffect(() => {
    if (!props.automaticTokenHistory || graphMode !== "tokens" || !data || props.usageGraphPending || props.usageGraphError) return;
    const missing = missingUsageAccounts.filter(account => !props.tokenHistoryRefresh?.statuses[account.id]);
    if (missing.length) props.tokenHistoryRefresh?.refresh(missing.map(account => account.id), true);
  }, [props.automaticTokenHistory, data, props.accounts, props.usageGraphPending, props.usageGraphError, props.tokenHistoryRefresh?.statuses]);
  useEffect(() => { setAccountSummary(undefined); }, [graphMode, activeRange, windowOffset, props.usageGraphSource]);
  useEffect(() => { if (settingsOpen) setAccountSummary(undefined); }, [settingsOpen]);
  const refreshErrors = Object.entries(props.tokenHistoryRefresh?.statuses ?? {}).filter(([, status]) => status.state === "error");
  const plotEvents = useMemo(() => graphMode === "tokens" ? consolidateDailyUsageEvents(events) : events, [events, graphMode]);
  const maximum = resolveUsageAxisMaximum(Math.max(0, ...plotEvents.map(event => event.used)));
  const bars = useMemo(() => layoutUsageGraphBars(plotEvents, graphStartAt, graphEndAt, bucketCount, maximum), [plotEvents, graphStartAt, graphEndAt, bucketCount, maximum]);
  const accountIds = new Set(events.map(event => event.accountId));
  const legend = props.accounts.filter(account => !accountIds.size || accountIds.has(account.id));
  const total = events.reduce((sum, event) => sum + event.used, 0);
  const error = props.usageGraphError ?? (graphMode === "tokens" ? props.dailyUsageError : undefined);
  const feedback = error ?? (data?.truncated ? "Only the latest 10,000 records are shown. Choose a shorter range for complete detail." : props.usageGraphPending || (graphMode === "tokens" && props.dailyUsagePending) ? "Updating saved usage…" : undefined);
  const formatAxis = (value: number) => graphMode === "tokens" ? formatTokenCount(value) : formatUsageValue(value);
  const showBar = (bar: UsageGraphBar, target: SVGRectElement): void => {
    keepBarTooltipOpen();
    setSettingsOpen(false);
    keepSummaryOpen();
    setAccountSummary(undefined);
    setHovered({ bar, anchor: target.getBoundingClientRect() });
  };
  useLayoutEffect(() => { setHovered(undefined); }, [data, graphMode, props.usageGraphSource]);
  useEffect(() => {
    if (!settingsOpen && !hovered && !accountSummary) return;
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !cardRef.current?.contains(event.target) && !menuRef.current?.contains(event.target) && !summaryPanelRef.current?.contains(event.target) && !barTooltipRef.current?.contains(event.target)) { setSettingsOpen(false); setHovered(undefined); setAccountSummary(undefined); }
    };
    const hideTooltip = (event: Event): void => {
      if (!(event.target instanceof Node && barTooltipRef.current?.contains(event.target))) setHovered(undefined);
      if (!(event.target instanceof Node && summaryPanelRef.current?.contains(event.target))) setAccountSummary(undefined);
      if (!(event.target instanceof Node && menuRef.current?.contains(event.target))) setSettingsOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { if (settingsOpen) menuButtonRef.current?.focus(); if (accountSummary) summaryButtonRef.current?.focus({ preventScroll: true }); setSettingsOpen(false); setHovered(undefined); keepSummaryOpen(); setAccountSummary(undefined); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", hideTooltip);
    window.addEventListener("scroll", hideTooltip, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", hideTooltip);
      window.removeEventListener("scroll", hideTooltip, true);
    };
  }, [settingsOpen, Boolean(hovered), Boolean(accountSummary)]);
  const bucketTotal = hovered ? bars.filter(bar => bar.bucketStart === hovered.bar.bucketStart).reduce((sum, bar) => sum + bar.event.used, 0) : 0;
  const dayUsageByAccount = new Map<string, number>();
  if (hovered && graphMode === "tokens") for (const event of events) {
    if (event.at >= hovered.bar.bucketStart && event.at < hovered.bar.bucketEnd) dayUsageByAccount.set(event.accountId, (dayUsageByAccount.get(event.accountId) ?? 0) + event.used);
  }
  return (
    <div class="usage-graph-card" ref={cardRef} data-mode={graphMode} aria-label={graphMode === "tokens" ? "Token usage chart" : "Quota usage chart"}>
      <div class="usage-graph-head">
        <div class="usage-graph-title">
          <strong>{graphMode === "tokens" ? "Tokens" : "Quota"}</strong>
          <button ref={summaryButtonRef} type="button" class="usage-graph-summary-trigger" aria-label="View account usage stats" aria-expanded={Boolean(accountSummary)} aria-describedby={accountSummary ? summaryTooltipId : undefined}
            onMouseEnter={event => { keepSummaryOpen(); setHovered(undefined); setSettingsOpen(false); const anchor = event.currentTarget.getBoundingClientRect(); setAccountSummary(current => current?.pinned ? current : { anchor, pinned: false }); }}
            onMouseLeave={dismissSummaryLater}
            onFocus={event => { keepSummaryOpen(); setHovered(undefined); setSettingsOpen(false); const anchor = event.currentTarget.getBoundingClientRect(); setAccountSummary(current => current?.pinned ? current : { anchor, pinned: false }); }}
            onBlur={dismissSummaryLater}
            onClick={event => { keepSummaryOpen(); setHovered(undefined); setSettingsOpen(false); const anchor = event.currentTarget.getBoundingClientRect(); setAccountSummary(current => current?.pinned ? undefined : { anchor, pinned: true }); }}>
          <span class="usage-graph-summary">
            {graphMode === "tokens" ? events.length ? `${formatTokenCount(total)} total` : "No data" : `${accountIds.size} ${accountIds.size === 1 ? "account" : "accounts"}`}
          </span>
          <span class="usage-graph-color-key" aria-label={graphMode === "tokens" ? "Usage sources" : "Account color key"}>
            {graphMode === "tokens" ? <><i class="usage-graph-color-chip" style={{ background: "#58a6ff" }} title="VS Code" /><small>VS Code</small><i class="usage-graph-color-chip" style={{ background: "#f0883e" }} title="Other" /><small>Other</small></> : legend.slice(0, USAGE_GRAPH_MAX_COLOR_KEYS).map(account => {
              const entry = accountMap.get(account.id)!;
              return <i key={account.id} class="usage-graph-color-chip" style={{ background: entry.color }} role="img" aria-label={entry.label} title={entry.label} />;
            })}
            {graphMode === "tokens" && events.some(event => event.segments?.some(segment => segment.key === "Unknown source")) ? <><i class="usage-graph-color-chip" style={{ background: "#8b949e" }} /><small>Unknown source</small></> : null}
            {graphMode !== "tokens" && legend.length > USAGE_GRAPH_MAX_COLOR_KEYS ? <small>+{legend.length - USAGE_GRAPH_MAX_COLOR_KEYS}</small> : null}
          </span>
          </button>
        </div>
        <div class="usage-graph-controls">
          <div class="usage-graph-ranges">
            <select value={activeRange} aria-label="Graph time range" onChange={event => updatePreferences({ [graphMode === "tokens" ? "tokenRange" : "quotaRange"]: event.currentTarget.value as UsageGraphRange, windowOffset: 0 })}>
              {availableRanges.map(candidate => <option key={candidate.key} value={candidate.key}>{graphMode === "tokens" && candidate.key === "24h" ? "1D" : candidate.label}</option>)}
            </select>
          </div>
          <div class="usage-graph-settings-wrap">
            <button ref={menuButtonRef} type="button" class={settingsOpen ? "active" : ""} aria-label="Graph settings" aria-expanded={settingsOpen} title="Graph settings" onClick={() => { setHovered(undefined); setSettingsOpen(open => !open); }}>⚙</button>
            {settingsOpen ? createPortal(<div ref={menuRef} class="usage-graph-settings-popover" role="dialog" aria-label="Graph settings" style={{ left: menuPosition?.left ?? 8, top: menuPosition?.top ?? 8, visibility: menuPosition ? "visible" : "hidden" }}>
              <strong>Chart data</strong>
              <button type="button" class={graphMode === "quota" ? "active" : ""} aria-pressed={graphMode === "quota"} onClick={() => { updatePreferences({ mode: "quota", windowOffset: 0 }); setSettingsOpen(false); }}>Quota changes</button>
              <button type="button" class={graphMode === "tokens" ? "active" : ""} aria-pressed={graphMode === "tokens"} onClick={() => { updatePreferences({ mode: "tokens", windowOffset: 0 }); setSettingsOpen(false); }}>Token usage</button>
              <p class="usage-graph-details-note">{graphMode === "tokens" ? `Saved daily tokens: VS Code + Other across accounts · UTC. ${props.automaticTokenHistory ? "Checked on account load, at the configured interval. Missing history loads automatically." : "Automatic collection is off. Enable Automatic token history in Settings to collect usage."}` : "Quota used by each account in the selected period. Timing is estimated between quota checks."}</p>
              <div class="usage-graph-cache-head"><span>{graphMode === "tokens" ? "Saved accounts" : "Account usage"}</span>
                {graphMode === "tokens" ? <button type="button" disabled={props.tokenHistoryRefresh?.busy || !props.accounts.length} onClick={() => props.tokenHistoryRefresh?.refresh(props.accounts.map(account => account.id))}>{renderRefreshIcon()} Refresh all</button> : <small>Used · last checked</small>}
              </div>
              {graphMode === "tokens" && props.tokenHistoryRefresh?.summary ? <div class="usage-graph-refresh-summary" role="status">{props.tokenHistoryRefresh.summary}</div> : null}
              <div class="usage-graph-cache-list" aria-label={graphMode === "tokens" ? "Saved account history" : "Account quota summary"}>
                {props.accounts.map(account => {
                  const entry = cacheByAccount.get(account.id);
                  const refresh = props.tokenHistoryRefresh?.statuses[account.id];
                  const pending = refresh?.state === "pending" || refresh?.state === "queued";
                  const checkedAt = graphMode === "tokens" ? entry?.fetchedAt : account.lastQuotaAt;
                  const age = checkedAt ? formatRelativeTimestamp(checkedAt, props.now, "Unknown", props.lang) : "Not checked";
                  const stateLabel = refresh?.state === "error" ? "Failed" : refresh?.message;
                  return <div key={account.id} class={`usage-graph-cache-row${graphMode === "quota" ? " is-quota" : ""}`}>
                    <i style={{ background: accountMap.get(account.id)?.color }} />
                    <span title={accountMap.get(account.id)?.label}>{accountMap.get(account.id)?.label}</span>
                    <small class={graphMode === "tokens" && refresh ? `is-${refresh.state}` : ""} role={graphMode === "tokens" && refresh ? "status" : undefined} title={graphMode === "tokens" && refresh ? refresh.message : `${graphMode === "quota" ? "Quota used in selected period. " : ""}Last successful check: ${checkedAt ? formatTimestamp(checkedAt, "Unknown") : "Not collected"}`}>
                      {graphMode === "tokens" ? stateLabel ?? (entry ? `${props.now - entry.fetchedAt >= 3_600_000 ? "Stale · " : ""}${age}` : "Not collected") : `${formatUsageValue(usageByAccount.get(account.id) ?? 0)} · ${age}`}
                    </small>
                    {graphMode === "tokens" ? <button class="usage-graph-account-refresh" type="button" disabled={pending} aria-busy={pending} aria-label={`Refresh token history for ${accountMap.get(account.id)?.label}`} title="Refresh this account's token history" onClick={() => props.tokenHistoryRefresh?.refresh([account.id])}>{renderRefreshIcon()}</button> : null}
                  </div>;
                })}
              </div>
              {graphMode === "tokens" && refreshErrors.length ? <div class="usage-graph-settings-error" role="alert">{refreshErrors.map(([id, status]) => `${accountMap.get(id)?.label ?? "Account"}: ${status.message}`).join("\n")}</div> : null}
              {feedback ? <div class="usage-graph-settings-error" role={error || data?.truncated ? "alert" : "status"}>{feedback}</div> : null}
              {props.usageGraphError ? <button type="button" disabled={props.usageGraphPending} aria-label="Retry saved graph" onClick={() => loadQueryRef.current?.(queryWindow)}>Retry</button> : null}
              {preferenceSaveFailed ? <div class="usage-graph-settings-error" role="alert">Chart choices could not be saved on this device.</div> : null}
            </div>, document.body) : null}
          </div>
          <div class="usage-graph-navigation">
            <button type="button" disabled={windowOffset >= 10_000 || typeof data?.oldestAt !== "number" || !Number.isFinite(data.oldestAt) || data.oldestAt >= graphStartAt} title="Older period" aria-label="Older period" onClick={() => updatePreferences({ windowOffset: windowOffset + 1 })}>‹</button>
            <button type="button" disabled={windowOffset === 0} title="Newer period" aria-label="Newer period" onClick={() => updatePreferences({ windowOffset: Math.max(0, windowOffset - 1) })}>›</button>
          </div>
        </div>
      </div>
      <div class="usage-graph-stage" ref={graphStageRef} onMouseLeave={dismissBarTooltipLater}>
        <div class="usage-graph-axis" aria-hidden="true">
          {[maximum, maximum / 2, 0].map((value, index) => <span key={index} style={{ top: `${([10, 31, 52][index]! / USAGE_GRAPH_VIEWBOX_HEIGHT) * 100}%` }}>{formatAxis(value)}</span>)}
        </div>
        <div class="usage-graph-scroll">
          <div class="usage-graph-scroll-content">
            <svg class="usage-graph" viewBox={`0 0 100 ${USAGE_GRAPH_VIEWBOX_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={graphMode === "tokens" ? "Token usage for all saved accounts" : "Quota used by account"}>
              {[10, 31, 52].map(y => <line key={y} x1="0" y1={y} x2="100" y2={y} class="usage-graph-gridline" />)}
              {hovered ? <rect class="usage-graph-cursor" x={((hovered.bar.bucketStart - graphStartAt) / duration) * 100} y="4" width={100 / bucketCount} height="48" /> : null}
              {bars.map((bar, index) => {
                const account = (graphMode === "tokens" ? { label: "All accounts", color: "#58a6ff" } : accountMap.get(bar.event.accountId)) ?? { label: "Unknown account", color: "#8b949e" };
                const selected = hovered?.bar === bar;
                const label = `${account.label}: ${USAGE_EXACT_NUMBER.format(bar.event.used)} ${graphMode === "tokens" ? "tokens" : "percent quota used"}, ${formatGraphTime(bar.event.at, props.lang, graphMode === "tokens" || displayedRange.endsWith("d") ? "date" : "time")}`;
                return <g key={`${bar.event.accountId}:${bar.bucketStart}`}>
                  {graphMode === "tokens" ? (bar.event.segments ?? []).map((segment, segmentIndex, segments) => {
                    const height = segment.used / maximum * USAGE_GRAPH_MAX_BAR_HEIGHT;
                    const below = segments.slice(0, segmentIndex).reduce((sum, row) => sum + row.used, 0) / maximum * USAGE_GRAPH_MAX_BAR_HEIGHT;
                    return <rect key={segment.key} class={`usage-graph-bar${selected ? " is-active" : ""}`} data-source={segment.key} x={bar.x} y={USAGE_GRAPH_BASELINE - below - height} width={bar.width} height={height} fill={segment.color} />;
                  }) : <rect class={`usage-graph-bar${selected ? " is-active" : ""}`} x={bar.x} y={USAGE_GRAPH_BASELINE - bar.height} width={bar.width} height={bar.height} rx={Math.min(bar.width * 0.2, 0.3)} fill={account.color} />}
                  <rect class="usage-graph-bar-hitarea" x={Math.max(0, bar.x - bar.width * 0.18)} y="4" width={bar.width * 1.36} height="48" fill="transparent" role="img" tabIndex={index === Math.min(focusedIndex, bars.length - 1) ? 0 : -1} aria-label={label} aria-describedby={selected ? tooltipId : undefined}
                    onMouseEnter={event => showBar(bar, event.currentTarget)}
                    onFocus={event => { setFocusedIndex(index); showBar(bar, event.currentTarget); }}
                    onBlur={event => { if (!(event.relatedTarget instanceof Node && barTooltipRef.current?.contains(event.relatedTarget))) setHovered(undefined); }}
                    onClick={event => showBar(bar, event.currentTarget)}
                    onKeyDown={event => {
                      if (event.key === "Escape") { event.stopPropagation(); setHovered(undefined); return; }
                      const next = event.key === "Home" ? 0 : event.key === "End" ? bars.length - 1 : event.key === "ArrowRight" ? Math.min(bars.length - 1, index + 1) : event.key === "ArrowLeft" ? Math.max(0, index - 1) : undefined;
                      if (next !== undefined) { event.preventDefault(); graphStageRef.current?.querySelectorAll<SVGRectElement>(".usage-graph-bar-hitarea")[next]?.focus(); }
                    }} />
                </g>;
              })}
            </svg>
            <div class="usage-graph-time-axis" aria-hidden="true">
              {[0, 0.5, 1].map(position => <span key={position} class={position === 0 ? "is-start" : position === 1 ? "is-end" : ""} style={{ left: `${position * 100}%` }}>{formatGraphTime(graphStartAt + duration * position - (graphMode === "tokens" && position === 1 ? 1 : 0), props.lang, graphMode === "tokens" || displayedRange.endsWith("d") ? "date" : "time")}</span>)}
            </div>
          </div>
        </div>
      </div>
      {accountSummary ? <UsageGraphAccountsTooltip id={summaryTooltipId} panelRef={summaryPanelRef} anchor={accountSummary.anchor} mode={graphMode} lang={props.lang} now={props.now} from={graphStartAt} to={graphEndAt} total={total} pending={Boolean(props.usageGraphPending)} error={props.usageGraphError} onMouseEnter={keepSummaryOpen} onMouseLeave={dismissSummaryLater}
        rows={props.accounts.map(account => ({ ...accountMap.get(account.id)!, used: usageByAccount.get(account.id), checkedAt: graphMode === "tokens" ? cacheByAccount.get(account.id)?.fetchedAt : account.lastQuotaAt, refresh: graphMode === "tokens" ? props.tokenHistoryRefresh?.statuses[account.id] : undefined }))} /> : null}
      {hovered ? <UsageGraphTooltip id={tooltipId} panelRef={barTooltipRef} onMouseEnter={keepBarTooltipOpen} onMouseLeave={dismissBarTooltipLater} bar={hovered.bar} anchor={hovered.anchor} account={accountMap.get(hovered.bar.event.accountId)} mode={graphMode} lang={props.lang} now={props.now} bucketTotal={bucketTotal}
        dayAccounts={props.accounts.map(account => ({ ...accountMap.get(account.id)!, used: dayUsageByAccount.get(account.id), fetchedAt: cacheByAccount.get(account.id)?.fetchedAt }))} /> : null}
    </div>
  );
}

function UsageGraphAccountsTooltip(props: {
  id: string; panelRef: RefObject<HTMLDivElement>; anchor: UsageGraphAnchor; mode: "quota" | "tokens";
  lang: DashboardState["lang"]; now: number; from: number; to: number; total: number; pending: boolean; error?: string;
  onMouseEnter: () => void; onMouseLeave: () => void;
  rows: Array<{ label: string; color: string; used?: number; checkedAt?: number; refresh?: { state: string; message: string } }>;
}) {
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const panel = props.panelRef.current;
    if (!panel) return;
    const update = () => {
      const bounds = panel.getBoundingClientRect();
      const viewport = readTooltipViewport();
      const next = positionUsageGraphTooltip(props.anchor, bounds.width, bounds.height, viewport.width, viewport.height);
      setPosition(previous => previous?.left === next.left && previous?.top === next.top ? previous : next);
    };
    return observeTooltipLayout(panel, update);
  }, [props.anchor, props.rows, props.pending, props.error]);
  const tokens = props.mode === "tokens";
  const format = (value: number): string => tokens ? `${formatTokenCount(value)} tokens` : formatUsageValue(value);
  return createPortal(<div id={props.id} ref={props.panelRef} class="usage-graph-tooltip usage-graph-accounts-tooltip" role="tooltip" aria-label="Account usage stats" onMouseEnter={props.onMouseEnter} onMouseLeave={props.onMouseLeave} style={{ left: position?.left ?? 8, top: position?.top ?? 8, visibility: position ? "visible" : "hidden" }}>
    <div class="usage-graph-accounts-heading"><strong>{tokens ? "Tokens · VS Code + Other" : "Quota usage"}</strong><span>{props.rows.some(row => row.used !== undefined) ? format(props.total) : "No data"}</span></div>
    <time>{formatGraphTime(props.from, props.lang, "date")} – {formatGraphTime(props.to - 1, props.lang, "date")}{tokens ? " · UTC" : ""}</time>
    <div class="usage-graph-accounts-list" tabIndex={0} aria-label="Usage by account">
      {props.rows.filter(row => !tokens || row.used !== 0).map((row, index) => <div class="usage-graph-account-stat" key={index} title={`${row.label}${row.checkedAt ? ` · Last checked ${formatTimestamp(row.checkedAt, "Unknown")}` : ""}`}>
        <i style={{ background: row.color }} /><span>{row.label}</span><strong>{row.used !== undefined ? format(row.used) : row.refresh?.state === "pending" || row.refresh?.state === "queued" ? "Loading…" : row.refresh?.state === "error" ? "Failed" : props.pending ? "Loading…" : "No data"}</strong>
      </div>)}
      {!props.rows.length ? <span>No saved accounts.</span> : null}
    </div>
    <div class="usage-graph-tooltip-meta"><span>{tokens ? "VS Code + Other · daily totals" : "Estimated between quota checks"}</span>{props.pending ? <span role="status">Loading saved usage…</span> : null}</div>
  </div>, document.body);
}

function UsageGraphTooltip(props: {
  id: string;
  panelRef: RefObject<HTMLDivElement>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  bar: UsageGraphBar;
  anchor: UsageGraphAnchor;
  account?: { label: string; color: string; device?: string };
  mode: "quota" | "tokens";
  lang: DashboardState["lang"];
  now: number;
  bucketTotal: number;
  dayAccounts: Array<{ label: string; color: string; used?: number; fetchedAt?: number }>;
}) {
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const panel = props.panelRef.current;
    if (!panel) return;
    const update = () => {
      const bounds = panel.getBoundingClientRect();
      const viewport = readTooltipViewport();
      const next = positionUsageGraphTooltip(props.anchor, bounds.width, bounds.height, viewport.width, viewport.height);
      setPosition(previous => previous?.left === next.left && previous?.top === next.top ? previous : next);
    };
    return observeTooltipLayout(panel, update);
  }, [props.anchor, props.bar, props.account?.label, props.dayAccounts]);
  const tokens = props.mode === "tokens";
  const date = new Intl.DateTimeFormat(props.lang === "zh" ? "zh-CN" : props.lang === "zh-hant" ? "zh-TW" : "en", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    ...(tokens ? { timeZone: "UTC" } : { hour: "2-digit", minute: "2-digit" })
  }).format(props.bar.event.at);
  const today = tokens && Math.floor(props.bar.event.at / 86_400_000) === Math.floor(props.now / 86_400_000);
  return createPortal(<div id={props.id} ref={props.panelRef} onFocus={props.onMouseEnter} onMouseEnter={props.onMouseEnter} onMouseLeave={props.onMouseLeave} onBlur={event => { if (!(event.relatedTarget instanceof Node && props.panelRef.current?.contains(event.relatedTarget))) props.onMouseLeave(); }} class={`usage-graph-tooltip${tokens ? " usage-graph-accounts-tooltip" : ""}`} role="tooltip" style={{ left: position?.left ?? 8, top: position?.top ?? 8, visibility: position ? "visible" : "hidden" }}>
    <time dateTime={new Date(props.bar.event.at).toISOString()}>{date}</time>
    {tokens ? <>
      <div class="usage-graph-tooltip-value"><strong title={USAGE_EXACT_NUMBER.format(props.bucketTotal)}>{formatTokenCount(props.bucketTotal)}</strong><span>tokens · All accounts this day</span></div>
      <div class="usage-graph-tooltip-breakdown" aria-label="Usage by source">{(props.bar.event.segments ?? []).filter(segment => segment.used > 0).map(segment => <div key={segment.key}><span>{segment.key}</span><strong title={USAGE_EXACT_NUMBER.format(segment.used)}>{formatTokenCount(segment.used)} tokens</strong></div>)}</div>
      <div class="usage-graph-accounts-list" tabIndex={0} aria-label="Daily usage by account">
        {props.dayAccounts.filter(row => row.used !== undefined && row.used > 0).map((row, index) => <div class="usage-graph-account-stat" key={index} title={`${row.label}${row.fetchedAt ? ` · Updated ${formatTimestamp(row.fetchedAt, "Unknown")}${props.now - row.fetchedAt >= 3_600_000 ? " · Stale" : ""}` : ""}`}>
          <i style={{ background: row.color }} /><span>{row.label}</span><strong title={USAGE_EXACT_NUMBER.format(row.used!)}>{formatTokenCount(row.used!)} tokens</strong>
        </div>)}
      </div>
    </> : <>
    <div class="usage-graph-tooltip-account"><i style={{ background: props.account?.color ?? "#8b949e" }} /><strong>{props.account?.label ?? "Unknown account"}</strong></div>
    <div class="usage-graph-tooltip-value"><strong>{formatUsageValue(props.bar.event.used)}</strong><span>quota used</span></div>
    </>}
    <div class="usage-graph-tooltip-meta">
      <span>{tokens ? today ? "Today so far · UTC" : "Saved daily total · UTC" : "Estimated between quota checks"}</span>
      {tokens && props.dayAccounts.some(row => row.used !== undefined && row.used > 0 && row.fetchedAt && props.now - row.fetchedAt >= 3_600_000) ? <span data-stale="true">Some saved usage is stale</span> : null}
      {!tokens && props.account?.device ? <span>{props.account.device}</span> : null}
    </div>
  </div>, document.body);
}

export function buildDailyTokenUsageEvents(entries: readonly DashboardDailyUsageCacheEntry[]): UsageEvent[] {
  const points = new Map<string, UsageEvent>();
  for (const entry of [...entries].sort((a, b) => a.fetchedAt - b.fetchedAt)) for (const point of entry.usage.points) {
    if (point.unit !== "tokens") continue;
    const at = Date.parse(`${point.date}T00:00:00Z`);
    const vscode = point.extensionTokens ?? 0;
    const other = point.totalTokens - vscode;
    if (Number.isFinite(at) && [point.totalTokens, vscode, other].every(value => Number.isSafeInteger(value) && value >= 0)) {
      points.set(`${entry.accountId}:${point.date}`, { at, accountId: entry.accountId, used: point.totalTokens,
        segments: point.extensionTokens === undefined ? [{ key: "Unknown source", used: point.totalTokens, color: "#8b949e" }]
          : [{ key: "VS Code", used: vscode, color: "#58a6ff" }, { key: "Other", used: other, color: "#f0883e" }] });
    }
  }
  return [...points.values()].sort((a, b) => a.at - b.at);
}

export function consolidateDailyUsageEvents(events: readonly UsageEvent[]): UsageEvent[] {
  const days = new Map<number, UsageEvent>();
  for (const event of events) {
    let day = days.get(event.at);
    if (!day) { day = { at: event.at, accountId: "all", used: 0, segments: [{ key: "VS Code", used: 0, color: "#58a6ff" }, { key: "Other", used: 0, color: "#f0883e" }] }; days.set(event.at, day); }
    day.used += event.used;
    for (const segment of event.segments ?? []) {
      const target = day.segments!.find(row => row.key === segment.key);
      if (target) target.used += segment.used;
      else day.segments!.push({ ...segment });
    }
  }
  return [...days.values()].sort((a, b) => a.at - b.at);
}

function selectUsageHistoryWindow(
  history: DashboardUsageSample[],
  startAt: number,
  endAt: number
): DashboardUsageSample[] {
  const baselineByAccount = new Map<string, DashboardUsageSample>();
  const selected: DashboardUsageSample[] = [];
  for (const sample of [...history].sort((left, right) => left.at - right.at)) {
    if (sample.at < startAt) {
      baselineByAccount.set(sample.accountId, sample);
    } else if (sample.at <= endAt) {
      selected.push(sample);
    }
  }
  return [...baselineByAccount.values(), ...selected].sort((left, right) => left.at - right.at);
}

export function buildUsageEvents(history: DashboardUsageSample[], window?: { from: number; to: number; buckets: number }): UsageEvent[] {
  const previousByAccount = new Map<string, DashboardUsageSample>();
  const events: UsageEvent[] = [];
  const grouped = new Map<string, UsageEvent>();
  const add = (event: UsageEvent): void => {
    if (!window) { events.push(event); return; }
    if (event.at < window.from || event.at > window.to) return;
    const bucket = Math.min(window.buckets - 1, Math.floor((event.at - window.from) / ((window.to - window.from) / window.buckets)));
    const key = `${event.accountId}:${bucket}`;
    const previous = grouped.get(key);
    if (previous) { previous.used += event.used; previous.at = Math.max(previous.at, event.at); }
    else grouped.set(key, event);
  };
  for (const sample of [...history].sort((left, right) => left.at - right.at)) {
    const previous = previousByAccount.get(sample.accountId);
    previousByAccount.set(sample.accountId, sample);
    if (!previous) continue;
    const drops = (["hourly", "weekly", "review"] as const).map((key) =>
      typeof previous[key] === "number" && typeof sample[key] === "number"
        ? Math.max(0, previous[key] - sample[key])
        : 0
    );
    const used = Math.max(...drops);
    if (used <= 0) {
      continue;
    }

    const elapsedMinutes = Math.max(1, Math.round((sample.at - previous.at) / USAGE_GRAPH_MINUTE_MS));
    if (elapsedMinutes > USAGE_GRAPH_MAX_DISTRIBUTION_MINUTES) {
      add({ at: sample.at, accountId: sample.accountId, used });
      continue;
    }

    // A quota API snapshot only tells us the total change since the previous
    // refresh. Interpolate ordinary refresh intervals so the one-hour chart
    // communicates an estimated per-minute rate instead of a false end spike.
    const usedPerMinute = used / elapsedMinutes;
    const elapsedMs = sample.at - previous.at;
    for (let minute = 1; minute <= elapsedMinutes; minute += 1) {
      add({
        at: previous.at + (elapsedMs * minute) / elapsedMinutes,
        accountId: sample.accountId,
        used: usedPerMinute
      });
    }
  }
  return window ? [...grouped.values()].sort((a, b) => a.at - b.at) : events;
}

function aggregateUsageEvents(
  events: UsageEvent[],
  graphStartAt: number,
  rangeDuration: number,
  bucketCount: number
): UsageEvent[] {
  if (events.length < 2 || rangeDuration <= 0) {
    return events;
  }

  const bucketDuration = rangeDuration / bucketCount;
  const grouped = new Map<string, UsageEvent>();
  for (const event of events) {
    const bucket = Math.max(0, Math.min(bucketCount - 1, Math.floor((event.at - graphStartAt) / bucketDuration)));
    const key = `${event.accountId}:${bucket}`;
    const current = grouped.get(key);
    const mergedSegments = [...(current?.segments ?? []), ...(event.segments ?? [])];
    const segmentTotals = new Map<string, UsageSegment>();
    for (const segment of mergedSegments) {
      const previous = segmentTotals.get(segment.key);
      segmentTotals.set(segment.key, {
        key: segment.key,
        used: (previous?.used ?? 0) + segment.used,
        color: previous?.color ?? segment.color
      });
    }
    grouped.set(key, {
      at: current ? Math.max(current.at, event.at) : event.at,
      accountId: event.accountId,
      used: (current?.used ?? 0) + event.used,
      segments: segmentTotals.size ? [...segmentTotals.values()] : undefined
    });
  }
  return [...grouped.values()].sort((left, right) => left.at - right.at);
}

export function resolveUsageGraphBucketCount(range: UsageGraphRange): number {
  switch (range) {
    case "1h":
      return 60;
    case "3h":
      return 30;
    case "6h":
      return 36;
    case "24h":
      return 48;
    case "7d":
      return 56;
    case "30d":
      return 60;
  }
}

function formatUsageValue(value: number): string {
  return `${USAGE_EXACT_NUMBER.format(value)}%`;
}

function formatGraphTime(timestamp: number, lang: DashboardState["lang"], mode: "time" | "date" = "time"): string {
  return new Date(timestamp).toLocaleString(lang === "zh" ? "zh-CN" : lang === "zh-hant" ? "zh-TW" : undefined, {
    ...(mode === "date" ? { month: "2-digit", day: "2-digit", timeZone: "UTC" } : { hour: "2-digit", minute: "2-digit" }),
    hour12: mode === "time"
  });
}

function OverviewSessionValue(props: { label: string; value: string; title: string }) {
  return (
    <div class="overview-session-value">
      <span class="grid-label">{props.label}</span>
      <span class="meta-value" title={props.title}>
        {props.value}
      </span>
    </div>
  );
}

function resolveUsageDurationTitle(lang: DashboardState["lang"]): string {
  if (lang === "zh") {
    return "当前会话 / 此账号累计使用时长";
  }
  if (lang === "zh-hant") {
    return "目前工作階段 / 此帳號累計使用時長";
  }
  return "Current session / total usage for this account";
}

function resolveSyncNowLabel(lang: DashboardState["lang"]): string {
  return lang === "zh" ? "立即同步账号" : lang === "zh-hant" ? "立即同步帳號" : "Sync accounts now";
}

export function resolveOverviewRefreshMode(encryptedSyncEnabled: boolean): "sync" | "quota" {
  return encryptedSyncEnabled ? "sync" : "quota";
}

export function resolveOverviewToolbarActionCount(
  _hasAccounts: boolean,
  _hasActiveAccount: boolean,
  _rescueOverrideEnabled: boolean
): number {
  return 4;
}

export function resolveOverviewToolbarLabel(
  action: "add" | "import" | "sync" | "setup" | "refresh" | "lock" | "more" | "disableRescue",
  lang: DashboardState["lang"]
): string {
  const values = {
    en: {
      add: "Add",
      import: "Import",
      sync: "Sync",
      setup: "Set Up",
      refresh: "Refresh",
      lock: "Lock",
      more: "More",
      disableRescue: "Rescue"
    },
    zh: {
      add: "添加",
      import: "导入",
      sync: "同步",
      setup: "设置",
      refresh: "刷新",
      lock: "锁定",
      more: "更多",
      disableRescue: "关闭救援"
    },
    "zh-hant": {
      add: "新增",
      import: "匯入",
      sync: "同步",
      setup: "設定",
      refresh: "重新整理",
      lock: "鎖定",
      more: "更多",
      disableRescue: "關閉救援"
    }
  } as const;
  const locale = lang === "zh" || lang === "zh-hant" ? lang : "en";
  return values[locale][action];
}

export function resolveResetCreditBadgeLabel(lang: DashboardState["lang"]): string {
  if (lang === "zh") return "重置";
  if (lang === "zh-hant") return "重設";
  return "Reset";
}

function resolveOverviewMenuLabel(
  action:
    | "switch"
    | "reload"
    | "unload"
    | "enableAll"
    | "disableAll"
    | "quota"
    | "rescue"
    | "rescueOff"
    | "lock"
    | "unlock"
    | "onboard",
  lang: DashboardState["lang"]
): string {
  const values = {
    en: {
      switch: "Switch",
      reload: "Reload",
      unload: "Unload",
      enableAll: "Enable All",
      disableAll: "Disable All",
      quota: "Quota",
      rescue: "Rescue",
      rescueOff: "Rescue off",
      lock: "Lock",
      unlock: "Unlock",
      onboard: "Onboard"
    },
    zh: {
      switch: "切换",
      reload: "重载",
      unload: "卸载登录",
      enableAll: "启用全部",
      disableAll: "全部禁用",
      quota: "配额",
      rescue: "救援",
      rescueOff: "关闭救援",
      lock: "锁定",
      unlock: "解锁",
      onboard: "引导设置"
    },
    "zh-hant": {
      switch: "切換",
      reload: "重載",
      unload: "卸載登入",
      enableAll: "啟用全部",
      disableAll: "全部停用",
      quota: "配額",
      rescue: "救援",
      rescueOff: "關閉救援",
      lock: "鎖定",
      unlock: "解鎖",
      onboard: "導覽設定"
    }
  } as const;
  return values[lang === "zh" || lang === "zh-hant" ? lang : "en"][action];
}

function resolveOverviewEnableAllHint(lang: DashboardState["lang"]): string {
  if (lang === "zh") return "仅启用仍有有效凭据且不需要重新授权的账户";
  if (lang === "zh-hant") return "僅啟用仍有有效憑證且不需要重新授權的帳戶";
  return "Enable accounts with valid credentials that do not require reauthorization.";
}

function formatCompactDate(timestamp: number | undefined, lang: DashboardState["lang"], fallback: string): string {
  if (timestamp == null) return fallback;
  return new Date(timestamp).toLocaleDateString(lang === "zh" ? "zh-CN" : lang === "zh-hant" ? "zh-TW" : undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function formatResetCreditsTitle(account: DashboardAccountViewModel, copy: DashboardCopy): string {
  const count = account.resetCreditsAvailable ?? 0;
  const base = `${copy.resetCreditsBtn}: ${count}`;
  return account.resetCreditsNextExpiresAt
    ? `${base} · ${formatTimestamp(account.resetCreditsNextExpiresAt * 1000, copy.never)}`
    : base;
}

function resolveOverviewLabel(
  key: "subscription" | "workspace" | "session" | "login",
  lang: DashboardState["lang"]
): string {
  if (key === "session") return lang === "zh" ? "时长" : lang === "zh-hant" ? "時長" : "Duration";
  if (key === "login") return lang === "zh" ? "登录日期" : lang === "zh-hant" ? "登入日期" : "Login date";
  if (key === "subscription") {
    if (lang === "zh") {
      return "订阅到期";
    }
    if (lang === "zh-hant") {
      return "訂閱到期";
    }
    return "Subscription";
  }

  if (lang === "zh") {
    return "工作空间";
  }
  if (lang === "zh-hant") {
    return "工作空間";
  }
  return "Workspace";
}
