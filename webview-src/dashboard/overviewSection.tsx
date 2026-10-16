import type { useTokenHistoryRefresh } from "./tokenHistoryRefresh";
import { createPortal } from "preact/compat";
import type { ComponentChildren } from "preact";
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
import type { CodexDailyUsageBreakdown } from "../../src/core/types";
import type { DashboardUsageSample } from "../../src/domain/dashboard/types";
import { formatRelativeTimestamp, formatTimestamp, getSensitiveDisplayValue, resolveLockMinutes } from "./helpers";
import { formatAccountUsageDuration } from "../../src/utils/accountUsage";
import { ActionButton } from "./primitives";
import { MetricGauge } from "./accountMetricPrimitives";
import { AccountAccessIcon, renderRefreshIcon, ResetCreditIcon } from "./icons";

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
  onSetPassword: () => void;
  passwordConfigured?: boolean;
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
      if (rect) setMorePopoverPosition(resolveOverviewPopoverPosition(rect, window.innerWidth));
    }
    setMoreOpen((open) => !open);
  };
  useEffect(() => {
    if (!moreOpen) return;
    const updatePosition = (): void => {
      const rect = moreRef.current?.getBoundingClientRect();
      if (rect) setMorePopoverPosition(resolveOverviewPopoverPosition(rect, window.innerWidth));
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
              automaticTokenHistory={props.settings.dailyTokenUsageEnabled !== false}
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
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMoreOpen(false);
                              props.onSetPassword();
                            }}
                          >
                            🔑 {resolveOverviewMenuLabel("setPassword", props.lang, props.passwordConfigured === true)}
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
                          {providedAccount && props.showCliSessions && props.onOpenCliSessions ? (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMoreOpen(false);
                                props.onOpenCliSessions!();
                              }}
                            >
                              ◉ Sessions
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
  viewportWidth: number
): { top: number; right: number } {
  return {
    top: triggerRect.bottom + 5,
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
type UsageGraphRange = "1h" | "3h" | "6h" | "24h" | "7d" | "30d";
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
const USAGE_COMPACT_NUMBER = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
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
  const left = Math.max(8, Math.min(viewportWidth - width - 8, (anchor.left + anchor.right - width) / 2));
  const above = anchor.top - height - 10;
  const top = above >= 8 ? above : Math.max(8, Math.min(viewportHeight - height - 8, anchor.bottom + 10));
  return { left, top };
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
  const [range, setRange] = useState<UsageGraphRange>("1h");
  const [windowOffset, setWindowOffset] = useState(0);
  const [graphMode, setGraphMode] = useState<"quota" | "tokens">("quota");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [hovered, setHovered] = useState<{ bar: UsageGraphBar; anchor: UsageGraphAnchor }>();
  const tooltipId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    if (!settingsOpen) { setMenuPosition(undefined); return; }
    const menu = menuRef.current?.getBoundingClientRect();
    const anchor = menuButtonRef.current?.getBoundingClientRect();
    if (menu && anchor) {
      const position = positionUsageGraphTooltip(anchor, menu.width, menu.height, window.innerWidth, window.innerHeight);
      const left = Math.max(8, Math.min(window.innerWidth - menu.width - 8, anchor.right - menu.width));
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
  const availableRanges = graphMode === "tokens" ? USAGE_GRAPH_RANGES.filter(candidate => candidate.key.endsWith("d")) : USAGE_GRAPH_RANGES;
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
  const refreshErrors = Object.entries(props.tokenHistoryRefresh?.statuses ?? {}).filter(([, status]) => status.state === "error");
  const maximum = resolveUsageAxisMaximum(Math.max(0, ...events.map(event => event.used)));
  const bars = useMemo(() => layoutUsageGraphBars(events, graphStartAt, graphEndAt, bucketCount, maximum), [events, graphStartAt, graphEndAt, bucketCount, maximum]);
  const accountIds = new Set(events.map(event => event.accountId));
  const legend = props.accounts.filter(account => !accountIds.size || accountIds.has(account.id));
  const total = events.reduce((sum, event) => sum + event.used, 0);
  const staleCount = dailyUsageCache.filter(entry => props.now - entry.fetchedAt >= 86_400_000).length;
  const missingCount = Math.max(0, props.accounts.length - dailyUsageCache.length);
  const pending = props.usageGraphPending || (graphMode === "tokens" && props.dailyUsagePending);
  const error = props.usageGraphError ?? (graphMode === "tokens" ? props.dailyUsageError : undefined);
  const previousPeriod = data && (data.from !== queryWindow.from || data.to !== queryWindow.to);
  const feedback = error ?? (data?.truncated ? "Only the latest 10,000 records are shown. Choose a shorter range for complete detail." : pending ? "Updating saved usage…" : undefined);
  const status = pending ? "Updating" : error ? "Failed" : data?.truncated ? "Limited" : graphMode === "tokens"
    ? !dailyUsageCache.length ? "No data" : missingCount ? "Partial" : staleCount ? "Stale" : "Saved" : undefined;
  const statusDetail = error ?? (data?.truncated ? feedback : graphMode === "tokens"
    ? `${dailyUsageCache.length} of ${props.accounts.length} accounts saved${staleCount ? ` · ${staleCount} stale` : ""}. ${props.automaticTokenHistory ? "Checked on account load, at most once per 24 hours." : "Automatic token history is off."}`
    : "Changes in each account's quota. Timing is estimated between refreshes.");
  const formatAxis = (value: number) => graphMode === "tokens" ? USAGE_COMPACT_NUMBER.format(value) : formatUsageValue(value);
  const showBar = (bar: UsageGraphBar, target: SVGRectElement): void => {
    setSettingsOpen(false);
    setHovered({ bar, anchor: target.getBoundingClientRect() });
  };
  useEffect(() => { setHovered(undefined); }, [data, graphMode, props.usageGraphSource]);
  useEffect(() => {
    if (!settingsOpen && !hovered) return;
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !cardRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) { setSettingsOpen(false); setHovered(undefined); }
    };
    const hideTooltip = (event: Event): void => {
      setHovered(undefined);
      if (!(event.target instanceof Node && menuRef.current?.contains(event.target))) setSettingsOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { if (settingsOpen) menuButtonRef.current?.focus(); setSettingsOpen(false); setHovered(undefined); }
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
  }, [settingsOpen, Boolean(hovered)]);
  const bucketTotal = hovered ? bars.filter(bar => bar.bucketStart === hovered.bar.bucketStart).reduce((sum, bar) => sum + bar.event.used, 0) : 0;
  return (
    <div class="usage-graph-card" ref={cardRef} data-mode={graphMode} aria-label={graphMode === "tokens" ? "Daily token usage chart" : "Quota usage chart"}>
      <div class="usage-graph-head">
        <div class="usage-graph-title">
          <strong>{graphMode === "tokens" ? "Tokens" : "Quota"}</strong>
          <span class="usage-graph-summary" title={graphMode === "tokens" ? `${USAGE_EXACT_NUMBER.format(total)} tokens in this period` : "Accounts with quota changes in this period"}>
            {graphMode === "tokens" ? `${USAGE_COMPACT_NUMBER.format(total)} total` : `${accountIds.size} ${accountIds.size === 1 ? "account" : "accounts"}`}
          </span>
          <span class="usage-graph-color-key" aria-label="Account color key">
            {legend.slice(0, USAGE_GRAPH_MAX_COLOR_KEYS).map(account => {
              const entry = accountMap.get(account.id)!;
              return <i key={account.id} class="usage-graph-color-chip" style={{ background: entry.color }} role="img" aria-label={entry.label} title={entry.label} />;
            })}
            {legend.length > USAGE_GRAPH_MAX_COLOR_KEYS ? <small>+{legend.length - USAGE_GRAPH_MAX_COLOR_KEYS}</small> : null}
          </span>
        </div>
        <div class="usage-graph-controls">
          {status ? <button type="button" class="usage-graph-status" data-warning={Boolean(error || data?.truncated || staleCount || missingCount)} title={statusDetail} aria-label={`Usage data: ${status}. ${statusDetail ?? ""}`} onClick={() => { setHovered(undefined); setSettingsOpen(open => !open); }}>{status}</button> : null}
          <div class="usage-graph-ranges">
            <select value={activeRange} aria-label="Graph time range" onChange={event => { setRange(event.currentTarget.value as UsageGraphRange); setWindowOffset(0); }}>
              {availableRanges.map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
            </select>
          </div>
          <div class="usage-graph-settings-wrap">
            <button ref={menuButtonRef} type="button" class={settingsOpen ? "active" : ""} aria-label="Graph settings" aria-expanded={settingsOpen} title="Graph settings" onClick={() => { setHovered(undefined); setSettingsOpen(open => !open); }}>⚙</button>
            {settingsOpen ? createPortal(<div ref={menuRef} class="usage-graph-settings-popover" role="dialog" aria-label="Graph settings" style={{ left: menuPosition?.left ?? 8, top: menuPosition?.top ?? 8, visibility: menuPosition ? "visible" : "hidden" }}>
              <strong>Chart data</strong>
              <button type="button" class={graphMode === "quota" ? "active" : ""} aria-pressed={graphMode === "quota"} onClick={() => { setGraphMode("quota"); setRange("1h"); setWindowOffset(0); setSettingsOpen(false); }}>Quota changes</button>
              <button type="button" class={graphMode === "tokens" ? "active" : ""} aria-pressed={graphMode === "tokens"} onClick={() => { setGraphMode("tokens"); setRange("30d"); setWindowOffset(0); setSettingsOpen(false); }}>Daily token usage</button>
              <p class="usage-graph-details-note">{graphMode === "tokens" ? `Saved daily totals across accounts · UTC. ${props.automaticTokenHistory ? "Checked on account load, at most once every 24 hours." : "Automatic collection is off. Enable Automatic token history in Settings to collect usage."}` : "Quota used by each account in the selected period. Timing is estimated between quota checks."}</p>
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
                      {graphMode === "tokens" ? stateLabel ?? (entry ? `${props.now - entry.fetchedAt >= 86_400_000 ? "Stale · " : ""}${age}` : "Not collected") : `${formatUsageValue(usageByAccount.get(account.id) ?? 0)} · ${age}`}
                    </small>
                    {graphMode === "tokens" ? <button class="usage-graph-account-refresh" type="button" disabled={pending} aria-busy={pending} aria-label={`Refresh token history for ${accountMap.get(account.id)?.label}`} title="Refresh this account's token history" onClick={() => props.tokenHistoryRefresh?.refresh([account.id])}>{renderRefreshIcon()}</button> : null}
                  </div>;
                })}
              </div>
              {graphMode === "tokens" && refreshErrors.length ? <div class="usage-graph-settings-error" role="alert">{refreshErrors.map(([id, status]) => `${accountMap.get(id)?.label ?? "Account"}: ${status.message}`).join("\n")}</div> : null}
              {error ? <span class="usage-graph-settings-error">{error}</span> : null}
            </div>, document.body) : null}
          </div>
          <div class="usage-graph-navigation">
            <button type="button" disabled={typeof data?.oldestAt !== "number" || !Number.isFinite(data.oldestAt) || data.oldestAt >= graphStartAt} title="Older period" aria-label="Older period" onClick={() => setWindowOffset(current => current + 1)}>‹</button>
            <button type="button" disabled={windowOffset === 0} title="Newer period" aria-label="Newer period" onClick={() => setWindowOffset(current => Math.max(0, current - 1))}>›</button>
          </div>
        </div>
      </div>
      <div class="usage-graph-stage" ref={graphStageRef} onMouseLeave={() => setHovered(undefined)}>
        <div class="usage-graph-axis" aria-hidden="true">
          {[maximum, maximum / 2, 0].map((value, index) => <span key={index} style={{ top: `${([10, 31, 52][index]! / USAGE_GRAPH_VIEWBOX_HEIGHT) * 100}%` }}>{formatAxis(value)}</span>)}
        </div>
        <div class="usage-graph-scroll">
          <div class="usage-graph-scroll-content">
            <svg class="usage-graph" viewBox={`0 0 100 ${USAGE_GRAPH_VIEWBOX_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={graphMode === "tokens" ? "Daily token usage for all saved accounts" : "Quota used by account"}>
              {[10, 31, 52].map(y => <line key={y} x1="0" y1={y} x2="100" y2={y} class="usage-graph-gridline" />)}
              {hovered ? <rect class="usage-graph-cursor" x={((hovered.bar.bucketStart - graphStartAt) / duration) * 100} y="4" width={100 / bucketCount} height="48" /> : null}
              {bars.map((bar, index) => {
                const account = accountMap.get(bar.event.accountId) ?? { label: "Unknown account", color: "#8b949e" };
                const selected = hovered?.bar === bar;
                const label = `${account.label}: ${USAGE_EXACT_NUMBER.format(bar.event.used)} ${graphMode === "tokens" ? "tokens" : "percent quota used"}, ${formatGraphTime(bar.event.at, props.lang, graphMode === "tokens" || displayedRange.endsWith("d") ? "date" : "time")}`;
                return <g key={`${bar.event.accountId}:${bar.bucketStart}`}>
                  <rect class={`usage-graph-bar${selected ? " is-active" : ""}`} x={bar.x} y={USAGE_GRAPH_BASELINE - bar.height} width={bar.width} height={bar.height} rx={Math.min(bar.width * 0.2, 0.3)} fill={account.color} />
                  <rect class="usage-graph-bar-hitarea" x={Math.max(0, bar.x - bar.width * 0.18)} y="4" width={bar.width * 1.36} height="48" fill="transparent" role="img" tabIndex={index === Math.min(focusedIndex, bars.length - 1) ? 0 : -1} aria-label={label} aria-describedby={selected ? tooltipId : undefined}
                    onMouseEnter={event => showBar(bar, event.currentTarget)}
                    onFocus={event => { setFocusedIndex(index); showBar(bar, event.currentTarget); }}
                    onBlur={() => setHovered(undefined)}
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
        {!events.length && !pending && !error ? <div class="usage-graph-empty"><strong>{graphMode === "tokens" ? "No saved tokens in this period" : "No quota changes yet"}</strong><span>{graphMode === "tokens" ? "Saved account totals appear here" : "Changes appear after quota refreshes"}</span></div> : null}
        {events.length > 0 && total === 0 ? <div class="usage-graph-empty"><strong>No token use recorded</strong><span>Saved daily total: 0 tokens</span></div> : null}
        {feedback ? <div class="usage-graph-feedback" data-warning={Boolean(error || data?.truncated)} role={error || data?.truncated ? "alert" : "status"}>
          <span title={feedback}>{feedback}{previousPeriod ? " Showing the previous period." : ""}</span>
          {props.usageGraphError ? <button type="button" disabled={props.usageGraphPending} aria-label="Retry saved graph" onClick={() => loadQueryRef.current?.(queryWindow)}>Retry</button> : null}
        </div> : null}
      </div>
      {hovered ? <UsageGraphTooltip id={tooltipId} bar={hovered.bar} anchor={hovered.anchor} account={accountMap.get(hovered.bar.event.accountId)} mode={graphMode} lang={props.lang} now={props.now} bucketTotal={bucketTotal} fetchedAt={dailyUsageCache.find(entry => entry.accountId === hovered.bar.event.accountId)?.fetchedAt} /> : null}
    </div>
  );
}

function UsageGraphTooltip(props: {
  id: string;
  bar: UsageGraphBar;
  anchor: UsageGraphAnchor;
  account?: { label: string; color: string; device?: string };
  mode: "quota" | "tokens";
  lang: DashboardState["lang"];
  now: number;
  bucketTotal: number;
  fetchedAt?: number;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const bounds = tooltipRef.current?.getBoundingClientRect();
    if (bounds) setPosition(positionUsageGraphTooltip(props.anchor, bounds.width, bounds.height, window.innerWidth, window.innerHeight));
  }, [props.anchor, props.bar, props.account?.label]);
  const tokens = props.mode === "tokens";
  const date = new Intl.DateTimeFormat(props.lang === "zh" ? "zh-CN" : props.lang === "zh-hant" ? "zh-TW" : "en", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    ...(tokens ? { timeZone: "UTC" } : { hour: "2-digit", minute: "2-digit" })
  }).format(props.bar.event.at);
  const segments = summarizeUsageSegments(props.bar.event.segments ?? []);
  const today = tokens && Math.floor(props.bar.event.at / 86_400_000) === Math.floor(props.now / 86_400_000);
  return createPortal(<div id={props.id} ref={tooltipRef} class="usage-graph-tooltip" role="tooltip" style={{ left: position?.left ?? 8, top: position?.top ?? 8, visibility: position ? "visible" : "hidden" }}>
    <time dateTime={new Date(props.bar.event.at).toISOString()}>{date}</time>
    <div class="usage-graph-tooltip-account"><i style={{ background: props.account?.color ?? "#8b949e" }} /><strong>{props.account?.label ?? "Unknown account"}</strong></div>
    <div class="usage-graph-tooltip-value"><strong>{tokens ? USAGE_EXACT_NUMBER.format(props.bar.event.used) : formatUsageValue(props.bar.event.used)}</strong><span>{tokens ? "tokens" : "quota used"}</span></div>
    {tokens && segments.length ? <div class="usage-graph-tooltip-breakdown" aria-label="Token breakdown">{segments.map(segment => <div key={segment.key}><span>{segment.key}</span><strong>{USAGE_EXACT_NUMBER.format(segment.used)}</strong></div>)}</div> : null}
    {tokens && props.bucketTotal > props.bar.event.used ? <div class="usage-graph-tooltip-combined"><span>All accounts this day</span><strong>{USAGE_EXACT_NUMBER.format(props.bucketTotal)} tokens</strong></div> : null}
    <div class="usage-graph-tooltip-meta">
      <span>{tokens ? today ? "Today so far · UTC" : "Saved daily total · UTC" : "Estimated between quota checks"}</span>
      {tokens && props.fetchedAt ? <span data-stale={props.now - props.fetchedAt >= 86_400_000}>Updated {formatRelativeTimestamp(props.fetchedAt, props.now, "Unknown", props.lang)}{props.now - props.fetchedAt >= 86_400_000 ? " · Stale" : ""}</span> : null}
      {props.account?.device ? <span>{props.account.device}</span> : null}
    </div>
  </div>, document.body);
}

export function buildDailyTokenUsageEvents(entries: readonly DashboardDailyUsageCacheEntry[]): UsageEvent[] {
  const points = new Map<string, UsageEvent>();
  for (const entry of [...entries].sort((a, b) => a.fetchedAt - b.fetchedAt)) for (const point of entry.usage.points) {
    const at = Date.parse(`${point.date}T00:00:00Z`);
    if (Number.isFinite(at) && Number.isFinite(point.totalTokens) && point.totalTokens >= 0) {
      points.set(`${entry.accountId}:${point.date}`, { at, accountId: entry.accountId, used: point.totalTokens, segments: buildDailyUsageSegments(point) });
    }
  }
  return [...points.values()].sort((a, b) => a.at - b.at);
}

function buildDailyUsageSegments(point: CodexDailyUsageBreakdown["points"][number]): UsageSegment[] {
  const surfaceEntries = Object.entries(point.surfaceValues ?? {})
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([key, value], index) => ({
      key: formatUsageSurfaceLabel(key),
      used: value,
      color: USAGE_GRAPH_COLORS[index % USAGE_GRAPH_COLORS.length] ?? "#58a6ff"
    }));
  if (surfaceEntries.length) return surfaceEntries;
  const fallback = [
    ["Input", point.inputTokens],
    ["Output", point.outputTokens],
    ["Cached", point.cachedTokens]
  ] as Array<[string, number | undefined]>;
  const segments = fallback
    .filter(([, value]) => typeof value === "number" && value > 0)
    .map(([key, value], index) => ({
      key,
      used: value as number,
      color: USAGE_GRAPH_COLORS[index % USAGE_GRAPH_COLORS.length] ?? "#58a6ff"
    }));
  return segments.length
    ? segments
    : [{ key: "Total", used: point.totalTokens, color: USAGE_GRAPH_COLORS[0] ?? "#58a6ff" }];
}

function formatUsageSurfaceLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "vscode" || normalized === "vs_code" || normalized === "visual_studio_code")
    return "Visual Studio Code";
  if (normalized === "work" || normalized === "chatgpt") return normalized === "work" ? "Work" : "ChatGPT";
  if (normalized === "codex" || normalized === "cli") return "Codex CLI";
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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
    | "setPassword"
    | "onboard",
  lang: DashboardState["lang"],
  passwordConfigured = false
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
      setPassword: passwordConfigured ? "Change Password" : "Set Password",
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
      setPassword: passwordConfigured ? "更改密码" : "设置密码",
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
      setPassword: passwordConfigured ? "變更密碼" : "設定密碼",
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
