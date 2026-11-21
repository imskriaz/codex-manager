import type {
  DashboardCopy,
  DashboardOfficeView,
  DashboardSettingKey,
  DashboardSettings,
  DashboardState
} from "../../src/domain/dashboard/types";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
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
import { clampWebviewZoom } from "./webviewZoom";

import { BrowserNotifications } from "./browserNotifications";
import { MaintenanceTools } from "./maintenanceTools";
import { SystemStartupSetting } from './systemStartupSetup';
import { MasterUsernameField } from './masterUsernameField';
import type { SendAction } from "./hookTypes";
import { TeamManagementPage, TEAM_SETTINGS_SECTIONS, type TeamSettingsSection } from "./teamManagementPage";
import { isSettingsSectionEnabled, matchesSettingsSearch, resolveSettingsModuleKey } from "./settingsNavigation";

const AUTO_REFRESH_VALUES = Array.from({ length: 56 }, (_, index) => index + 5);
const AUTO_REFRESH_SCALE_VALUES = [5, 15, 30, 45, 60];
const CURRENT_AUTO_REFRESH_VALUES = Array.from({ length: 60 }, (_, index) => index + 1);
const CURRENT_AUTO_REFRESH_SCALE_VALUES = [1, 15, 30, 45, 60];
const USAGE_HISTORY_RETENTION_VALUES = Array.from({length:90},(_,index)=>index+1);
const TOKEN_HISTORY_GAP_VALUES = Array.from({ length: 1440 }, (_, index) => index + 1);
const AUTO_SWITCH_VALUES = Array.from({ length: 21 }, (_, index) => index);
const AUTO_RESET_VALUES = Array.from({ length: 101 }, (_, index) => index);
const CAPACITY_FAILURE_VALUES = Array.from({ length: 100 }, (_, index) => index + 1);
const CAPACITY_RETRY_VALUES = Array.from({ length: 60 }, (_, index) => index + 1);
const WEBVIEW_ZOOM_VALUES = Array.from({ length: 7 }, (_, index) => 80 + index * 10);
// Warning thresholds are intentionally available at every percentage point.
// The native range input already moves in single-point steps; keeping the
// backing values equally granular prevents the nearest-value mapper from
// snapping a user's selection back to a 5% increment.
const WARNING_VALUES = Array.from({ length: 91 }, (_, index) => index);
const WARNING_SCALE_VALUES = [0, 20, 40, 60, 80, 90];
const WEEKLY_WARNING_VALUES = WARNING_VALUES;
const WEEKLY_WARNING_SCALE_VALUES = WARNING_SCALE_VALUES;
type SettingsTabId = "general" | "automation" | "data" | "modules" | "dashboard" | "sessions" | "connections" | "desktop" | "sync" | "usage" | "system-log" | "tools" | TeamSettingsSection;
type SettingsSearchItem = { title: string; text: string; tab: SettingsTabId; element?: HTMLElement };
const SEARCH_TEAM_OPTIONS: Array<[SettingsTabId, string, string]> = [
  ["users", "Add or edit user", "email display name password sign-in enabled suspend role permissions default prompt workspace folder files browser terminal git github environment"],
  ["workspace", "Workspace root", "team files project storage folder"],
  ["mcp", "Data connections", "MCP servers access enabled endpoint label id permissions add remove"],
  ["database", "Database provider", "sqlite postgres postgresql connection URL storage"],
  ["logs", "Team activity log", "audit requests users actions outcomes filter refresh"],
  ["proxy", "API proxy requests", "tokens models timing request activity filter refresh"]
];

export function canShowTeamSettings(settings: DashboardSettings, office?: DashboardOfficeView, browser = false, targetDeviceId?: string): boolean {
  return settings.webDashboardEnabled && settings.teamWorkspaceEnabled === true && (!browser || Boolean(office && office.role !== "user")) && !targetDeviceId;
}

export function shouldPatchDashboardSettingOptimistically(key: DashboardSettingKey): boolean {
  // CLI discovery starts after the host commits the setting.
  return key !== "cliIntegrationEnabled" && key !== "persistentLoggingEnabled" && key !== "persistentLogRetentionDays" && key !== "persistentLogLevel";
}

export function SettingsOverlay(props: {
  open: boolean;
  initialSection?: string;
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
  logConsole?: ComponentChildren;
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
  webviewZoom: number;
  onWebviewZoom: (value: number) => void;
  office?: DashboardOfficeView;
}) {
  const longQuotaLabel = resolveLongQuotaSettingsLabel(props.lang, props.copy.weeklyLabel);
  const safeCurrentRefreshMinutes =
    props.settings.autoRefreshCurrentMinutes > 0 ? Math.max(1, props.settings.autoRefreshCurrentMinutes) : 0;
  const safeAllRefreshMinutes =
    props.settings.autoRefreshMinutes > 0 ? Math.max(5, props.settings.autoRefreshMinutes) : 0;
  const accessibility = useModalAccessibility(props.open, props.onClose);
  const [activeTab, setActiveTab] = useState<SettingsTabId>("general");
  const [sectionSearch, setSectionSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [teamSection, setTeamSection] = useState<TeamSettingsSection>();
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
  const canManageTeam = canShowTeamSettings(props.settings, props.office, document.documentElement.dataset["dashboardHost"] === "browser", props.targetDeviceId);
  const allTabs = [...navigationCopy.tabs,
    { id: "modules" as const, label: "Modules", heading: "Modules", description: "Turn features on or off. Enabled modules appear in the sidebar." },
    { id: "dashboard" as const, label: "Dashboard", heading: "Web Dashboard", description: "Browser hosting and startup." },
    { id: "sessions" as const, label: "Sessions", heading: "Workspace & sessions", description: "Editor limits and accounts in VS Code windows." },
    { id: "connections" as const, label: "Connections", heading: "Cross-system connections", description: "Shared server address for connected systems." },
    { id: "sync" as const, label: "Sync & claim", heading: "Sync & claim", description: "Account reservations, sync behavior, and recovery." },
    { id: "desktop" as const, label: "Desktop app", heading: "Desktop app", description: "Restart policy and application path." },
    { id: "usage" as const, label: "Usage log", heading: "Usage log", description: "Automatic token usage recording." },
    { id: "system-log" as const, label: "System log", heading: "System log", description: "Diagnostic detail, retention, and logs." },
    { id: "tools" as const, label: "Tools", heading: "Tools", description: "Review data, clean up, and troubleshoot this system." },
    ...TEAM_SETTINGS_SECTIONS.map(section => ({ id: section.id, label: section.title, heading: section.title, description: section.description }))];
  const tabs = [allTabs[0]!, allTabs.find(tab => tab.id === "modules")!, ...allTabs.filter(tab => tab.id !== "general" && tab.id !== "modules")]
    .filter(tab => isSettingsSectionEnabled(tab.id, props.settings, canManageTeam));
  const searching = Boolean(sectionSearch.trim());
  const [searchItems, setSearchItems] = useState<SettingsSearchItem[]>([]);
  const searchResults = searchItems.filter(item => matchesSettingsSearch(item.text, sectionSearch));
  const readSearchItems = (): SettingsSearchItem[] => {
    const items: SettingsSearchItem[] = [];
    const selector = ".settings-tab-panel .settings-block-title, .settings-tab-panel .step-slider-copy, .settings-tab-panel input[aria-label], .settings-tab-panel select[aria-label], .settings-tab-panel input[type=range], .settings-tab-panel .maintenance-dashboard-card strong, .settings-tab-panel .settings-action-btn, .settings-tab-panel label";
    accessibility.modalRef.current?.querySelectorAll<HTMLElement>(selector).forEach(element => {
      const tab = element.closest<HTMLElement>(".settings-tab-panel")?.id.replace("settings-panel-", "") as SettingsTabId;
      const label = element.cloneNode(true) as HTMLElement;
      label.querySelectorAll("input, select, textarea, option, small, .settings-count-badge").forEach(child => child.remove());
      const title = (element.getAttribute("aria-label") ?? label.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!title || items.some(item => item.tab === tab && item.title === title)) return;
      const description = element.parentElement?.querySelector(".settings-block-sub")?.textContent ?? "";
      items.push({ title, tab, text: title + " " + description, element });
    });
    for (const [tab, title, keywords] of SEARCH_TEAM_OPTIONS) {
      if (canManageTeam || !props.targetDeviceId && props.office?.role !== "user") items.push({ tab, title, text: title + " " + keywords });
    }
    return items;
  };
  const openSearchResult = (item: SettingsSearchItem) => {
    const enabled = tabs.some(tab => tab.id === item.tab);
    setSectionSearch("");
    setActiveTab(enabled ? item.tab : "modules");
    requestAnimationFrame(() => {
      const modal = accessibility.modalRef.current;
      const moduleKey = resolveSettingsModuleKey(item.tab, props.settings);
      let target = enabled ? item.element : modal?.querySelector<HTMLElement>('[data-setting="' + moduleKey + '"] .settings-inline-toggle');
      if (enabled && (!target?.isConnected || target.closest("[hidden], .is-hidden"))) {
        const collapsed = target?.closest<HTMLElement>(".settings-toggle-content[hidden]");
        target = collapsed?.parentElement?.querySelector<HTMLElement>(":scope > .settings-toggle-head .settings-inline-toggle") ?? modal?.querySelector<HTMLElement>('#settings-panel-' + item.tab);
        // A nested option may require more than one parent switch.
        while (target?.closest(".settings-toggle-content[hidden]")) {
          const parent = target.closest<HTMLElement>(".settings-toggle-content[hidden]");
          target = parent?.parentElement?.querySelector<HTMLElement>(":scope > .settings-toggle-head .settings-inline-toggle");
        }
      }
      if (target) {
        if (!target.matches("button, input, select, textarea, a")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "center" });
      }
    });
  };
  useLayoutEffect(() => {
    accessibility.modalRef.current?.querySelector(".settings-modal-body")?.scrollTo({ top: 0 });
  }, [activeTab, searching]);
  useEffect(() => {
    if (props.open) setSearchItems(readSearchItems());
  }, [props.open, props.settings, props.lang, teamSection]);
  useEffect(() => {
    if (props.open && props.initialSection && tabs.some(tab => tab.id === props.initialSection)) setActiveTab(props.initialSection as SettingsTabId);
  }, [props.open, props.initialSection]);
  useLayoutEffect(() => {
    if (!tabs.some(tab => tab.id === activeTab)) setActiveTab("general");
    if (canManageTeam && TEAM_SETTINGS_SECTIONS.some(section => section.id === activeTab)) setTeamSection(activeTab as TeamSettingsSection);
  }, [canManageTeam, activeTab, props.settings]);
  const [clearQuotaOpen, setClearQuotaOpen] = useState(false);
  useEffect(()=>setClearQuotaOpen(false),[props.open,props.targetDeviceId]);
  const [logRetentionPreview, setLogRetentionPreview] = useState<number>();

  if (props.office?.role === "user") {
    return createPortal(<div class={`overlay ${props.open ? "open" : ""}`} aria-hidden={!props.open}>
      <div ref={accessibility.modalRef} class="settings-modal office-user-settings" role="dialog" aria-modal="true" aria-labelledby="office-user-settings-title" tabIndex={-1} onKeyDown={accessibility.onKeyDown}>
        <div class="settings-modal-head"><div><div class="settings-modal-kicker">Workspace</div><div class="settings-modal-title" id="office-user-settings-title">User settings</div></div><button class="settings-close" type="button" aria-label={props.copy.closeModal} onClick={props.onClose}>×</button></div>
        <div class="settings-modal-body">
<div class="settings-block settings-block-wide"><div class="settings-block-head"><div class="settings-block-title">Appearance</div><div class="settings-block-sub">Choose how your workspace looks.</div></div><SettingsThemeBlock lang={props.lang} settings={props.settings} onChange={value => { props.onPatchSettings({ dashboardTheme: value }); props.onSendSetting("dashboardTheme", value); }} /></div><div class="settings-block settings-block-wide"><div class="settings-block-head"><div class="settings-block-title">Workspace access</div><div class="settings-block-sub">Your administrator controls the tools available to you.</div></div><div class="settings-note">{props.office.features.includes("files") ? "Your files and projects are private to your workspace." : "File access is disabled for this workspace."}</div></div></div>
      </div>
    </div>, document.body);
  }

  return createPortal(
    <>
    <div class={`overlay ${props.open ? "open" : ""}`} aria-hidden={!props.open} onPointerDown={accessibility.onBackdropPointerDown} onMouseDown={accessibility.onBackdropMouseDown} onClick={accessibility.onBackdropClick}>
      <div
        ref={accessibility.modalRef}
        class="settings-modal settings-master-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        tabIndex={-1}
        onKeyDown={accessibility.onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div class="settings-modal-head">
          <div class="settings-modal-heading">
            <div class="settings-modal-title" id="settings-modal-title">
              {props.copy.settingsTitle}
            </div>
            <span class="settings-modal-system">{props.targetName}</span>
          </div>
          <button class="settings-close" type="button" aria-label={props.copy.closeModal} onClick={props.onClose}>
            ×
          </button>
        </div>
        <label class="settings-mobile-picker">
          <span>{navigationCopy.tabListLabel}</span>
          <select aria-label="Settings section" value={activeTab} onChange={event => { setSectionSearch(""); setActiveTab(event.currentTarget.value as SettingsTabId); }}>
            {tabs.map(tab => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
          </select>
        </label>

        <aside class="settings-sidebar">
        <div class="settings-search"><input ref={searchRef} type="text" role="searchbox" inputMode="search" autoComplete="off" aria-label="Search all settings" placeholder="Search" value={sectionSearch} onInput={event => { setSearchItems(readSearchItems()); setSectionSearch(event.currentTarget.value); }} />{searching ? <button type="button" aria-label="Clear settings search" onClick={() => { setSectionSearch(""); searchRef.current?.focus(); }}>×</button> : null}</div>
        <div class="settings-tab-list" role="tablist" aria-orientation="vertical" onKeyDown={handleTabKeyDown} aria-label={navigationCopy.tabListLabel}>
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              id={`settings-tab-${tab.id}`}
              class={`settings-tab ${activeTab === tab.id ? "active" : ""}`}
              type="button"
              role="tab"
              aria-label={tab.label}
              title={tab.description}
              aria-selected={activeTab === tab.id}
              aria-controls={`settings-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => { setSectionSearch(""); setActiveTab(tab.id); }}
              onKeyDown={(event) => {
                const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
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
                event.stopPropagation();
                const nextTab = tabs[nextIndex]!;
                setSectionSearch("");
                setActiveTab(nextTab.id);
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>(`#settings-tab-${nextTab.id}`)
                  ?.focus();
              }}
            >
              <SettingsTabIcon tab={tab.id} />
              <span class="settings-tab-copy">
                <span class="settings-tab-label">{tab.label}</span>
              </span>
            </button>
          ))}
        </div>

        </aside>
        <div class="settings-modal-body">
          {searching ? <section class="settings-search-results" aria-label="Settings search results"><div class="settings-panel-heading">Search settings</div><p class="settings-note" role="status">{searchResults.length} matching options</p>{searchResults.map(item => <button type="button" class="settings-search-result" onClick={() => openSearchResult(item)}><span><strong>{item.title}</strong><small>{allTabs.find(tab => tab.id === item.tab)?.label}</small></span><span class="settings-search-result-action">{tabs.some(tab => tab.id === item.tab) ? "Open" : "Enable module"}</span></button>)}</section> : null}
          <div
            class="settings-tab-panel"
            id="settings-panel-general"
            role="tabpanel"
            aria-labelledby="settings-tab-general"
            hidden={activeTab !== "general" || searching}
          >
          <SettingsPanelIntro tab={allTabs[0]!} />
          <div class="settings-local-preferences settings-layout">
            {document.documentElement.dataset["dashboardHost"] === "browser" && <BrowserNotifications />}
              <div class="settings-block settings-block-wide settings-zoom-block" data-setting="webview-zoom">
                <div class="settings-block-head">
                  <div class="settings-block-title">Dashboard zoom</div>
                  <div class="settings-block-sub">Scale the entire dashboard, workspace, task board, and dialogs on this device.</div>
                </div>
                <SettingsDiscreteSlider
                  value={Math.round(props.webviewZoom * 100)}
                  values={WEBVIEW_ZOOM_VALUES}
                  step={10}
                  accent="sky"
                  valueLabel={(value) => `${value}%`}
                  description={(value) => `Dashboard zoom ${value}%`}
                  scaleValues={[80, 100, 120, 140]}
                  onPreview={(value) => props.onWebviewZoom(clampWebviewZoom(value / 100))}
                  onCommit={(value) => props.onWebviewZoom(clampWebviewZoom(value / 100))}
                />
                <div class="settings-actions"><button class="settings-action-btn" type="button" onClick={() => props.onWebviewZoom(1)}>Reset zoom</button></div>
              </div>
          </div>
            <fieldset class="settings-offline-fieldset" disabled={props.connected === false || props.targetConnected === false}><div class="settings-layout">
              <SettingsThemeBlock
                lang={props.lang}
                settings={props.settings}
                onChange={(value) => {
                  props.onPatchSettings({ dashboardTheme: value });
                  props.onSendSetting("dashboardTheme", value);
                }}
              />
              <SettingsToggleBlock title="System Info" sub="Show battery, network, CPU, RAM, disk space, and uptime in Account Center and the system picker when available." enabled={props.settings.systemInfoEnabled !== false} onToggle={enabled => patchAndSend("systemInfoEnabled", enabled)} />
              <SettingsLanguageBlock
                copy={props.copy}
                settings={props.settings}
                onChange={(value) => {
                  props.onPatchSettings({ displayLanguage: value });
                  props.onSendSetting("displayLanguage", value);
                }}
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
<div class={`settings-block settings-block-wide ${props.encryptedSyncNeedsConfiguration ? "settings-password-required" : ""}`} data-setting="shared-password">
                <div class="settings-block-head">
                  <div class="settings-block-title">{passwordCopy.title}</div>
                  <div class="settings-block-sub" title={passwordCopy.sub}>{passwordCopy.sub}</div>
                </div>
                {props.encryptedSyncNeedsConfiguration ? (
                  <div class="settings-note settings-notice-warning">{passwordCopy.needsConfiguration}</div>
                ) : null}
                <div class="settings-note">{passwordCopy.note}</div>
                <MasterUsernameField sendAction={props.sendAction} authenticatedMaster={props.office?.id === "master"} />
                <div class="settings-actions">
                  <button class="settings-action-btn" type="button" onClick={props.onConfigureSync}>
                    {passwordCopy.configure}
                  </button>
                </div>

              </div>
            </div></fieldset>
          </div>
          <fieldset class="settings-offline-fieldset" disabled={props.connected === false || props.targetConnected === false}>
<div class="settings-tab-panel" id="settings-panel-modules" role="tabpanel" aria-labelledby="settings-tab-modules" hidden={activeTab !== "modules" || searching}><SettingsPanelIntro tab={allTabs.find(tab => tab.id === "modules")!} /><div class="settings-layout"><SettingsToggleBlock settingKey="webDashboardEnabled" title="Web Dashboard" sub="Browser access to accounts and this dashboard." enabled={props.settings.webDashboardEnabled}   onToggle={(enabled) => patchAndSend("webDashboardEnabled", enabled)} />
<SettingsToggleBlock settingKey="cliIntegrationEnabled" title="Enable workspace" sub="Add chats and terminals to this dashboard." enabled={props.settings.cliIntegrationEnabled === true}   onToggle={(enabled) => patchAndSend("cliIntegrationEnabled", enabled)} />
<SettingsToggleBlock settingKey="teamWorkspaceEnabled" title="Enable Team workspace" sub="User accounts, permissions, shared tools, and database settings." enabled={props.settings.teamWorkspaceEnabled === true}  disabled={!props.settings.webDashboardEnabled} onToggle={(enabled) => patchAndSend("teamWorkspaceEnabled", enabled)} />
<SettingsToggleBlock settingKey="apiAccessEnabled" title="Dashboard API" sub="Allow generated Bearer tokens to call the local dashboard API." enabled={props.settings.apiAccessEnabled === true}  disabled={!props.settings.webDashboardEnabled} onToggle={(enabled) => patchAndSend("apiAccessEnabled", enabled)} />
<SettingsToggleBlock settingKey="webSocketServerEnabled" title="WS Cross System" sub="Connect systems through a shared server." enabled={props.settings.webSocketServerEnabled !== false}   onToggle={(enabled) => patchAndSend("webSocketServerEnabled", enabled)} />
<SettingsToggleBlock settingKey="encryptedSyncEnabled" title="Sync and Claim" sub="Sync account data and reserve accounts across your PCs." enabled={props.settings.encryptedSyncEnabled} disabled={props.crossPcSyncPending}  onToggle={props.onSetCrossPcSyncEnabled} />
<SettingsToggleBlock settingKey="codexAppRestartEnabled" title="Desktop app restart" sub="Restart the desktop app after switching accounts." enabled={props.settings.codexAppRestartEnabled}   onToggle={(enabled) => patchAndSend("codexAppRestartEnabled", enabled)} />
<SettingsToggleBlock settingKey="dailyTokenUsageEnabled" title="Usage log" sub="Record verified token usage for your accounts." enabled={props.settings.dailyTokenUsageEnabled === true}   onToggle={(enabled) => patchAndSend("dailyTokenUsageEnabled", enabled)} />
<SettingsToggleBlock settingKey="persistentLoggingEnabled" title="System Log" sub="Save diagnostic logs with account secrets hidden." enabled={props.settings.persistentLoggingEnabled === true}   onToggle={(enabled) => patchAndSend("persistentLoggingEnabled", enabled)} /></div></div><div class="settings-tab-panel" id="settings-panel-dashboard" role="tabpanel" aria-labelledby="settings-tab-dashboard" hidden={activeTab !== "dashboard" || searching}><SettingsPanelIntro tab={allTabs.find(tab => tab.id === "dashboard")!} /><div class="settings-layout"><SettingsToggleBlock
                      title="Always Active"
                      sub="Keep the local dashboard and system services running after VS Code closes."
                      enabled={props.settings.alwaysActive === true}
                      onToggle={(enabled) => patchAndSend("alwaysActive", enabled)}
                    >
                      <div class="settings-note">
                        {props.settings.webDashboardEnabled
                          ? "The standalone Node host will keep using port 39875 after VS Code closes."
                          : "Enable Web Dashboard for this host to stay active."}
                      </div>
                    </SettingsToggleBlock><SystemStartupSetting
                      enabled={props.settings.alwaysActiveStartWithSystem === true}
                      connected={props.connected !== false && props.targetConnected !== false} parentOpen={props.open}
                      targetDeviceId={props.targetDeviceId} targetName={props.targetName} sendAction={props.sendAction}
                      onDisable={() => props.onSendSetting('alwaysActiveStartWithSystem', false)}
                      onEnabled={() => props.onPatchSettings({ alwaysActiveStartWithSystem: true })}
                    /></div></div><div class="settings-tab-panel" id="settings-panel-sessions" role="tabpanel" aria-labelledby="settings-tab-sessions" hidden={activeTab !== "sessions" || searching}><SettingsPanelIntro tab={allTabs.find(tab => tab.id === "sessions")!} /><div class="settings-layout"><div class="settings-block settings-block-wide"><div class="settings-block-head"><div class="settings-block-title">Workspace editor</div></div><div class="settings-block-head">
                        <div class="settings-block-title">Text file limit</div>
                        <div class="settings-block-sub">Maximum size for opening and saving text files in the workspace editor.</div>
                      </div><SettingsDiscreteSlider
                        value={props.settings.workspaceTextFileLimitMb ?? 10}
                        values={Array.from({ length: 16 }, (_, index) => index + 1)}
                        accent="sky"
                        scaleValues={[1, 5, 10, 16]}
                        valueLabel={value => `${value} MB`}
                        description={value => `Open and save text files up to ${value} MB.`}
                        onPreview={value => props.onPatchSettings({ workspaceTextFileLimitMb: value })}
                        onCommit={value => patchAndSend('workspaceTextFileLimitMb', value)}
                      /></div></div></div><div class="settings-tab-panel" id="settings-panel-connections" role="tabpanel" aria-labelledby="settings-tab-connections" hidden={activeTab !== "connections" || searching}><SettingsPanelIntro tab={allTabs.find(tab => tab.id === "connections")!} /><div class="settings-layout"><div class="settings-block settings-block-wide"><div class="settings-block-head"><div class="settings-block-title">Shared dashboard address</div></div><div class={`settings-stack ${props.settings.webSocketServerEnabled === false ? "is-hidden" : ""}`}>
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
                  </div></div></div></div><div class="settings-tab-panel" id="settings-panel-desktop" role="tabpanel" aria-labelledby="settings-tab-desktop" hidden={activeTab !== "desktop" || searching}><SettingsPanelIntro tab={allTabs.find(tab => tab.id === "desktop")!} /><div class="settings-layout"><div class="settings-block settings-block-wide"><div class="settings-block-head"><div class="settings-block-title">{props.copy.codexAppRestartTitle}</div></div><div class={`settings-stack ${props.settings.codexAppRestartEnabled ? "" : "is-hidden"}`}>
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
                </div></div></div></div><div class="settings-tab-panel" id="settings-panel-sync" role="tabpanel" aria-labelledby="settings-tab-sync" hidden={activeTab !== "sync" || searching}><SettingsPanelIntro tab={allTabs.find(tab => tab.id === "sync")!} /><div class="settings-layout">{props.encryptedSyncNeedsConfiguration ? (
                  <div class="settings-note settings-notice-warning">{passwordCopy.needsConfiguration}</div>
                ) : null}{props.encryptedSyncNeedsSettingsSync ? (
                  <div class="settings-note settings-notice-warning">{transferCopy.syncNeedsSettingsSync}</div>
                ) : null}{!props.settings.encryptedSyncClaimAllAccountsEnabled && !props.settings.cloudflaredDomain ? (
                  <div class="settings-note settings-notice-warning">Set the shared dashboard address in Connections.</div>
                ) : null}<div class="settings-note">{transferCopy.syncNote}</div><div class="settings-actions">
                  <button
                    class="settings-action-btn"
                    type="button"
                    onClick={props.onSyncNow}
                    disabled={props.crossPcSyncPending || props.syncPending}
                    aria-busy={props.syncPending}
                  >
                    {props.syncPending ? `${transferCopy.syncNow}…` : transferCopy.syncNow}
                  </button>
                </div><SettingsToggleBlock
                  title="Reserve all accounts"
                  sub="Reserve every enabled account for this PC."
                  enabled={props.settings.encryptedSyncClaimAllAccountsEnabled === true}
                  onToggle={(enabled) => patchAndSend("encryptedSyncClaimAllAccountsEnabled", enabled)}
                /><SettingsToggleBlock
                  title={resolveFullAccountSyncText("title", props.lang)}
                  sub={resolveFullAccountSyncText("sub", props.lang)}
                  enabled={Boolean(props.settings.fullCrossPcAccountSyncEnabled)}
                  onToggle={(enabled) => patchAndSend("fullCrossPcAccountSyncEnabled", enabled)}
                >
                  <div class="settings-note settings-notice-warning">
                    {resolveFullAccountSyncText(props.settings.fullCrossPcAccountSyncEnabled ? "enabled" : "disabled", props.lang)}
                  </div>
                </SettingsToggleBlock><SettingsToggleBlock
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
                </SettingsToggleBlock><div class="settings-block settings-block-wide">
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
                </div></div></div><div class="settings-tab-panel" id="settings-panel-usage" role="tabpanel" aria-labelledby="settings-tab-usage" hidden={activeTab !== "usage" || searching}><SettingsPanelIntro tab={allTabs.find(tab => tab.id === "usage")!} /><div class="settings-layout"><div class="settings-block settings-block-wide"><div class="settings-block-head"><div class="settings-block-title">Usage recording interval</div></div><SettingsDiscreteSlider
                  value={props.settings.dailyTokenUsageIntervalMinutes ?? 60}
                  values={TOKEN_HISTORY_GAP_VALUES}
                  accent="sky"
                  scaleValues={[1, 360, 720, 1080, 1440]}
                  valueLabel={(value) => value === 1440 ? "1D" : value < 60 ? `${value}M` : `${Math.floor(value / 60)}H${value % 60 ? ` ${value % 60}M` : ""}`}
                  description={() => "Gap between automatic checks; server retry delays still apply."}
                  onPreview={(value) => props.onPatchSettings({ dailyTokenUsageIntervalMinutes: value })}
                  onCommit={(value) => patchAndSend("dailyTokenUsageIntervalMinutes", value)}
                /></div></div></div><div class="settings-tab-panel" id="settings-panel-system-log" role="tabpanel" aria-labelledby="settings-tab-system-log" hidden={activeTab !== "system-log" || searching}><SettingsPanelIntro tab={allTabs.find(tab => tab.id === "system-log")!} /><div class="settings-layout"><div class="settings-block settings-block-wide"><div class="settings-block-head"><div class="settings-block-title">Diagnostic logging</div></div><label class="settings-block-head">
                  <span class="settings-block-title">Log level</span>
                  <select class="settings-select" aria-label="Log level" value={props.settings.persistentLogLevel ?? "info"}
                    onChange={(event) => patchAndSend("persistentLogLevel", event.currentTarget.value)}>
                    <option value="debug">Debug — all details</option>
                    <option value="info">Info — normal activity</option>
                    <option value="warning">Warnings and errors</option>
                    <option value="error">Errors only</option>
                  </select>
                </label><SettingsDiscreteSlider
                  value={logRetentionPreview ?? props.settings.persistentLogRetentionDays ?? 3}
                  values={Array.from({ length: 30 }, (_, index) => index + 1)}
                  accent="violet"
                  scaleValues={[1, 7, 14, 21, 30]}
                  valueLabel={(days) => `${days} day${days === 1 ? "" : "s"}`}
                  description={() => "Keep diagnostic logs"}
                  onPreview={setLogRetentionPreview}
                  onCommit={(days) => { setLogRetentionPreview(undefined); patchAndSend("persistentLogRetentionDays", days); }}
                /><div class="settings-actions"><button class="settings-action-btn" type="button" onClick={props.onShowLogs}>Show log</button></div>{props.logConsole}</div></div></div>          <div
            class="settings-tab-panel"
            id="settings-panel-automation"
            role="tabpanel"
            aria-labelledby="settings-tab-automation"
            hidden={activeTab !== "automation" || searching}
          >
            <SettingsPanelIntro tab={allTabs[1]!} />
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
                  <SettingsToggleBlock title="Switch after model-capacity failures" sub="Switch after repeated capacity errors when no other session is running and another account is available." enabled={props.settings.modelCapacityAutoSwitchEnabled !== false} onToggle={enabled => patchAndSend('modelCapacityAutoSwitchEnabled', enabled)} >
                  <div class="settings-capacity-controls" hidden={props.settings.modelCapacityAutoSwitchEnabled === false}>
                    <SettingsDiscreteSlider
                      value={props.settings.modelCapacityFailureCount ?? 3}
                      values={CAPACITY_FAILURE_VALUES}
                      accent="violet"
                      scaleValues={[1, 25, 50, 75, 100]}
                      valueLabel={value => `${value}`}
                      description={() => "Consecutive failures"}
                      onPreview={value => props.onPatchSettings({ modelCapacityFailureCount: value })}
                      onCommit={value => patchAndSend('modelCapacityFailureCount', value)}
                    />
                    <SettingsDiscreteSlider
                      value={props.settings.standaloneCapacityRetryDelaySeconds ?? 5}
                      values={CAPACITY_RETRY_VALUES}
                      accent="sky"
                      scaleValues={[1, 15, 30, 45, 60]}
                      valueLabel={value => `${value}s`}
                      description={() => "Capacity retry delay"}
                      onPreview={value => props.onPatchSettings({ standaloneCapacityRetryDelaySeconds: value })}
                      onCommit={value => patchAndSend('standaloneCapacityRetryDelaySeconds', value)}
                    />
                  </div></SettingsToggleBlock>
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
                      title={props.copy.autoSwitchRefreshAllTitle ?? "Refresh quotas before switching"}
                      sub={
                        props.copy.autoSwitchRefreshAllSub ??
                        "Check available quota before alerts or switches."
                      }
                      enabled={props.settings.autoSwitchRefreshAllBeforeSwitchEnabled === true}
                      onToggle={(enabled) => patchAndSend("autoSwitchRefreshAllBeforeSwitchEnabled", enabled)}
                    />
                    <SettingsToggleBlock
                      title={props.copy.autoResumeTitle}
                      sub={props.copy.autoResumeSub}
                      enabled={props.settings.autoResumeEnabled === true}
                      onToggle={(enabled) => patchAndSend("autoResumeEnabled", enabled)}
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

            </div>
          </div>
          <div
            class="settings-tab-panel"
            id="settings-panel-data"
            role="tabpanel"
            aria-labelledby="settings-tab-data"
            hidden={activeTab !== "data" || searching}
          >
            <SettingsPanelIntro tab={allTabs[2]!} />
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
                    disabled={props.usageHistoryCount === 0 || props.targetConnected === false || props.connected === false}
                    title={usageHistoryCopy.clear}
                    aria-label={usageHistoryCopy.clear}
                    onClick={()=>setClearQuotaOpen(true)}
                  >
                    {renderRemoveIcon()}
                  </button>
                </div>
                {clearQuotaOpen ? <section class="settings-inline-confirm" aria-label="Clear quota graph history?"><strong>Clear quota graph history?</strong><p>Remove saved quota graph samples for {props.targetName}. New quota changes continue recording. Token usage and accounts are kept.</p><div class="modal-actions"><button type="button" onClick={()=>setClearQuotaOpen(false)}>Cancel</button><button type="button" class="danger" disabled={props.targetConnected === false || props.connected === false} onClick={()=>{setClearQuotaOpen(false);props.onClearUsageHistory();}}>Clear quota history</button></div></section> : null}
                <SettingsDiscreteSlider
                  value={props.settings.usageHistoryRetentionDays}
                  values={USAGE_HISTORY_RETENTION_VALUES}
                  accent="sky"
                  scaleValues={[1,7,30,60,90]}
                  valueLabel={value=>`${value} days`}
                  description={value=>`Record quota changes and keep ${value} days of graph history.`}
                  onPreview={value=>props.onPatchSettings({usageHistoryRetentionDays:value})}
                  onCommit={value=>patchAndSend('usageHistoryRetentionDays',value)}
                />
              </div>


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


            </div>
          </div>
          </fieldset>
          <div class="settings-tab-panel" id="settings-panel-tools" role="tabpanel" aria-labelledby="settings-tab-tools" hidden={activeTab !== "tools" || searching}>
            <SettingsPanelIntro tab={tabs.find(tab => tab.id === "tools")!} />
            <MaintenanceTools sendAction={props.sendAction} targetDeviceId={props.targetDeviceId} targetName={props.targetName} parentOpen={props.open && activeTab === 'tools'} connected={props.connected !== false && props.targetConnected !== false} />
          </div>
          {canManageTeam && teamSection ? <div class="settings-tab-panel" id={`settings-panel-${teamSection}`} role="tabpanel" aria-labelledby={`settings-tab-${teamSection}`} hidden={searching || !TEAM_SETTINGS_SECTIONS.some(section => section.id === activeTab)}><TeamManagementPage key={props.office?.id} office={props.office} section={teamSection} open={props.open && activeTab === teamSection} /></div> : null}
        </div>
      </div>
    </div>

    </>, document.body
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
  const paths: Partial<Record<SettingsTabId, string>> = {
    modules: "M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z",
    dashboard: "M2 3h16v11H2zM7 18h6M10 14v4",
    sessions: "M3 3h14v11H8l-5 3zM6 7h8M6 10h5",
    connections: "M7 7 5 5a3 3 0 0 0-4 4l4 4a3 3 0 0 0 4 0M13 13l2 2a3 3 0 0 0 4-4l-4-4a3 3 0 0 0-4 0M6 6l8 8",
    sync: "M3 7a7 7 0 0 1 12-3l2 2M17 2v4h-4M17 13A7 7 0 0 1 5 16l-2-2M3 18v-4h4",
    desktop: "M3 3h14v10H3zM6 17h8M10 13v4M7 6l-2 2 2 2M10 10h3",
    usage: "M3 17h14M5 14V8M10 14V3M15 14v-4",
    "system-log": "M5 2h10l2 2v14H3V2zM6 6h8M6 10h8M6 14h5",
    logs: "M5 2h10l2 2v14H3V2zM6 6h8M6 10h8M6 14h5",
    users: "M6 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M1 17v-2a5 5 0 0 1 10 0v2M13 4a3 3 0 0 1 0 6M14 12a5 5 0 0 1 5 5",
    workspace: "M2 5h6l2 2h8v10H2z",
    mcp: "M7 3v4M13 3v4M4 7h12v3a6 6 0 0 1-12 0zM10 16v3",
    proxy: "M2 6h14l-3-3M18 14H4l3 3",
    database: "M4 5v10c0 3 12 3 12 0V5M4 5c0-3 12-3 12 0s-12 3-12 0M4 10c0 3 12 3 12 0"
  };
  if (paths[props.tab]) return <svg class="settings-tab-icon" viewBox="0 0 20 20" aria-hidden="true"><path d={paths[props.tab]} /></svg>;
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
        heading: "Appearance & notifications",
        description: "Personalize this dashboard and device."
      },
      {
        id: "automation",
        label: "Automation",
        heading: "Quota & automation",
        description: "Refresh schedules, alerts, thresholds, and account switching."
      },
      {
        id: "data",
        label: "Data",
        heading: "History & backups",
        description: "Quota graph retention and manual backup transfer."
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
    syncTitle: "Sync and Claim",
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
