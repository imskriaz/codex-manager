import type {
  DashboardCopy,
  DashboardSettingKey,
  DashboardSettings,
  DashboardState
} from "../../src/domain/dashboard/types";
import { useState } from "preact/hooks";
import {
  SettingsDiscreteSlider,
  SettingsLanguageBlock,
  SettingsPathBlock,
  SettingsPreferenceRow,
  SettingsSegmentBlock,
  SettingsThemeBlock,
  SettingsThresholdBlock,
  SettingsToggleBlock
} from "./components";
import { formatTemplate, formatTimestamp } from "./helpers";
import { renderRemoveIcon } from "./icons";
import { useModalAccessibility } from "./primitives";

const AUTO_REFRESH_VALUES = Array.from({ length: 60 }, (_, index) => index + 1);
const AUTO_REFRESH_SCALE_VALUES = [1, 15, 30, 45, 60];
const USAGE_HISTORY_RETENTION_VALUES = [1, 3, 7, 14, 30, 60, 90];
const AUTO_SWITCH_VALUES = Array.from({ length: 21 }, (_, index) => index);
const AUTO_RESET_VALUES = Array.from({ length: 100 }, (_, index) => index + 1);
// Warning thresholds are intentionally available at every percentage point.
// The native range input already moves in single-point steps; keeping the
// backing values equally granular prevents the nearest-value mapper from
// snapping a user's selection back to a 5% increment.
const WARNING_VALUES = Array.from({ length: 91 }, (_, index) => index);
const WARNING_SCALE_VALUES = [0, 20, 40, 60, 80, 90];
const WEEKLY_WARNING_VALUES = WARNING_VALUES;
const WEEKLY_WARNING_SCALE_VALUES = WARNING_SCALE_VALUES;
type SettingsTabId = "general" | "automation" | "data";

export function shouldPatchDashboardSettingOptimistically(key: DashboardSettingKey): boolean {
  // CLI discovery starts after the host commits the setting.
  return key !== "cliIntegrationEnabled";
}

export function SettingsOverlay(props: {
  open: boolean;
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
  onPickCodexCliPath: () => void;
  onClearCodexCliPath: () => void;
  onClearUsageHistory: () => void;
  onOpenNetworkLogs: () => void;
  onExportBackup: () => void;
  onImportBackup: () => void;
  onConfigureSync: () => void;
  onSyncNow: () => void;
  onSetRegistryOverride: (enabled: boolean) => void;
  registryOverridePending: boolean;
}) {
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
  const passwordCopy = resolvePasswordCopy(props.lang);
  const navigationCopy = resolveSettingsNavigationCopy(props.lang);
  const tabs = navigationCopy.tabs;

  return (
    <div class={`overlay ${props.open ? "open" : ""}`} aria-hidden={!props.open} onClick={props.onClose}>
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
        <div class="settings-tab-list" role="tablist" aria-label={navigationCopy.tabListLabel}>
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              id={`settings-tab-${tab.id}`}
              class={`settings-tab ${activeTab === tab.id ? "active" : ""}`}
              type="button"
              role="tab"
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
              <div class="settings-block settings-block-wide" data-setting="shared-password">
                <div class="settings-block-head">
                  <div class="settings-block-title">{passwordCopy.title}</div>
                  <div class="settings-block-sub">{passwordCopy.sub}</div>
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
                        : "Configure browser access, the online host, and public domain."}
                  </div>
                </div>
                <div class="settings-integration-grid">
                  <SettingsToggleBlock
                    title={
                      props.lang === "zh" ? "浏览器面板" : props.lang === "zh-hant" ? "瀏覽器面板" : "Web Dashboard"
                    }
                    sub={
                      <>
                        {props.lang === "zh"
                          ? "在 127.0.0.1:39875 启动浏览器面板。本机访问无需密码；远程登录使用加密同步密码短语。"
                          : props.lang === "zh-hant"
                            ? "在 127.0.0.1:39875 啟動瀏覽器面板。本機存取無需密碼；遠端登入使用加密同步密碼。"
                            : "Run the browser dashboard at 127.0.0.1:39875. Local access needs no login; remote access uses the shared password."}
                      </>
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
                            : "Enabled. Use the dashboard button at the top to open it in your browser."
                        : props.lang === "zh"
                          ? "已停用。"
                          : props.lang === "zh-hant"
                            ? "已停用。"
                            : "Disabled."}
                    </div>
                  </SettingsToggleBlock>
                  <SettingsToggleBlock
                    title={
                      props.lang === "zh"
                        ? "始终在线 WebSocket 主机"
                        : props.lang === "zh-hant"
                          ? "始終在線 WebSocket 主機"
                          : "Always-online WebSocket host"
                    }
                    sub={
                      props.lang === "zh"
                        ? "在此电脑启动独立 Node.js 中继，即使 VS Code 关闭也保持多电脑 WebSocket 在线。建议只在一台常开电脑启用。"
                        : props.lang === "zh-hant"
                          ? "在此電腦啟動獨立 Node.js 中繼，即使 VS Code 關閉也保持多電腦 WebSocket 在線。建議只在一台常開電腦啟用。"
                          : "Run a detached Node.js relay on this PC so multi-PC WebSockets stay available after VS Code closes. Enable it on one always-on PC."
                    }
                    enabled={props.settings.webDashboardAlwaysOnlineEnabled === true}
                    onToggle={(enabled) => patchAndSend("webDashboardAlwaysOnlineEnabled", enabled)}
                  >
                    <div class="settings-note">
                      {props.settings.webDashboardAlwaysOnlineEnabled
                        ? props.lang === "zh"
                          ? "已启用。VS Code 关闭后中继会接管 127.0.0.1:39875；Cloudflared 端口无需改变。"
                          : props.lang === "zh-hant"
                            ? "已啟用。VS Code 關閉後中繼會接管 127.0.0.1:39875；Cloudflared 連接埠無需改變。"
                            : "Enabled. The relay takes over 127.0.0.1:39875 after VS Code closes; Cloudflared needs no port change."
                        : props.lang === "zh"
                          ? "已停用。VS Code 关闭后不会运行独立中继。"
                          : props.lang === "zh-hant"
                            ? "已停用。VS Code 關閉後不會執行獨立中繼。"
                            : "Disabled. No detached relay runs after VS Code closes."}
                    </div>
                  </SettingsToggleBlock>
                  <div class="settings-block settings-block-wide">
                    <div class="settings-block-head">
                      <div class="settings-block-title">
                        {props.lang === "zh"
                          ? "Cloudflared 域名"
                          : props.lang === "zh-hant"
                            ? "Cloudflared 網域"
                            : "Cloudflared domain"}
                      </div>
                      <div class="settings-block-sub">
                        {props.lang === "zh"
                          ? "可选：输入 Cloudflared 的 HTTPS 域名以便从其他电脑访问。"
                          : props.lang === "zh-hant"
                            ? "可選：輸入 Cloudflared 的 HTTPS 網域，從其他電腦存取。"
                            : "Optional: enter the Cloudflared hostname that reaches this dashboard (for example, codex.example.com)."}
                      </div>
                    </div>
                    <input
                      class="settings-text-input"
                      type="text"
                      name="cloudflared-domain"
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
                            : "Quick setup: set the Password in General, run cloudflared tunnel --url http://127.0.0.1:39875, then sign in remotely with it."}
                    </div>
                  </div>
                </div>
              </div>
              {props.settings.webDashboardEnabled ? <div class="settings-block settings-block-wide settings-integration-group">
                <div class="settings-block-head settings-integration-head">
                  <div class="settings-block-title">
                    {props.lang === "zh" ? "工作区" : props.lang === "zh-hant" ? "工作區" : "Workspace"}
                  </div>
                  <div class="settings-block-sub">
                    {props.lang === "zh"
                      ? "控制工作区功能；CLI 路径仍可单独配置。"
                      : props.lang === "zh-hant"
                        ? "控制工作區功能；CLI 路徑仍可單獨設定。"
                        : "Control workspace features on this PC; configure the CLI path separately when needed."}
                  </div>
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
                          : "Disabled by default and stored only on this PC. Enable the workspace view, sessions, and terminal tools in the dashboard."
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
                            : "Enabled. The workspace entry is available at the top of the dashboard."
                        : props.lang === "zh"
                          ? "已停用。工作区入口和会话读取均关闭。"
                          : props.lang === "zh-hant"
                            ? "已停用。工作區入口與工作階段讀取均關閉。"
                            : "Disabled. The workspace entry and session access are off."}
                    </div>
                  </SettingsToggleBlock>
                  <SettingsPathBlock
                    copy={props.copy}
                    pathValue={props.settings.codexCliPath ?? ""}
                    hasCustomPath={Boolean(props.settings.codexCliPath)}
                    compact
                    title={
                      props.lang === "zh"
                        ? "Codex CLI 路径"
                        : props.lang === "zh-hant"
                          ? "Codex CLI 路徑"
                          : "Codex CLI path"
                    }
                    sub={
                      props.lang === "zh"
                        ? "可选。指定 Codex CLI 可执行文件或启动脚本；留空则自动检测。"
                        : props.lang === "zh-hant"
                          ? "可選。指定 Codex CLI 可執行檔或啟動腳本；留空則自動偵測。"
                          : "Optional. Set the Codex CLI executable or launcher script; leave empty for auto-detection."
                    }
                    emptyLabel={
                      props.lang === "zh"
                        ? "未设置 CLI 路径，将使用自动检测。"
                        : props.lang === "zh-hant"
                          ? "未設定 CLI 路徑，將使用自動偵測。"
                          : "No custom CLI path. Automatic detection will be used."
                    }
                    pickLabel={
                      props.lang === "zh"
                        ? "选择 CLI 路径"
                        : props.lang === "zh-hant"
                          ? "選擇 CLI 路徑"
                          : "Choose CLI path"
                    }
                    clearLabel={
                      props.lang === "zh"
                        ? "自动检测 CLI"
                        : props.lang === "zh-hant"
                          ? "自動偵測 CLI"
                          : "Auto-detect CLI"
                    }
                    onPick={props.onPickCodexCliPath}
                    onClear={props.onClearCodexCliPath}
                  />
                </div>
              </div> : null}
              <SettingsToggleBlock
                title={props.copy.codexAppRestartTitle}
                sub={props.copy.codexAppRestartSub}
                enabled={props.settings.codexAppRestartEnabled}
                className="settings-block-wide"
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
                    compact
                    onPick={props.onPickCodexAppPath}
                    onClear={props.onClearCodexAppPath}
                  />
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
                  enabled={props.settings.autoRefreshCurrentMinutes > 0}
                  onToggle={props.onAutoRefreshCurrentToggle}
                  showToggle={false}
                >
                  <div class={`settings-stack ${props.settings.autoRefreshCurrentMinutes > 0 ? "" : "is-hidden"}`}>
                    <SettingsDiscreteSlider
                      value={props.settings.autoRefreshCurrentMinutes}
                      values={AUTO_REFRESH_VALUES}
                      accent="violet"
                      scaleValues={AUTO_REFRESH_SCALE_VALUES}
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
                  enabled={props.settings.autoRefreshMinutes > 0}
                  onToggle={props.onAutoRefreshToggle}
                  showToggle={false}
                >
                  <div class={`settings-stack ${props.settings.autoRefreshMinutes > 0 ? "" : "is-hidden"}`}>
                    <SettingsDiscreteSlider
                      value={props.settings.autoRefreshMinutes}
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
              <div class="settings-block settings-block-wide settings-history-block">
                <div class="settings-toggle-head">
                  <div class="settings-block-head">
                    <div class="settings-block-title settings-title-with-badge">
                      {usageHistoryCopy.title}
                      <span class="settings-count-badge">{usageHistoryCopy.count}</span>
                    </div>
                    <div class="settings-block-sub">{usageHistoryCopy.sub}</div>
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
                <SettingsDiscreteSlider
                  value={props.settings.usageHistoryRetentionDays}
                  values={USAGE_HISTORY_RETENTION_VALUES}
                  accent="sky"
                  scaleValues={[0, 7, 30, 60, 90]}
                  valueLabel={(value) => resolveRetentionValueLabel(value, props.lang)}
                  description={(value) => resolveRetentionDescription(value, props.lang)}
                  onPreview={(value) => props.onPatchSettings({ usageHistoryRetentionDays: value })}
                  onCommit={(value) => patchAndSend("usageHistoryRetentionDays", value)}
                />
              </div>
              <SettingsToggleBlock
                title={props.copy.hourlyQuotaControlTitle}
                sub={props.copy.hourlyQuotaControlSub}
                enabled={props.settings.hourlyQuotaControlEnabled}
                onToggle={(enabled) => patchAndSend("hourlyQuotaControlEnabled", enabled)}
              >
                <div class="settings-note">
                  {props.settings.hourlyQuotaControlEnabled
                    ? props.copy.hourlyQuotaControlOnDesc
                    : props.copy.hourlyQuotaControlOffDesc}
                </div>
              </SettingsToggleBlock>
              <SettingsToggleBlock
                title={props.copy.tokenAutomationTitle}
                sub={props.copy.tokenAutomationSub}
                enabled={props.settings.backgroundTokenRefreshEnabled}
                onToggle={(enabled) => patchAndSend("backgroundTokenRefreshEnabled", enabled)}
              >
                <div class={`settings-stack ${props.settings.backgroundTokenRefreshEnabled ? "" : "is-hidden"}`}>
                  <div class="settings-note-list">
                    <div class="settings-note-item">
                      <span>{props.copy.tokenAutomationLastCheck}</span>
                      <strong>{formatTimestamp(props.tokenAutomation.lastCheckAt, props.copy.never)}</strong>
                    </div>
                    <div class="settings-note-item">
                      <span>{props.copy.tokenAutomationLastRefresh}</span>
                      <strong>{formatTimestamp(props.tokenAutomation.lastRefreshAt, props.copy.never)}</strong>
                    </div>
                    <div class="settings-note-item">
                      <span>{props.copy.tokenAutomationNextCheck}</span>
                      <strong>{formatTimestamp(props.tokenAutomation.nextCheckAt, props.copy.never)}</strong>
                    </div>
                    <div class="settings-note-item">
                      <span>{props.copy.tokenAutomationLastFailure}</span>
                      <strong>{props.tokenAutomation.lastFailureMessage ?? props.copy.never}</strong>
                    </div>
                  </div>
                </div>
              </SettingsToggleBlock>
              <SettingsToggleBlock
                title={props.copy.autoSwitchTitle}
                sub={props.copy.autoSwitchSub}
                enabled={props.settings.autoSwitchEnabled}
                className="settings-block-wide"
                onToggle={(enabled) => patchAndSend("autoSwitchEnabled", enabled)}
              >
                <div class={`settings-stack ${props.settings.autoSwitchEnabled ? "" : "is-hidden"}`}>
                  {props.settings.hourlyQuotaControlEnabled ? (
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
                  ) : null}
                  <SettingsDiscreteSlider
                    value={props.settings.autoSwitchWeeklyThreshold}
                    values={AUTO_SWITCH_VALUES}
                    accent="sky"
                    sparseScale
                    valueLabel={(value) => `${value}%`}
                    description={(value) =>
                      formatTemplate(props.copy.autoSwitchThresholdDescTemplate, {
                        label: props.copy.weeklyLabel,
                        value
                      })
                    }
                    onPreview={(value) => props.onPatchSettings({ autoSwitchWeeklyThreshold: value })}
                    onCommit={(value) => patchAndSend("autoSwitchWeeklyThreshold", value)}
                  />
                  <SettingsPreferenceRow
                    title={props.copy.autoResetTitle ?? "Automatic quota reset plan"}
                    sub={
                      props.copy.autoResetSub ??
                      "Use an available reset credit when every enabled account is out of quota."
                    }
                    enabled={props.settings.autoResetEnabled === true}
                    onToggle={(enabled) => patchAndSend("autoResetEnabled", enabled)}
                  />
                  {props.settings.autoResetEnabled ? (
                    <SettingsDiscreteSlider
                      value={props.settings.autoResetWeeklyThreshold ?? 1}
                      values={AUTO_RESET_VALUES}
                      accent="amber"
                      sparseScale
                      valueLabel={(value) => `${value}%`}
                      description={(value) =>
                        formatTemplate(
                          props.copy.autoResetThresholdDescTemplate ??
                            "Reset a candidate when its weekly quota is {value}% or lower.",
                          value
                        )
                      }
                      onPreview={(value) => props.onPatchSettings({ autoResetWeeklyThreshold: value })}
                      onCommit={(value) => patchAndSend("autoResetWeeklyThreshold", value)}
                    />
                  ) : null}
                  <SettingsPreferenceRow
                    title={props.copy.autoSwitchReloadTitle}
                    sub={props.copy.autoSwitchReloadSub}
                    enabled={props.settings.autoSwitchReloadWindowEnabled}
                    onToggle={(enabled) => patchAndSend("autoSwitchReloadWindowEnabled", enabled)}
                  />
                  <div class="settings-note">{props.copy.autoSwitchAnyNote}</div>
                </div>
              </SettingsToggleBlock>
              <SettingsToggleBlock
                title={props.copy.warningTitle}
                sub={props.settings.hourlyQuotaControlEnabled ? props.copy.warningSub : props.copy.warningWeeklyOnlySub}
                enabled={props.settings.quotaWarningEnabled}
                className="settings-block-wide"
                onToggle={(enabled) => patchAndSend("quotaWarningEnabled", enabled)}
              >
                <div class={`settings-stack ${props.settings.quotaWarningEnabled ? "" : "is-hidden"}`}>
                  <SettingsPreferenceRow
                    title={props.copy.autoSwitchRefreshAllTitle ?? "Refresh all quotas before warning switch"}
                    sub={
                      props.copy.autoSwitchRefreshAllSub ??
                      "When the warning limit is reached, refresh enabled accounts before showing the notification so the recommended account is current. If every account is below the automatic-switch threshold, the all-account timer also refreshes the current account until one becomes capable."
                    }
                    enabled={props.settings.autoSwitchRefreshAllBeforeSwitchEnabled === true}
                    onToggle={(enabled) => patchAndSend("autoSwitchRefreshAllBeforeSwitchEnabled", enabled)}
                  />
                  {props.settings.hourlyQuotaControlEnabled ? (
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
                  ) : null}
                  <SettingsDiscreteSlider
                    value={props.settings.quotaWarningWeeklyThreshold}
                    values={WEEKLY_WARNING_VALUES}
                    accent="sky"
                    scaleValues={WEEKLY_WARNING_SCALE_VALUES}
                    valueLabel={(value) => `${value}%`}
                    description={(value) =>
                      `${props.copy.weeklyLabel}: ${formatTemplate(props.copy.warningValueDescTemplate, value)}`
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
              <SettingsSegmentBlock
                title={props.copy.debugTitle}
                sub={props.copy.debugSub}
                note={props.copy.debugNote}
                className="settings-block-wide"
                options={[
                  {
                    key: "debug-on",
                    title: props.copy.debugOn,
                    description: props.copy.debugOnDesc,
                    active: props.settings.debugNetwork,
                    onClick: () => patchAndSend("debugNetwork", true)
                  },
                  {
                    key: "debug-off",
                    title: props.copy.debugOff,
                    description: props.copy.debugOffDesc,
                    active: !props.settings.debugNetwork,
                    onClick: () => patchAndSend("debugNetwork", false)
                  }
                ]}
              >
                <div class="settings-actions">
                  <button class="settings-action-btn" type="button" onClick={props.onOpenNetworkLogs}>
                    {resolveOpenLogsLabel(props.lang)}
                  </button>
                </div>
              </SettingsSegmentBlock>
              <div class="settings-block settings-block-wide">
                <div class="settings-block-head">
                  <div class="settings-block-title">{transferCopy.syncTitle}</div>
                  <div class="settings-block-sub">{transferCopy.syncSub}</div>
                </div>
                {props.encryptedSyncNeedsSettingsSync ? (
                  <div class="settings-note settings-notice-warning">{transferCopy.syncNeedsSettingsSync}</div>
                ) : null}
                <div class="settings-note">{transferCopy.syncNote}</div>
                <div class="settings-actions">
                  <button
                    class="settings-action-btn"
                    type="button"
                    onClick={props.onSyncNow}
                    disabled={!props.settings.encryptedSyncEnabled}
                  >
                    {transferCopy.syncNow}
                  </button>
                </div>
              </div>
              <SettingsToggleBlock
                title={resolveRegistryOverrideText("title", props.lang)}
                sub={resolveRegistryOverrideText("sub", props.lang)}
                enabled={props.settings.encryptedSyncRegistryOverrideEnabled}
                disabled={props.registryOverridePending}
                className="settings-block-wide"
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
                  <div class="settings-block-title">{transferCopy.title}</div>
                  <div class="settings-block-sub">{transferCopy.sub}</div>
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
            </div>
          </div>
        </div>
      </div>
    </div>
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
        heading: "Data, sync & diagnostics",
        description: "Backups, encrypted sync, recovery controls, and network logs."
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
      title: "Rescue override",
      sub: "Unlock a foreign-PC enablement locally without changing the shared registry.",
      enabled: "Rescue is active on this PC. The shared enable/disable registry is unchanged.",
      disabled: "Off. Turning this on requires the shared password.",
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

function resolveOpenLogsLabel(lang: DashboardState["lang"]): string {
  return lang === "zh" ? "打开网络日志" : lang === "zh-hant" ? "開啟網路日誌" : "Open network logs";
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
    sub: "Choose when old graph samples are automatically removed.",
    count: `${count} samples`,
    clear: "Clear quota graph history"
  };
}

function resolvePasswordCopy(lang: DashboardState["lang"]): {
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
      configure: "设置或更改密码"
    };
  }
  if (lang === "zh-hant") {
    return {
      title: "密碼",
      sub: "為 Codex Manager 的受保護功能設定一個共用密碼。",
      note: "同一個密碼用於加密同步、遠端面板登入、多電腦連線和復原控制。",
      needsConfiguration: "密碼需要重新設定，受保護的功能才能繼續使用。",
      configure: "設定或變更密碼"
    };
  }
  return {
    title: "Password",
    sub: "Set one shared password for Codex Manager's protected features.",
    note: "The same password protects encrypted sync, remote dashboard login, multi-PC connections, and recovery controls.",
    needsConfiguration: "Set the password again before protected features can continue.",
    configure: "Set or change password"
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
      syncTitle: "加密 VS Code 同步",
      syncSub: "通过 VS Code Settings Sync 按操作同步会话和电脑占用。",
      syncNote: "同步会记录启用账号的电脑。每次切换后运行同步，即可在电脑之间共享最新登记。",
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
      syncTitle: "加密 VS Code 同步",
      syncSub: "透過 VS Code Settings Sync 按操作同步工作階段和啟用登錄。",
      syncNote: "同步會記錄啟用帳號的電腦。每次切換後執行同步，即可在電腦之間分享最新登錄。",
      syncNeedsSettingsSync:
        "此電腦上的 VS Code Settings Sync 尚未啟用。請登入 VS Code 並啟用 Settings Sync，然後重試。",
      syncNow: "立即同步"
    };
  }
  return {
    title: "Manual transfer",
    sub: "Transfer all account sessions, extension settings, and diagnostic logs.",
    exportLabel: "Export all sessions",
    importLabel: "Import all sessions",
    note: "The export contains login tokens. Transfer it securely and delete it when finished.",
    syncTitle: "Encrypted VS Code sync",
    syncSub: "Sync sessions and the enable/disable registry through VS Code Settings Sync.",
    syncNote:
      "The registry records which PC has an account enabled. Run Sync after each toggle to share the latest registry across PCs.",
    syncNeedsSettingsSync:
      "VS Code Settings Sync is not active on this PC. Sign in to VS Code and turn on Settings Sync, then try again.",
    syncNow: "Sync now"
  };
}

function resolveRetentionValueLabel(value: number, lang: DashboardState["lang"]): string {
  return lang === "zh" ? `${value} 天` : lang === "zh-hant" ? `${value} 天` : `${value} days`;
}

function resolveRetentionDescription(value: number, lang: DashboardState["lang"]): string {
  return lang === "zh"
    ? `自动删除超过 ${value} 天的记录。`
    : lang === "zh-hant"
      ? `自動刪除超過 ${value} 天的記錄。`
      : `Automatically remove samples older than ${value} days.`;
}
