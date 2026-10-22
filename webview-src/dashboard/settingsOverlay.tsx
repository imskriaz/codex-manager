import type {
  DashboardCopy,
  DashboardSettingKey,
  DashboardSettings,
  DashboardState
} from "../../src/domain/dashboard/types";
import { useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import {
  SettingsDiscreteSlider,
  SettingsLanguageBlock,
  SettingsPathBlock,
  SettingsThemeBlock,
  SettingsThresholdBlock,
  SettingsToggleBlock
} from "./components";
import { formatTemplate } from "./helpers";
import { renderRemoveIcon } from "./icons";
import { handleTabKeyDown, useModalAccessibility } from "./primitives";
import { resolveLongQuotaSettingsLabel } from "../../src/utils/quotaLabels";

import { BrowserNotifications } from "./browserNotifications";
import { MaintenanceTools } from "./maintenanceTools";
import type { SendAction } from "./hookTypes";

const AUTO_REFRESH_VALUES = Array.from({ length: 56 }, (_, index) => index + 5);
const AUTO_REFRESH_SCALE_VALUES = [5, 15, 30, 45, 60];
const CURRENT_AUTO_REFRESH_VALUES = Array.from({ length: 60 }, (_, index) => index + 1);
const CURRENT_AUTO_REFRESH_SCALE_VALUES = [1, 15, 30, 45, 60];
const TOKEN_HISTORY_GAP_VALUES = Array.from({ length: 1440 }, (_, index) => index + 1);
const AUTO_SWITCH_VALUES = Array.from({ length: 21 }, (_, index) => index);
const AUTO_RESET_VALUES = Array.from({ length: 101 }, (_, index) => index);
// Warning thresholds are intentionally available at every percentage point.
// The native range input already moves in single-point steps; keeping the
// backing values equally granular prevents the nearest-value mapper from
// snapping a user's selection back to a 5% increment.
const WARNING_VALUES = Array.from({ length: 91 }, (_, index) => index);
const WARNING_SCALE_VALUES = [0, 20, 40, 60, 80, 90];
const WEEKLY_WARNING_VALUES = WARNING_VALUES;
const WEEKLY_WARNING_SCALE_VALUES = WARNING_SCALE_VALUES;
type SettingsTabId = "general" | "automation" | "data" | "tools";

export function shouldPatchDashboardSettingOptimistically(key: DashboardSettingKey): boolean {
  // CLI discovery starts after the host commits the setting.
  return key !== "cliIntegrationEnabled" && key !== "persistentLoggingEnabled" && key !== "persistentLogRetentionDays" && key !== "persistentLogLevel";
}

export function SettingsOverlay(props: {
  open: boolean;
  connected?: boolean;
  targetConnected?: boolean;
  copy: DashboardCopy;
  lang: DashboardState["lang"];
  settings: DashboardSettings;
  tokenAutomation: DashboardState["tokenAutomation"];
  encryptedSyncNeedsConfiguration: boolean;
  encryptedSyncNeedsSettingsSync: boolean;
  usageHistoryCount: number;
  onClose: () => void;
  onPatchSettings: (patch: Partial<DashboardSettings>) => void;
  onSendSetting: (key: DashboardSettingKey, value: string | number | boolean) => void;
  onAutoRefreshToggle: (enabled: boolean) => void;
  onAutoRefreshValue: (minutes: number) => void;
  onAutoRefreshCurrentToggle: (enabled: boolean) => void;
  onAutoRefreshCurrentValue: (minutes: number) => void;
  onThresholdPreview: (key: "yellow" | "green", value: number) => void;
  onThresholdCommit: (key: "yellow" | "green", value: number) => void;
  onPickCodexAppPath: () => void;
  onClearCodexAppPath: () => void;
  onClearUsageHistory: () => void;
  onExportBackup: () => void;
  onShowLogs: () => void;
  onImportBackup: () => void;
  onConfigureSync: () => void;
  onSyncNow: () => void;
  syncPending: boolean;
  onSetCrossPcSyncEnabled: (enabled: boolean) => void;
  crossPcSyncPending: boolean;
  onSetRegistryOverride: (enabled: boolean) => void;
  registryOverridePending: boolean;
  sendAction: SendAction;
  targetDeviceId?: string;
  targetName: string;
}) {
  const longQuotaLabel = resolveLongQuotaSettingsLabel(props.lang, props.copy.weeklyLabel);
  const safeCurrentRefreshMinutes =
    props.settings.autoRefreshCurrentMinutes > 0 ? Math.max(1, props.settings.autoRefreshCurrentMinutes) : 0;
  const safeAllRefreshMinutes =
    props.settings.autoRefreshMinutes > 0 ? Math.max(5, props.settings.autoRefreshMinutes) : 0;
  const accessibility = useModalAccessibility(props.open, props.onClose);
  const [activeTab, setActiveTab] = useState<SettingsTabId>("general");
  const patchAndSend = (key: DashboardSettingKey, value: string | number | boolean) => {
    if (shouldPatchDashboardSettingOptimistically(key)) {
      props.onPatchSettings({ [key]: value });
    }
    props.onSendSetting(key, value);
  };
  const usageHistoryCopy = resolveUsageHistoryCopy(props.lang, props.usageHistoryCount);
  const transferCopy = resolveTransferCopy(props.lang);
  const passwordCopy = resolvePasswordCopy(props.lang, !props.encryptedSyncNeedsConfiguration);
  const navigationCopy = resolveSettingsNavigationCopy(props.lang);
  const tabs = [...navigationCopy.tabs, { id: "tools" as const, label: "Tools", heading: "System tools", description: "Cleanup, diagnostics, and recovery." }];
  const [logRetentionPreview, setLogRetentionPreview] = useState<number>();

  return createPortal(
    <div class={`overlay ${props.open ? "open" : ""}`} aria-hidden={!props.open} onPointerDown={accessibility.onBackdropPointerDown} onMouseDown={accessibility.onBackdropMouseDown} onClick={accessibility.onBackdropClick}>
      <div
        ref={accessibility.modalRef}
        class="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        tabIndex={-1}
        onKeyDown={accessibility.onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div class="settings-modal-head">
          <div class="settings-modal-heading">
            <div class="settings-modal-kicker">{navigationCopy.kicker}</div>
            <div class="settings-modal-title" id="settings-modal-title">
              {props.copy.settingsTitle}
            </div>
          </div>
          <button class="settings-close" type="button" aria-label={props.copy.closeModal} onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="settings-tab-list" role="tablist" onKeyDown={handleTabKeyDown} aria-label={navigationCopy.tabListLabel}>
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              id={`settings-tab-${tab.id}`}
              class={`settings-tab ${activeTab === tab.id ? "active" : ""}`}
              type="button"
              role="tab"
              aria-label={tab.label}
              title={tab.label}
              aria-selected={activeTab === tab.id}
              aria-controls={`settings-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => {
                const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                const nextIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : direction
                        ? (index + direction + tabs.length) % tabs.length
                        : index;
                if (nextIndex === index && event.key !== "Home" && event.key !== "End") {
                  return;
                }
                event.preventDefault();
                const nextTab = tabs[nextIndex]!;
                setActiveTab(nextTab.id);
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>(`#settings-tab-${nextTab.id}`)
                  ?.focus();
              }}
            >
              <SettingsTabIcon tab={tab.id} />
              <span class="settings-tab-copy">
                <span class="settings-tab-label">{tab.label}</span>
                <span class="settings-tab-description">{tab.description}</span>
              </span>
            </button>
          ))}
        </div>
        <div class="settings-modal-body">
          {document.documentElement.dataset["dashboardHost"] === "browser" && <BrowserNotifications />}
          <fieldset class="settings-offline-fieldset" disabled={props.connected === false}>
          <div
            class="settings-tab-panel"
            id="settings-panel-general"
            role="tabpanel"
            aria-labelledby="settings-tab-general"
            hidden={activeTab !== "general"}
          >
            <SettingsPanelIntro tab={tabs[0]!} />
            <div class="settings-layout">
              <SettingsThemeBlock
                lang={props.lang}
                settings={props.settings}
                onChange={(value) => {
                  props.onPatchSettings({ dashboardTheme: value });
                  props.onSendSetting("dashboardTheme", value);
                }}
              />
              <SettingsLanguageBlock
                copy={props.copy}
                settings={props.settings}
                onChange={(value) => {
                  props.onPatchSettings({ displayLanguage: value });
                  props.onSendSetting("displayLanguage", value);
                }}
              />
              <div class={`settings-block settings-block-wide ${props.encryptedSyncNeedsConfiguration ? "settings-password-required" : ""}`} data-setting="shared-password">
                <div class="settings-block-head">
                  <div class="settings-block-title">{passwordCopy.title}</div>
                  <div class="settings-block-sub" title={passwordCopy.sub}>{passwordCopy.sub}</div>
                </div>
                {props.encryptedSyncNeedsConfiguration ? (
                  <div class="settings-note settings-notice-warning">{passwordCopy.needsConfiguration}</div>
                ) : null}
                <div class="settings-note">{passwordCopy.note}</div>
                <div class="settings-actions">
                  <button class="settings-action-btn" type="button" onClick={props.onConfigureSync}>
                    {passwordCopy.configure}
                  </button>
                </div>
              </div>
              <div class="settings-block settings-block-wide settings-integration-group">
                <div class="settings-block-head settings-integration-head">
                  <div class="settings-block-title">
                    {props.lang === "zh" ? "面板" : props.lang === "zh-hant" ? "面板" : "Dashboard"}
                  </div>
                  <div class="settings-block-sub">
                    {props.lang === "zh"
                      ? "配置浏览器访问、在线主机和公共域名。"
                      : props.lang === "zh-hant"
                        ? "設定瀏覽器存取、線上主機與公開網域。"
                        : "Browser access and connections."}
                  </div>
                </div>
                <SettingsToggleBlock
                  title={
                    props.lang === "zh" ? "浏览器面板" : props.lang === "zh-hant" ? "瀏覽器面板" : "Web Dashboard"
                  }
                  sub={
                      props.lang === "zh"
                        ? "在 127.0.0.1:39875 启动浏览器面板。本机访问无需密码；远程登录使用加密同步密码短语。"
                        : props.lang === "zh-hant"
                          ? "在 127.0.0.1:39875 啟動瀏覽器面板。本機存取無需密碼；遠端登入使用加密同步密碼。"
                          : "Open in a browser; remote access needs a password."
                  }
                  enabled={props.settings.webDashboardEnabled}
                  onToggle={(enabled) => patchAndSend("webDashboardEnabled", enabled)}
                >
                  <div class="settings-note">
                    {props.settings.webDashboardEnabled
                      ? props.lang === "zh"
                        ? "已启用。点击顶部面板按钮可在浏览器中打开。"
                        : props.lang === "zh-hant"
                          ? "已啟用。點擊頂部面板按鈕可在瀏覽器中開啟。"
                          : "Open it with the dashboard button above."
                      : props.lang === "zh"
                        ? "已停用。"
                        : props.lang === "zh-hant"
                          ? "已停用。"
                          : "Disabled."}
                  </div>
                  <div class="settings-integration-grid">
                    <SettingsToggleBlock
                      title={
                        props.lang === "zh"
                          ? "启用工作区（实验性）"
                          : props.lang === "zh-hant"
                            ? "啟用工作區（實驗性）"
                            : "Enable workspace (Experimental)"
                      }
                      sub={
                        props.lang === "zh"
                          ? "默认停用。启用后可在面板中打开工作区、会话和终端工具。"
                          : props.lang === "zh-hant"
                            ? "預設停用。啟用後可在面板中開啟工作區、工作階段與終端工具。"
                            : "Add chats and terminals to this dashboard."
                      }
                      enabled={props.settings.cliIntegrationEnabled === true}
                      onToggle={(enabled) => patchAndSend("cliIntegrationEnabled", enabled)}
                    >
                      <div class="settings-note">
                        {props.settings.cliIntegrationEnabled
                          ? props.lang === "zh"
                            ? "已启用。面板顶部会显示工作区入口。"
                            : props.lang === "zh-hant"
                              ? "已啟用。面板頂部會顯示工作區入口。"
                              : "Workspace is available above."
                          : props.lang === "zh"
                            ? "已停用。工作区入口和会话读取均关闭。"
                            : props.lang === "zh-hant"
                              ? "已停用。工作區入口與工作階段讀取均關閉。"
                              : "Workspace is off."}
                      </div>
                    </SettingsToggleBlock>
                  <SettingsToggleBlock
                    title="WS Cross System"
                    className="settings-dashboard-server"
                    sub="Connect your systems through a shared server."
                    enabled={props.settings.webSocketServerEnabled !== false}
                    onToggle={(enabled) => patchAndSend("webSocketServerEnabled", enabled)}
                  >
                  <div class={`settings-stack ${props.settings.webSocketServerEnabled === false ? "is-hidden" : ""}`}>
                    <input
                      class="settings-text-input"
                      type="text"
                      name="cloudflared-domain"
                      aria-label="Cloudflared domain"
                      autoComplete="url"
                      spellcheck={false}
                      value={props.settings.cloudflaredDomain ?? ""}
                      placeholder="codex.example.com"
                      onInput={(event) => props.onPatchSettings({ cloudflaredDomain: event.currentTarget.value })}
                      onBlur={(event) => props.onSendSetting("cloudflaredDomain", event.currentTarget.value.trim())}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }
                      }}
                    />
                    <div class="settings-note">
                      {props.lang === "zh"
                        ? "简要设置：cloudflared tunnel --url http://127.0.0.1:39875；先设置面板密码，再把此 HTTPS 域名分享给其他电脑。"
                        : props.lang === "zh-hant"
                          ? "簡要設定：cloudflared tunnel --url http://127.0.0.1:39875；先設定面板密碼，再將此 HTTPS 網域分享給其他電腦。"
                          : "Set a password before sharing this dashboard."}
                    </div>
                  </div>
                  </SettingsToggleBlock>
                </div>
                </SettingsToggleBlock>
              </div>
              <SettingsToggleBlock
                title={props.copy.codexAppRestartTitle}
                sub={props.copy.codexAppRestartSub}
                enabled={props.settings.codexAppRestartEnabled}
                onToggle={(enabled) => patchAndSend("codexAppRestartEnabled", enabled)}
              >
                <div class={`settings-stack ${props.settings.codexAppRestartEnabled ? "" : "is-hidden"}`}>
                  <div class="settings-segment">
                    <button
                      class={`segment-btn ${props.settings.codexAppRestartMode === "auto" ? "active" : ""}`}
                      type="button"
                      onClick={() => patchAndSend("codexAppRestartMode", "auto")}
                    >
                      <span class="segment-title">{props.copy.restartModeAuto}</span>
                      <span class="segment-copy">{props.copy.restartModeAutoDesc}</span>
                    </button>
                    <button
                      class={`segment-btn ${props.settings.codexAppRestartMode === "manual" ? "active" : ""}`}
                      type="button"
                      onClick={() => patchAndSend("codexAppRestartMode", "manual")}
                    >
                      <span class="segment-title">{props.copy.restartModeManual}</span>
                      <span class="segment-copy">{props.copy.restartModeManualDesc}</span>
                    </button>
                  </div>
                  <div class="settings-note">{props.copy.restartModeNote}</div>
                  <SettingsPathBlock
                    copy={props.copy}
                    pathValue={props.settings.resolvedCodexAppPath}
                    hasCustomPath={Boolean(props.settings.codexAppPath)}
                    onPick={props.onPickCodexAppPath}
                    onClear={props.onClearCodexAppPath}
                  />
                </div>
              </SettingsToggleBlock>
                  <SettingsToggleBlock
                    title="Project task board"
                    sub="Show Idea, Planned, Running, and Completed project work with offline drafts."
                    enabled={props.settings.taskBoardEnabled !== false}
                    onToggle={(enabled) => patchAndSend("taskBoardEnabled", enabled)}
                  />
                  <SettingsToggleBlock
                    title="Dashboard API"
                    sub="Allow generated Bearer tokens to call the local dashboard API."
                    enabled={props.settings.apiAccessEnabled === true}
                    onToggle={(enabled) => patchAndSend("apiAccessEnabled", enabled)}
                  />
              <SettingsToggleBlock
                title={props.copy.crossWindowAccountModeTitle ?? "Parallel window accounts (Experimental)"}
                sub={
                  props.copy.crossWindowAccountModeSub ??
                  "Use a separate account in each VS Code window."
                }
                enabled={props.settings.crossWindowAccountModeEnabled === true}
                onToggle={(enabled) => patchAndSend("crossWindowAccountModeEnabled", enabled)}
              >
                <div class="settings-note">
                  {props.settings.crossWindowAccountModeEnabled
                    ? "Windows choose accounts independently."
                    : "Windows share the current account."}
                </div>
              </SettingsToggleBlock>
            </div>
          </div>
          <div
            class="settings-tab-panel"
            id="settings-panel-automation"
            role="tabpanel"
            aria-labelledby="settings-tab-automation"
            hidden={activeTab !== "automation"}
          >
            <SettingsPanelIntro tab={tabs[1]!} />
            <div class="settings-layout">
              <div class="settings-block settings-block-wide settings-refresh-group">
                <SettingsToggleBlock
                  title={props.copy.autoRefreshCurrentTitle}
                  sub={props.copy.autoRefreshCurrentSub}
                  enabled={safeCurrentRefreshMinutes > 0}
                  onToggle={props.onAutoRefreshCurrentToggle}
                >
                  <div class={`settings-stack ${safeCurrentRefreshMinutes > 0 ? "" : "is-hidden"}`}>
                    <SettingsDiscreteSlider
                      value={safeCurrentRefreshMinutes}
                      values={CURRENT_AUTO_REFRESH_VALUES}
                      accent="violet"
                      scaleValues={CURRENT_AUTO_REFRESH_SCALE_VALUES}
                      valueLabel={(value) => formatTemplate(props.copy.autoRefreshValueTemplate, value)}
                      description={(value) => formatTemplate(props.copy.autoRefreshCurrentValueDescTemplate, value)}
                      onPreview={(value) => props.onPatchSettings({ autoRefreshCurrentMinutes: value })}
                      onCommit={props.onAutoRefreshCurrentValue}
                    />
                  </div>
                </SettingsToggleBlock>
                <SettingsToggleBlock
                  title={props.copy.autoRefreshTitle}
                  sub={props.copy.autoRefreshSub}
                  enabled={safeAllRefreshMinutes > 0}
                  onToggle={props.onAutoRefreshToggle}
                >
                  <div class={`settings-stack ${safeAllRefreshMinutes > 0 ? "" : "is-hidden"}`}>
                    <SettingsDiscreteSlider
                      value={safeAllRefreshMinutes}
                      values={AUTO_REFRESH_VALUES}
                      accent="violet"
                      scaleValues={AUTO_REFRESH_SCALE_VALUES}
                      valueLabel={(value) => formatTemplate(props.copy.autoRefreshValueTemplate, value)}
                      description={(value) => formatTemplate(props.copy.autoRefreshValueDescTemplate, value)}
                      onPreview={(value) => props.onPatchSettings({ autoRefreshMinutes: value })}
                      onCommit={props.onAutoRefreshValue}
                    />
                  </div>
                </SettingsToggleBlock>
              </div>
              <SettingsToggleBlock
                title={props.copy.autoSwitchTitle}
                sub={props.copy.autoSwitchSub}
                enabled={props.settings.autoSwitchEnabled}
                className="settings-block-wide"
                onToggle={(enabled) => patchAndSend("autoSwitchEnabled", enabled)}
              >
                <div class={`settings-stack ${props.settings.autoSwitchEnabled ? "" : "is-hidden"}`}>
                  <SettingsDiscreteSlider
                    value={props.settings.autoSwitchHourlyThreshold}
                    values={AUTO_SWITCH_VALUES}
                    accent="violet"
                    sparseScale
                    valueLabel={(value) => `${value}%`}
                    description={(value) =>
                      formatTemplate(props.copy.autoSwitchThresholdDescTemplate, {
                        label: props.copy.hourlyLabel,
                        value
                      })
                    }
                    onPreview={(value) => props.onPatchSettings({ autoSwitchHourlyThreshold: value })}
                    onCommit={(value) => patchAndSend("autoSwitchHourlyThreshold", value)}
                  />
                  <SettingsDiscreteSlider
                    value={props.settings.autoSwitchWeeklyThreshold}
                    values={AUTO_SWITCH_VALUES}
                    accent="sky"
                    sparseScale
                    valueLabel={(value) => `${value}%`}
                    description={(value) =>
                      formatTemplate(props.copy.autoSwitchThresholdDescTemplate, {
                        label: longQuotaLabel,
                        value
                      })
                    }
                    onPreview={(value) => props.onPatchSettings({ autoSwitchWeeklyThreshold: value })}
                    onCommit={(value) => patchAndSend("autoSwitchWeeklyThreshold", value)}
                  />
                  <div class="settings-integration-grid settings-switch-options">
                    <SettingsToggleBlock
                      title={props.copy.autoResetTitle ?? "Automatic quota reset plan"}
                      sub={
                        props.copy.autoResetSub ??
                        "Use a reset credit when all accounts run out."
                      }
                      enabled={props.settings.autoResetEnabled === true}
                      onToggle={(enabled) => patchAndSend("autoResetEnabled", enabled)}
                    >
                      <div class={`settings-stack ${props.settings.autoResetEnabled ? "" : "is-hidden"}`}>
                        <SettingsDiscreteSlider
                          value={props.settings.autoResetWeeklyThreshold ?? 0}
                          values={AUTO_RESET_VALUES}
                          accent="amber"
                          sparseScale
                          valueLabel={(value) => `${value}%`}
                          description={(value) =>
                            formatTemplate(
                              props.copy.autoResetThresholdDescTemplate ??
                                "Use a reset at {value}% long-term quota or less.",
                              value
                            )
                          }
                          onPreview={(value) => props.onPatchSettings({ autoResetWeeklyThreshold: value })}
                          onCommit={(value) => patchAndSend("autoResetWeeklyThreshold", value)}
                        />
                      </div>
                    </SettingsToggleBlock>
                    <SettingsToggleBlock
                      title="Wait for running sessions"
                      sub="Switch automatically after running chats finish."
                      enabled={props.settings.autoSwitchWaitForSessionsEnabled === true}
                      onToggle={(enabled) => patchAndSend("autoSwitchWaitForSessionsEnabled", enabled)}
                    />
                    <SettingsToggleBlock
                      title={props.copy.autoResumeTitle}
                      sub={props.copy.autoResumeSub}
                      enabled={props.settings.autoResumeEnabled === true}
                      onToggle={(enabled) => patchAndSend("autoResumeEnabled", enabled)}
                    >
                      {props.settings.autoResumeEnabled && (
                        <SettingsToggleBlock
                          title={props.copy.autoResumeGoalOnlyTitle}
                          sub={props.copy.autoResumeGoalOnlySub}
                          enabled={props.settings.autoResumeGoalOnlyEnabled !== false}
                          onToggle={(enabled) => patchAndSend("autoResumeGoalOnlyEnabled", enabled)}
                        />
                      )}
                    </SettingsToggleBlock>
                    <SettingsToggleBlock
                      title={props.copy.autoSwitchRefreshAllTitle ?? "Refresh quotas before switching"}
                      sub={
                        props.copy.autoSwitchRefreshAllSub ??
                        "Check available quota before alerts or switches."
                      }
                      enabled={props.settings.autoSwitchRefreshAllBeforeSwitchEnabled === true}
                      onToggle={(enabled) => patchAndSend("autoSwitchRefreshAllBeforeSwitchEnabled", enabled)}
                    />
                    <SettingsToggleBlock
                      title={props.copy.autoSwitchReloadTitle}
                      sub={props.copy.autoSwitchReloadSub}
                      enabled={props.settings.autoSwitchReloadWindowEnabled}
                      onToggle={(enabled) => patchAndSend("autoSwitchReloadWindowEnabled", enabled)}
                    />
                  </div>
                  <div class="settings-note">{props.copy.autoSwitchAnyNote}</div>
                </div>
              </SettingsToggleBlock>
              <SettingsToggleBlock
                title={props.copy.warningTitle}
                sub={props.copy.warningSub}
                enabled={props.settings.quotaWarningEnabled}
                className="settings-block-wide"
                onToggle={(enabled) => patchAndSend("quotaWarningEnabled", enabled)}
              >
                <div class={`settings-stack ${props.settings.quotaWarningEnabled ? "" : "is-hidden"}`}>
                  <SettingsDiscreteSlider
                    value={props.settings.quotaWarningThreshold}
                    values={WARNING_VALUES}
                    accent="amber"
                    scaleValues={WARNING_SCALE_VALUES}
                    valueLabel={(value) => `${value}%`}
                    description={(value) =>
                      `${props.copy.hourlyLabel}: ${formatTemplate(props.copy.warningValueDescTemplate, value)}`
                    }
                    onPreview={(value) => props.onPatchSettings({ quotaWarningThreshold: value })}
                    onCommit={(value) => patchAndSend("quotaWarningThreshold", value)}
                  />
                  <SettingsDiscreteSlider
                    value={props.settings.quotaWarningWeeklyThreshold}
                    values={WEEKLY_WARNING_VALUES}
                    accent="sky"
                    scaleValues={WEEKLY_WARNING_SCALE_VALUES}
                    valueLabel={(value) => `${value}%`}
                    description={(value) =>
                      `${longQuotaLabel}: ${formatTemplate(props.copy.warningValueDescTemplate, value)}`
                    }
                    onPreview={(value) => props.onPatchSettings({ quotaWarningWeeklyThreshold: value })}
                    onCommit={(value) => patchAndSend("quotaWarningWeeklyThreshold", value)}
                  />
                </div>
              </SettingsToggleBlock>
              <SettingsThresholdBlock
                copy={props.copy}
                settings={props.settings}
                onPreview={props.onThresholdPreview}
                onCommit={props.onThresholdCommit}
              />
              <SettingsToggleBlock
                title="Automatic token history"
                sub="Save daily usage; existing history stays when off."
                enabled={props.settings.dailyTokenUsageEnabled === true}
                className="settings-block-wide"
                onToggle={(enabled) => patchAndSend("dailyTokenUsageEnabled", enabled)}
              >
                <SettingsDiscreteSlider
                  value={props.settings.dailyTokenUsageIntervalMinutes ?? 60}
                  values={TOKEN_HISTORY_GAP_VALUES}
                  accent="sky"
                  scaleValues={[1, 360, 720, 1080, 1440]}
                  valueLabel={(value) => value === 1440 ? "1D" : value < 60 ? `${value}M` : `${Math.floor(value / 60)}H${value % 60 ? ` ${value % 60}M` : ""}`}
                  description={() => "Gap between automatic checks; server retry delays still apply."}
                  onPreview={(value) => props.onPatchSettings({ dailyTokenUsageIntervalMinutes: value })}
                  onCommit={(value) => patchAndSend("dailyTokenUsageIntervalMinutes", value)}
                />
              </SettingsToggleBlock>
            </div>
          </div>
          <div
            class="settings-tab-panel"
            id="settings-panel-data"
            role="tabpanel"
            aria-labelledby="settings-tab-data"
            hidden={activeTab !== "data"}
          >
            <SettingsPanelIntro tab={tabs[2]!} />
            <div class="settings-layout">
              <div class="settings-block settings-block-wide settings-history-block">
                <div class="settings-toggle-head">
                  <div class="settings-block-head">
                    <div class="settings-block-title settings-title-with-badge">
                      {usageHistoryCopy.title}
                      <span class="settings-count-badge">{usageHistoryCopy.count}</span>
                    </div>
                    <div class="settings-block-sub" title={usageHistoryCopy.sub}>{usageHistoryCopy.sub}</div>
                  </div>
                  <button
                    class="settings-history-clear"
                    type="button"
                    disabled={props.usageHistoryCount === 0}
                    title={usageHistoryCopy.clear}
                    aria-label={usageHistoryCopy.clear}
                    onClick={props.onClearUsageHistory}
                  >
                    {renderRemoveIcon()}
                  </button>
                </div>
                <p class="settings-note">Quota history is no longer recorded. Previously saved samples remain available until explicitly cleared.</p>
              </div>
              <div class="settings-block settings-block-wide"><div class="settings-block-title">Usage log</div><p class="settings-note">Verified VS Code tokens stay in SQLite, including disabled and removed accounts. New quota snapshots and other-client usage are not recorded.</p></div>
              <SettingsToggleBlock
                title="Auto Sync"
                sub={transferCopy.syncSub}
                enabled={props.settings.encryptedSyncEnabled}
                disabled={props.crossPcSyncPending}
                className="settings-block-wide"
                onToggle={props.onSetCrossPcSyncEnabled}
              >
                {props.encryptedSyncNeedsConfiguration ? (
                  <div class="settings-note settings-notice-warning">{passwordCopy.needsConfiguration}</div>
                ) : null}
                {props.encryptedSyncNeedsSettingsSync ? (
                  <div class="settings-note settings-notice-warning">{transferCopy.syncNeedsSettingsSync}</div>
                ) : null}
                {!props.settings.encryptedSyncClaimAllAccountsEnabled && !props.settings.cloudflaredDomain ? (
                  <div class="settings-note settings-notice-warning">Set the shared dashboard address in General.</div>
                ) : null}
                <div class="settings-note">{transferCopy.syncNote}</div>
                <div class="settings-actions">
                  <button
                    class="settings-action-btn"
                    type="button"
                    onClick={props.onSyncNow}
                    disabled={props.crossPcSyncPending || props.syncPending}
                    aria-busy={props.syncPending}
                  >
                    {props.syncPending ? `${transferCopy.syncNow}…` : transferCopy.syncNow}
                  </button>
                </div>
                <SettingsToggleBlock
                  title="Reserve all accounts"
                  sub="Reserve every enabled account for this PC."
                  enabled={props.settings.encryptedSyncClaimAllAccountsEnabled === true}
                  onToggle={(enabled) => patchAndSend("encryptedSyncClaimAllAccountsEnabled", enabled)}
                />
                <SettingsToggleBlock
                  title={resolveFullAccountSyncText("title", props.lang)}
                  sub={resolveFullAccountSyncText("sub", props.lang)}
                  enabled={Boolean(props.settings.fullCrossPcAccountSyncEnabled)}
                  onToggle={(enabled) => patchAndSend("fullCrossPcAccountSyncEnabled", enabled)}
                >
                  <div class="settings-note settings-notice-warning">
                    {resolveFullAccountSyncText(props.settings.fullCrossPcAccountSyncEnabled ? "enabled" : "disabled", props.lang)}
                  </div>
                </SettingsToggleBlock>
                <SettingsToggleBlock
                  title={resolveRegistryOverrideText("title", props.lang)}
                  sub={resolveRegistryOverrideText("sub", props.lang)}
                  enabled={props.settings.encryptedSyncRegistryOverrideEnabled}
                  disabled={props.registryOverridePending}
                  onToggle={props.onSetRegistryOverride}
                >
                  <div class="settings-note settings-notice-warning">
                    {props.registryOverridePending
                      ? resolveRegistryOverrideText("pending", props.lang)
                      : props.settings.encryptedSyncRegistryOverrideEnabled
                        ? resolveRegistryOverrideText("enabled", props.lang)
                        : resolveRegistryOverrideText("disabled", props.lang)}
                  </div>
                </SettingsToggleBlock>
                <div class="settings-block settings-block-wide">
                  <div class="settings-block-head">
                    <div class="settings-block-title">Sync interval</div>
                    <div class="settings-block-sub" title="How often to save changes with VS Code Sync.">How often to save changes with VS Code Sync.</div>
                  </div>
                  <SettingsDiscreteSlider
                    value={props.settings.encryptedSyncVsCodeHeartbeatMinutes ?? 5}
                    values={Array.from({ length: 60 }, (_, index) => index + 1)}
                    accent="violet"
                    scaleValues={[1, 15, 30, 45, 60]}
                    valueLabel={(value) => `${value} min`}
                    description={() => "VS Code Sync interval"}
                    onPreview={(value) => props.onPatchSettings({ encryptedSyncVsCodeHeartbeatMinutes: value })}
                    onCommit={(value) => patchAndSend("encryptedSyncVsCodeHeartbeatMinutes", value)}
                  />
                </div>
              </SettingsToggleBlock>
              <div class="settings-block settings-block-wide">
                <div class="settings-block-head">
                  <div class="settings-block-title">{transferCopy.title}</div>
                  <div class="settings-block-sub" title={transferCopy.sub}>{transferCopy.sub}</div>
                </div>
                <div class="settings-stack">
                  <div class="settings-actions">
                    <button class="settings-action-btn" type="button" onClick={props.onExportBackup}>
                      {transferCopy.exportLabel}
                    </button>
                    <button class="settings-action-btn" type="button" onClick={props.onImportBackup}>
                      {transferCopy.importLabel}
                    </button>
                  </div>
                  <div class="settings-note">{transferCopy.note}</div>
                </div>
              </div>
              <SettingsToggleBlock
                title="System Log"
                sub="Save local logs with account secrets hidden."
                enabled={props.settings.persistentLoggingEnabled === true}
                className="settings-block-wide"
                onToggle={(enabled) => patchAndSend("persistentLoggingEnabled", enabled)}
              >
                <label class="settings-block-head">
                  <span class="settings-block-title">Log level</span>
                  <select class="settings-select" aria-label="Log level" value={props.settings.persistentLogLevel ?? "info"}
                    onChange={(event) => patchAndSend("persistentLogLevel", event.currentTarget.value)}>
                    <option value="debug">Debug — all details</option>
                    <option value="info">Info — normal activity</option>
                    <option value="warning">Warnings and errors</option>
                    <option value="error">Errors only</option>
                  </select>
                </label>
                <SettingsDiscreteSlider
                  value={logRetentionPreview ?? props.settings.persistentLogRetentionDays ?? 3}
                  values={Array.from({ length: 30 }, (_, index) => index + 1)}
                  accent="violet"
                  scaleValues={[1, 7, 14, 21, 30]}
                  valueLabel={(days) => `${days} day${days === 1 ? "" : "s"}`}
                  description={() => "Keep diagnostic logs"}
                  onPreview={setLogRetentionPreview}
                  onCommit={(days) => { setLogRetentionPreview(undefined); patchAndSend("persistentLogRetentionDays", days); }}
                />
                <div class="settings-actions"><button class="settings-action-btn" type="button" onClick={props.onShowLogs}>Show log</button></div>
              </SettingsToggleBlock>

            </div>
          </div>
          <div class="settings-tab-panel" id="settings-panel-tools" role="tabpanel" aria-labelledby="settings-tab-tools" hidden={activeTab !== "tools"}>
            <SettingsPanelIntro tab={tabs[3]!} />
            <MaintenanceTools sendAction={props.sendAction} targetDeviceId={props.targetDeviceId} targetName={props.targetName} parentOpen={props.open && activeTab === 'tools'} connected={props.connected !== false && props.targetConnected !== false} />
          </div>
        </fieldset></div>
      </div>
    </div>, document.body
  );
}

function SettingsPanelIntro(props: {
  tab: { id: SettingsTabId; label: string; description: string; heading: string };
}) {
  return (
    <div class="settings-panel-intro">
      <div class="settings-panel-marker" aria-hidden="true"></div>
      <div>
        <div class="settings-panel-heading">{props.tab.heading}</div>
        <div class="settings-panel-description">{props.tab.description}</div>
      </div>
    </div>
  );
}

function SettingsTabIcon(props: { tab: SettingsTabId }) {
  if (props.tab === "tools") return <svg class="settings-tab-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m12 3-1 4 3 3 4-1a6 6 0 0 1-7 6l-5 4-3-3 5-5a6 6 0 0 1 4-8Z" /></svg>;
  if (props.tab === "automation") {
    return (
      <svg class="settings-tab-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2" />
        <circle cx="10" cy="10" r="3.2" />
        <path d="m4.7 4.7 1.5 1.5M13.8 13.8l1.5 1.5M15.3 4.7l-1.5 1.5M6.2 13.8l-1.5 1.5" />
      </svg>
    );
  }

  if (props.tab === "data") {
    return (
      <svg class="settings-tab-icon" viewBox="0 0 20 20" aria-hidden="true">
        <ellipse cx="10" cy="5" rx="6" ry="2.5" />
        <path d="M4 5v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-5" />
      </svg>
    );
  }

  return (
    <svg class="settings-tab-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 5.5h12M4 10h12M4 14.5h12" />
      <circle cx="7" cy="5.5" r="1.5" />
      <circle cx="13" cy="10" r="1.5" />
      <circle cx="8.5" cy="14.5" r="1.5" />
    </svg>
  );
}

function resolveSettingsNavigationCopy(lang: DashboardState["lang"]): {
  kicker: string;
  tabListLabel: string;
  tabs: Array<{ id: SettingsTabId; label: string; description: string; heading: string }>;
} {
  if (lang === "zh") {
    return {
      kicker: "控制中心",
      tabListLabel: "设置类别",
      tabs: [
        { id: "general", label: "常规", heading: "工作区与外观", description: "配置主题、语言、面板访问和本机会话。" },
        {
          id: "automation",
          label: "自动化",
          heading: "配额与自动化",
          description: "管理刷新、告警、阈值和自动切换行为。"
        },
        { id: "data", label: "数据与同步", heading: "数据、同步与诊断", description: "管理备份、加密同步和网络诊断。" }
      ]
    };
  }

  if (lang === "zh-hant") {
    return {
      kicker: "控制中心",
      tabListLabel: "設定類別",
      tabs: [
        {
          id: "general",
          label: "一般",
          heading: "工作區與外觀",
          description: "設定主題、語言、面板存取和本機工作階段。"
        },
        {
          id: "automation",
          label: "自動化",
          heading: "配額與自動化",
          description: "管理重新整理、警告、門檻和自動切換行為。"
        },
        { id: "data", label: "資料與同步", heading: "資料、同步與診斷", description: "管理備份、加密同步和網路診斷。" }
      ]
    };
  }

  return {
    kicker: "Control center",
    tabListLabel: "Settings categories",
    tabs: [
      {
        id: "general",
        label: "General",
        heading: "Workspace & appearance",
        description: "Theme, language, dashboard access, and local sessions."
      },
      {
        id: "automation",
        label: "Automation",
        heading: "Quota & automation",
        description: "Refresh schedules, alerts, thresholds, and account switching."
      },
      {
        id: "data",
        label: "Data & sync",
        heading: "Data & sync",
        description: "Backups, automatic sync, recovery controls, and account claims."
      }
    ]
  };
}

function resolveRegistryOverrideText(
  key: "title" | "sub" | "enabled" | "disabled" | "pending",
  lang: DashboardState["lang"]
): string {
  const values = {
    en: {
      title: "Use reserved accounts",
      sub: "Use an account reserved by another PC.",
      enabled: "Active here; another PC may use the same account.",
      disabled: "Requires the shared password.",
      pending: "Waiting for password verification…"
    },
    zh: {
      title: "救援覆盖",
      sub: "仅在本机解除其他电脑的启用锁定，不更改共享注册表。",
      enabled: "本机绕过已启用。同一会话现在可能被多台电脑同时使用。",
      disabled: "已关闭。启用时需要验证加密同步密码。",
      pending: "正在等待同步密码验证…"
    },
    "zh-hant": {
      title: "救援覆寫",
      sub: "僅在本機解除其他電腦的啟用鎖定，不變更共享登錄。",
      enabled: "本機略過已啟用。同一工作階段現在可能被多台電腦同時使用。",
      disabled: "已關閉。啟用時需要驗證加密同步密碼。",
      pending: "正在等待同步密碼驗證…"
    }
  } as const;
  const locale = lang === "zh" || lang === "zh-hant" ? lang : "en";
  return values[locale][key];
}

function resolveUsageHistoryCopy(
  lang: DashboardState["lang"],
  count: number
): { title: string; sub: string; count: string; clear: string } {
  if (lang === "zh") {
    return {
      title: "配额图表记录",
      sub: "选择自动清理时间。",
      count: `${count} 条`,
      clear: "清除配额图表记录"
    };
  }
  if (lang === "zh-hant") {
    return {
      title: "配額圖表記錄",
      sub: "選擇自動清理時間。",
      count: `${count} 筆`,
      clear: "清除配額圖表記錄"
    };
  }
  return {
    title: "Quota graph history",
    sub: "Choose how long to keep quota history.",
    count: `${count} samples`,
    clear: "Clear quota graph history"
  };
}

function resolvePasswordCopy(
  lang: DashboardState["lang"],
  configured: boolean
): {
  title: string;
  sub: string;
  note: string;
  needsConfiguration: string;
  configure: string;
} {
  if (lang === "zh") {
    return {
      title: "密码",
      sub: "为 Codex Manager 的受保护功能设置一个共享密码。",
      note: "同一个密码用于加密同步、远程面板登录、多电脑连接和恢复控制。",
      needsConfiguration: "密码需要重新设置，然后受保护的功能才能继续使用。",
      configure: configured ? "更改密码" : "设置密码"
    };
  }
  if (lang === "zh-hant") {
    return {
      title: "密碼",
      sub: "為 Codex Manager 的受保護功能設定一個共用密碼。",
      note: "同一個密碼用於加密同步、遠端面板登入、多電腦連線和復原控制。",
      needsConfiguration: "密碼需要重新設定，受保護的功能才能繼續使用。",
      configure: configured ? "變更密碼" : "設定密碼"
    };
  }
  return {
    title: "Password",
    sub: "Protect remote access, sync, and recovery.",
    note: "Use the same password on each PC.",
    needsConfiguration: "Set the shared password to continue.",
    configure: configured ? "Change Password" : "Set Password"
  };
}

function resolveTransferCopy(lang: DashboardState["lang"]): {
  title: string;
  sub: string;
  exportLabel: string;
  importLabel: string;
  note: string;
  syncTitle: string;
  syncSub: string;
  syncNote: string;
  syncNeedsSettingsSync: string;
  syncNow: string;
} {
  if (lang === "zh") {
    return {
      title: "手动迁移",
      sub: "手动迁移所有账号会话、扩展设置和诊断日志。",
      exportLabel: "导出全部会话",
      importLabel: "导入全部会话",
      note: "导出文件包含登录令牌，请使用安全方式传输并在完成后删除。",
      syncTitle: "自动同步",
      syncSub: "同步账号 ID 和电脑占用声明，以防多台电脑同时执行后台操作。",
      syncNote: "通过 VS Code Settings Sync 和实时电脑连接同步加密声明。请在“常规”中设置相同的共享密码。",
      syncNeedsSettingsSync:
        "此电脑上的 VS Code Settings Sync 尚未启用。请登录 VS Code 并启用 Settings Sync，然后重试。",
      syncNow: "立即同步"
    };
  }
  if (lang === "zh-hant") {
    return {
      title: "手動轉移",
      sub: "手動轉移所有帳戶工作階段、擴充功能設定與診斷記錄。",
      exportLabel: "匯出全部工作階段",
      importLabel: "匯入全部工作階段",
      note: "匯出檔案包含登入權杖，請使用安全方式傳輸並在完成後刪除。",
      syncTitle: "自動同步",
      syncSub: "同步帳號 ID 和電腦占用聲明，避免多台電腦同時執行背景操作。",
      syncNote: "透過 VS Code Settings Sync 和即時電腦連線同步加密聲明。請在「一般」中設定相同的共用密碼。",
      syncNeedsSettingsSync:
        "此電腦上的 VS Code Settings Sync 尚未啟用。請登入 VS Code 並啟用 Settings Sync，然後重試。",
      syncNow: "立即同步"
    };
  }
  return {
    title: "Manual transfer",
    sub: "Move accounts, settings, and logs between PCs.",
    exportLabel: "Export all sessions",
    importLabel: "Import all sessions",
    note: "Contains login tokens; share securely, then delete.",
    syncTitle: "Auto Sync",
    syncSub: "Share account reservations between PCs.",
    syncNote:
      "Use the same dashboard address and password on each PC.",
    syncNeedsSettingsSync:
      "Sign in to VS Code and enable Settings Sync.",
    syncNow: "Sync now"
  };
}

function resolveFullAccountSyncText(
  kind: "title" | "sub" | "enabled" | "disabled",
  lang: DashboardState["lang"]
): string {
  const english = {
    title: "Sync account logins",
    sub: "Share encrypted logins between PCs.",
    enabled: "Login tokens can sync to PCs with the password.",
    disabled: "Login tokens stay on this PC."
  };
  const simplified = {
    title: "完整跨电脑账号同步",
    sub: "在电脑之间共享加密账号会话和令牌。默认关闭；账号占用检查无需开启此项。",
    enabled: "已启用：会话和令牌可使用共享密码同步到其他电脑。",
    disabled: "已关闭：所有会话和令牌仅保存在本机，只共享账号占用声明。"
  };
  const traditional = {
    title: "完整跨電腦帳號同步",
    sub: "在電腦之間共享加密帳號工作階段和權杖。預設關閉；帳號占用檢查無需開啟此項。",
    enabled: "已啟用：工作階段和權杖可使用共用密碼同步到其他電腦。",
    disabled: "已關閉：所有工作階段和權杖只保留在本機，只共享帳號占用聲明。"
  };
  return (lang === "zh" ? simplified : lang === "zh-hant" ? traditional : english)[kind];
}
