import * as vscode from "vscode";
import * as fs from "fs";
import { getDashboardCopy } from "../../application/dashboard/copy";
import { buildDashboardState } from "../../application/dashboard/buildDashboardState";
import type {
  DashboardActionName,
  DashboardClientMessage,
  DashboardHostMessage,
  DashboardCliSessionSummary,
  DashboardState,
  DashboardSettingKey
} from "../../domain/dashboard/types";
import { ExtensionSettingsStore, getCodexManagerConfiguration } from "../../infrastructure/config/extensionSettings";
import { AccountsRepository } from "../../storage";
import { renderDashboardShell } from "./shell";
import { buildDashboardStateSignature } from "./signature";
import { executeDashboardActionMessage } from "./actionHandlers";
import {
  clearDashboardCodexAppPath,
  clearDashboardCodexCliPath,
  dispatchDashboardClientMessage
} from "./messageDispatcher";
import { DashboardOAuthCoordinator } from "./oauthCoordinator";
import { backfillMissingResetCreditExpiries } from "./resetCreditsBackfill";
import { consumeDashboardActionPrompts, withDashboardNotificationSuppression } from "../../utils/notificationPolicy";
import { readDashboardUsageSummary, saveDashboardUsageHistory } from "../../services/dashboardUsageHistory";
import { handleDashboardSettingUpdate, pickDashboardCodexAppPath, pickDashboardCodexCliPath } from "./settings";
import { scheduleExtensionHostReload } from "../../application/accounts/switchEffects";
import { resolveOnboardingCompleted } from "../../services/onboarding";
import { getCodexSessionReadNotice, readCodexCliSessions, resolveCodexHome, SESSION_DISCOVERY_RETRY_GAP_MS } from "../../services/codexSessionResume";
import { stabilizeSessionProjectPaths } from "../../services/sessionProjectBindings";
import { getSqliteStateStore } from "../../storage/sqliteState";
import { publishDashboardRealtime, subscribeDashboardRealtime } from "../../services/dashboardRealtime";
import { listPendingCodexAppServerPrompts } from "../../services/codexAppServerPrompts";
import { listCodexSessionLiveStates } from "../../services/codexSessionLive";
import { recordPersistentEvent } from "../../utils/persistentLog";
import { withCodexSessionRecovery } from "../../services/codexSessionAutoResume";

const DASHBOARD_VIEW_TYPE = "codexQuotaSummary";
const REOPEN_AFTER_HOST_RESTART_KEY = "codexManager.reopenDashboardAfterHostRestart";

function isLocalCliSessionWatchPath(filename: string | Buffer | null): boolean {
  if (filename === null) return true;
  const normalized = String(filename).replace(/\\/g, "/").toLowerCase();
  return (
    normalized === "session_index.jsonl" ||
    /^(?:state|goals)_\d+\.sqlite(?:-wal)?$/.test(normalized) ||
    normalized.startsWith("sessions/") ||
    normalized.startsWith("archived_sessions/") ||
    normalized.startsWith("thread-writer-locks/")
  );
}

let dashboardPanelController: DashboardPanelController | undefined;
let reopenAfterRestart = false;

export interface DashboardPeerHost {
  getDashboardPeerState(): Pick<DashboardState, "connectedPeers" | "peerAccounts">;
  getRemoteCliSessions(): DashboardCliSessionSummary[];
  relayWebviewAction(message: Extract<DashboardClientMessage, { type: "dashboard:action" }>): ReturnType<typeof executeDashboardActionMessage>;
  onDidChangeDashboardPeers(listener: () => void): vscode.Disposable;
}
let dashboardPeerHost: DashboardPeerHost | undefined;

type PublishDashboardSnapshotParams = {
  context: vscode.ExtensionContext;
  repo: AccountsRepository;
  settingsStore: ExtensionSettingsStore;
  logoUri: string;
  setPanelTitle: (title: string) => void;
  postMessage: (message: DashboardHostMessage) => Thenable<boolean>;
  schedulePublishState: () => void;
  lastPublishedStateSignature?: string;
  force?: boolean;
  peerHost?: DashboardPeerHost;
};

export async function publishDashboardSnapshot(params: PublishDashboardSnapshotParams): Promise<string | undefined> {
  const baseState = await buildDashboardState(
    params.repo,
    params.settingsStore,
    params.logoUri
  );
  const state: DashboardState = {
    ...baseState,
    ...params.peerHost?.getDashboardPeerState(),
    onboardingCompleted: await resolveOnboardingCompleted(params.context, baseState)
  };
  state.usageSummary = readDashboardUsageSummary(params.context);
  void backfillMissingResetCreditExpiries(params.repo, state.accounts, params.schedulePublishState).catch(
    () => undefined
  );

  params.setPanelTitle(state.panelTitle);
  const signature = buildDashboardStateSignature(state);
  if (!params.force && signature === params.lastPublishedStateSignature) {
    return undefined;
  }

  await params.postMessage({
    type: "dashboard:snapshot",
    state
  } satisfies DashboardHostMessage);
  return signature;
}

export class DashboardPanelController {
  private readonly settingsStore = new ExtensionSettingsStore();
  private readonly oauth: DashboardOAuthCoordinator;
  private panel: vscode.WebviewPanel | undefined;
  private configWatcher: vscode.Disposable | undefined;
  private webviewReady = false;
  private publishTimer: NodeJS.Timeout | undefined;
  private cliSessionWatcher: fs.FSWatcher | undefined;
  private cliSessionChangeTimer: NodeJS.Timeout | undefined;
  private cliSessionReconcileTimer: NodeJS.Timeout | undefined;
  private cliSessionRealtimeRevision = Date.now();
  private cliSessionPublish: Promise<void> | undefined;
  private cliSessionRefreshAfter = 0;
  private lastPublishedStateSignature: string | undefined;
  private closingForRestart = false;
  private statePublish: Promise<void> | undefined;
  private publishAgain = false;
  private forcePublish = false;
  private panelRevision = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repo: AccountsRepository
  ) {
    this.oauth = new DashboardOAuthCoordinator(
      repo,
      () => {
        this.schedulePublishState();
      },
      async () => {
        if (!getCodexManagerConfiguration().get<boolean>("encryptedSyncEnabled", true)) {
          return undefined;
        }
        return vscode.commands.executeCommand<boolean>("codexManager.syncNow", { announceSuccess: false });
      },
      (oauthSessionId, email) => {
        void this.panel?.webview.postMessage({
          type: "dashboard:oauth-authorized",
          oauthSessionId,
          email
        } satisfies DashboardHostMessage);
      }
    );
    const stopRealtime = subscribeDashboardRealtime((message) => {
      if (message.type === 'dashboard:maintenance-progress' || message.type === "dashboard:project-changed" || message.type === "dashboard:notice" || message.type === "dashboard:terminal-output" || message.type === "dashboard:terminal-complete" || message.type === "dashboard:codex-request" || message.type === "dashboard:codex-request-resolved" || message.type === "dashboard:codex-session-live") {
        void this.panel?.webview.postMessage(message);
      }
    });
    const peersChanged = dashboardPeerHost?.onDidChangeDashboardPeers(() => {
      this.schedulePublishState();
      void this.publishCliSessionsRealtime();
    });
    let stopStorage: (() => void) | undefined;
    try { stopStorage = getSqliteStateStore()?.subscribe(["accounts", "usage", "state", "session-status", "session-preferences"], topics => {
      if (topics.has("session-status") || topics.has("session-preferences")) { this.cliSessionRefreshAfter = 0; void this.publishCliSessionsRealtime(); }
      if (topics.has("accounts") || topics.has("usage") || topics.has("state")) this.schedulePublishState();
    }); }
    catch (error) { stopRealtime(); peersChanged?.dispose(); this.oauth.dispose(); throw error; }
    context.subscriptions.push({ dispose: () => {
      stopRealtime(); stopStorage?.(); peersChanged?.dispose();
      this.panelRevision++;
      this.panel = undefined;
      this.webviewReady = false;
      if (this.publishTimer) clearTimeout(this.publishTimer);
      this.stopCliSessionRealtime();
      this.configWatcher?.dispose();
      this.oauth.dispose();
      if (dashboardPanelController === this) dashboardPanelController = undefined;
    } });
  }

  open(restoredPanel?: vscode.WebviewPanel, preserveFocus = false): void {
    const panelTitle = this.getPanelTitle();
    const iconUri = this.getPanelIconUri();
    const targetColumn = this.getTargetViewColumn();

    if (restoredPanel && this.panel && restoredPanel !== this.panel) {
      restoredPanel.dispose();
    }
    if (!this.panel) {
      this.panel = restoredPanel ?? vscode.window.createWebviewPanel(DASHBOARD_VIEW_TYPE, panelTitle, { viewColumn: targetColumn, preserveFocus }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
      });
      this.panel.title = panelTitle;
      this.panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
      };
      this.panel.iconPath = iconUri;
      try {
        this.panel.webview.html = renderDashboardShell(this.context, this.panel.webview, this.settingsStore);
      } catch (error) {
        const failedPanel = this.panel;
        this.panel = undefined;
        if (!restoredPanel) failedPanel.dispose();
        throw error;
      }

      this.panel.onDidDispose(() => {
        this.panelRevision++;
        if (!this.closingForRestart) {
          reopenAfterRestart = false;
          void Promise.resolve(this.context.workspaceState.update(REOPEN_AFTER_HOST_RESTART_KEY, false)).catch((error: unknown) => {
            void vscode.window.showWarningMessage(`The dashboard closed, but its reopen state could not be saved: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        if (this.publishTimer) {
          clearTimeout(this.publishTimer);
          this.publishTimer = undefined;
        }
        this.oauth.dispose();
        this.configWatcher?.dispose();
        this.configWatcher = undefined;
        this.lastPublishedStateSignature = undefined;
        this.panel = undefined;
        this.webviewReady = false;
        this.stopCliSessionRealtime();
      });
      this.panel.onDidChangeViewState?.(() => {
        if (this.panel?.visible) this.startCliSessionRealtime();
        else this.stopCliSessionRealtime();
      });

      this.panel.webview.onDidReceiveMessage((message: DashboardClientMessage) => {
        void dispatchDashboardClientMessage(message, {
          onReady: () => {
            this.webviewReady = true;
            this.schedulePublishState();
            this.startCliSessionRealtime();
            for (const state of listCodexSessionLiveStates()) {
              void this.panel?.webview.postMessage({ type: "dashboard:codex-session-live", state } satisfies DashboardHostMessage);
            }
            for (const request of listPendingCodexAppServerPrompts()) {
              void this.panel?.webview.postMessage({ type: "dashboard:codex-request", request } satisfies DashboardHostMessage);
            }
          },
          onAction: async (actionMessage) => {
            await this.handleActionMessage(actionMessage);
          },
          onSetting: async (key, value) => {
            await this.handleSettingUpdate(key, value);
          },
          onPickCodexAppPath: async () => {
            await this.pickCodexAppPath();
          },
          onClearCodexAppPath: async () => {
            await clearDashboardCodexAppPath();
          },
          onPickCodexCliPath: async () => {
            await this.pickCodexCliPath();
          },
          onClearCodexCliPath: async () => {
            await clearDashboardCodexCliPath();
          },
          onUsageHistory: async (samples) => {
            await saveDashboardUsageHistory(this.context, samples);
            if (!samples.length) await this.postNotice("warning", "Saved quota history cleared. New quota snapshots remain disabled.");
            this.schedulePublishState();
          }
        }).catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`[codexManager] dashboard request failed: ${message.type}`, error);
          void this.postNotice("error", `The dashboard request failed: ${detail}`).catch(() => undefined);
          void this.publishState(true).catch(() => undefined);
        });
      });

      this.configWatcher = this.settingsStore.onDidChange(() => {
        if (getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false)) this.startCliSessionRealtime();
        else this.stopCliSessionRealtime();
        this.schedulePublishState();
      });
    } else {
      this.panel.title = panelTitle;
      this.panel.iconPath = iconUri;
      this.panel.reveal(targetColumn, preserveFocus);
    }

    if (this.webviewReady) {
      this.schedulePublishState();
    }
  }

  async refresh(): Promise<void> {
    if (!this.panel || !this.webviewReady) {
      return;
    }

    await this.publishState(true);
  }

  private getPanelTitle(): string {
    return getDashboardCopy(this.settingsStore.resolveLanguage()).panelTitle;
  }

  private getPanelIconUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, "media", "product-icons", "codex-openai.svg");
  }

  private getTargetViewColumn(): vscode.ViewColumn {
    const activeEditorColumn = vscode.window.activeTextEditor?.viewColumn;
    return activeEditorColumn ?? vscode.ViewColumn.Active;
  }

  private schedulePublishState(delayMs = 0): void {
    if (!this.panel) {
      return;
    }

    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
    }

    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.publishState().catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("[codexManager] scheduled dashboard publish failed", error);
        void this.postNotice("error", `Dashboard refresh failed: ${detail}`).catch(() => undefined);
      });
    }, delayMs);
  }

  private publishState(force = false): Promise<void> {
    this.forcePublish ||= force;
    if (this.statePublish) { this.publishAgain = true; return this.statePublish; }
    const publishing = Promise.resolve().then(async () => {
      try {
        do {
          this.publishAgain = false;
          const panel = this.panel, revision = this.panelRevision;
          if (!panel || !this.webviewReady) return;
          const forced = this.forcePublish;
          this.forcePublish = false;
          const logoUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "product-icons", "codex-openai.svg")).toString();
          const signature = await publishDashboardSnapshot({
            peerHost: dashboardPeerHost,
            context: this.context, repo: this.repo, settingsStore: this.settingsStore, logoUri,
            setPanelTitle: title => { if (this.panel === panel && this.panelRevision === revision && !this.publishAgain) panel.title = title; },
            postMessage: message => this.panel === panel && this.panelRevision === revision && !this.publishAgain ? panel.webview.postMessage(message) : Promise.resolve(false),
            schedulePublishState: () => this.schedulePublishState(),
            lastPublishedStateSignature: this.lastPublishedStateSignature, force: forced
          });
          if (this.panel === panel && this.panelRevision === revision && !this.publishAgain && signature) this.lastPublishedStateSignature = signature;
        } while (this.publishAgain);
      } finally { this.statePublish = undefined; }
    });
    this.statePublish = publishing;
    return publishing;
  }

  private async handleActionMessage(
    message: Extract<DashboardClientMessage, { type: "dashboard:action" }>
  ): Promise<void> {
    const collected = await withDashboardNotificationSuppression(async () => {
      const target = message.payload?.targetDeviceId;
      const local = dashboardPeerHost?.getDashboardPeerState().connectedPeers?.find(peer => peer.local)?.id;
      const remote = target && target !== "local" && target !== local;
      const result = remote ? dashboardPeerHost ? await dashboardPeerHost.relayWebviewAction(message) :
        { status: "failed" as const, errorMessage: "The selected system is unavailable. Reconnect and try again." } : await executeDashboardActionMessage(
        {
          context: this.context,
          repo: this.repo,
          resolveLanguage: () => this.settingsStore.resolveLanguage(),
          schedulePublishState: () => this.schedulePublishState(),
          publishState: async (force = false) => this.publishState(force),
          oauth: this.oauth,
          hostKind: "webview",
          getRemoteCliSessions: () => dashboardPeerHost?.getRemoteCliSessions() ?? []
        },
        message
      );
      return { result, remote, actionPrompts: consumeDashboardActionPrompts() };
    });
    const result = collected.result;
    const payload = collected.actionPrompts.length
      ? { ...(result.payload ?? {}), actionPrompts: collected.actionPrompts }
      : result.payload;

    await this.postActionResult(
      message.requestId,
      message.action,
      result.status,
      message.accountId,
      payload,
      result.errorMessage
    );
    // Terminal output is transient and therefore is not part of the account
    // snapshot signature. Mirror it explicitly so an open browser workspace
    // sees commands executed from the VS Code dashboard immediately.
    if (message.action === "runWorkspaceTerminalCommand") {
      publishDashboardRealtime({
        type: "dashboard:action-result",
        requestId: message.requestId,
        action: message.action,
        accountId: message.accountId,
        status: result.status,
        payload,
        error: result.errorMessage
      });
    }
    if (
      !collected.remote && result.status === "completed" &&
      (message.action === "unloadAuth" || result.payload?.reloadScheduled === true)
    ) {
      scheduleExtensionHostReload(
        (errorMessage) => {
          void this.postNotice("error", errorMessage).catch(() => undefined);
        },
        150,
        message.action === "switch" ? "The account switched" : message.action === "reloadPrompt" ? "Reload was requested" : "Codex auth was unloaded",
        message.action !== "unloadAuth",
        message.action === "switch"
      );
    }
  }

  private async postActionResult(
    requestId: string,
    action: DashboardActionName,
    status: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["status"],
    accountId?: string,
    payload?: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"],
    error?: string
  ): Promise<void> {
    if (!this.panel) {
      return;
    }

    await this.panel.webview.postMessage({
      type: "dashboard:action-result",
      requestId,
      action,
      accountId,
      status,
      payload,
      error
    } satisfies DashboardHostMessage);
  }

  async prepareForExtensionHostRestart(signal?: AbortSignal): Promise<boolean> {
    const panel = this.panel;
    if (!panel) {
      return false;
    }
    signal?.throwIfAborted();
    // Close before optional recovery storage can stall or be cancelled.
    reopenAfterRestart = true;
    this.closingForRestart = true;
    try { panel.dispose(); }
    finally { this.closingForRestart = false; }
    try { await this.context.workspaceState.update(REOPEN_AFTER_HOST_RESTART_KEY, true); }
    catch (error) {
      throw new Error(`The dashboard closed, but its reopen state could not be saved. Run Codex Manager: Show Quota Summary after reload. ${error instanceof Error ? error.message : String(error)}`);
    }
    signal?.throwIfAborted();
    return true;
  }

  private async postNotice(level: "info" | "warning" | "error", message: string): Promise<void> {
    if (!this.panel) {
      return;
    }
    await this.panel.webview.postMessage({
      type: "dashboard:notice",
      level,
      message
    } satisfies DashboardHostMessage);
  }

  private async handleSettingUpdate(key: DashboardSettingKey, value: string | number | boolean): Promise<void> {
    const updated = await handleDashboardSettingUpdate(key, value);
    if (!updated) {
      throw new Error(`The ${key} setting could not be updated.`);
    }
    this.schedulePublishState();
    if (key === "crossWindowAccountModeEnabled" && typeof value === "boolean") {
      await this.postNotice(
        "info",
        `${value ? "Parallel window accounts enabled" : "Parallel window accounts disabled"}. Reloading this VS Code window to apply the credential isolation mode.`
      );
      scheduleExtensionHostReload(undefined, 150, "Parallel window account mode changed");
    } else await this.postNotice('info', 'Setting saved.');
  }

  private async pickCodexAppPath(): Promise<void> {
    await pickDashboardCodexAppPath(this.settingsStore);
  }

  private startCliSessionRealtime(): void {
    if (this.cliSessionWatcher || !this.panel || this.panel.visible === false || !this.webviewReady || !getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false)) return;
    this.cliSessionReconcileTimer ??= setInterval(() => {
      if (this.panel?.visible === false || !this.webviewReady) return;
      if (!this.cliSessionWatcher) this.startCliSessionRealtime();
      void this.publishCliSessionsRealtime();
    }, 30_000);
    this.cliSessionReconcileTimer.unref?.();
    const codexHome = resolveCodexHome();
    if (!fs.existsSync(codexHome)) return;
    try {
      this.cliSessionWatcher = fs.watch(codexHome, { recursive: true }, (_eventType, filename) => {
        if (!isLocalCliSessionWatchPath(filename) || this.cliSessionChangeTimer) return;
        this.cliSessionChangeTimer = setTimeout(() => {
          this.cliSessionChangeTimer = undefined;
          void this.publishCliSessionsRealtime();
        }, 1_000);
        this.cliSessionChangeTimer.unref?.();
      });
      this.cliSessionWatcher.on("error", () => {
        this.cliSessionWatcher?.close();
        this.cliSessionWatcher = undefined;
      });
    } catch {
      this.cliSessionWatcher = undefined;
    }
  }

  private stopCliSessionRealtime(): void {
    this.cliSessionWatcher?.close();
    this.cliSessionWatcher = undefined;
    if (this.cliSessionChangeTimer) clearTimeout(this.cliSessionChangeTimer);
    this.cliSessionChangeTimer = undefined;
    if (this.cliSessionReconcileTimer) clearInterval(this.cliSessionReconcileTimer);
    this.cliSessionReconcileTimer = undefined;
  }

  private publishCliSessionsRealtime(): Promise<void> {
    if (this.cliSessionPublish) return this.cliSessionPublish;
    const panel = this.panel;
    if (Date.now() < this.cliSessionRefreshAfter || !panel || panel.visible === false || !this.webviewReady ||
      !getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false)) return Promise.resolve();
    let delayMs = 2_000;
    this.cliSessionPublish = (async () => {
      const sessions = await readCodexCliSessions();
      if (sessions.some(session => session.status === "unknown")) delayMs = SESSION_DISCOVERY_RETRY_GAP_MS;
      const stabilized = await stabilizeSessionProjectPaths(this.context, withCodexSessionRecovery(this.context, sessions));
      if (this.panel !== panel || panel.visible === false || !this.webviewReady ||
        !getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false)) return;
      await this.postActionResult(`realtime-cli-${Date.now()}`, "listCodexCliSessions", "completed", undefined, {
        cliSessions: stabilized,
        realtimeRevision: ++this.cliSessionRealtimeRevision,
        notice: getCodexSessionReadNotice(stabilized)
      });
    })()
      .catch((error: unknown) => {
        delayMs = 30_000;
        const detail = error instanceof Error ? error.message : String(error);
        recordPersistentEvent("warning", "session-list", "Background session refresh delayed; retrying quietly", { reason: detail });
      })
      .finally(() => {
        this.cliSessionRefreshAfter = Date.now() + delayMs;
        this.cliSessionPublish = undefined;
      });
    return this.cliSessionPublish;
  }

  private async pickCodexCliPath(): Promise<void> {
    if (!(await pickDashboardCodexCliPath(this.settingsStore))) {
      await this.postNotice("warning", "Codex CLI path selection was cancelled.");
    }
  }

}

export function openQuotaSummaryPanel(context: vscode.ExtensionContext, repo: AccountsRepository): void {
  dashboardPanelController ??= new DashboardPanelController(context, repo);
  dashboardPanelController.open();
}

export function registerDashboardPanelSerializer(
  context: vscode.ExtensionContext, repo: AccountsRepository, peerHost?: DashboardPeerHost
): vscode.Disposable {
  dashboardPeerHost = peerHost;
  return vscode.window.registerWebviewPanelSerializer(DASHBOARD_VIEW_TYPE, {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
      dashboardPanelController ??= new DashboardPanelController(context, repo);
      dashboardPanelController.open(panel, true);
      if (context.workspaceState.get<boolean>(REOPEN_AFTER_HOST_RESTART_KEY, false))
        await context.workspaceState.update(REOPEN_AFTER_HOST_RESTART_KEY, false);
    }
  });
}

export async function prepareQuotaSummaryPanelForExtensionHostRestart(signal?: AbortSignal): Promise<boolean> {
  return dashboardPanelController?.prepareForExtensionHostRestart(signal) ?? false;
}

/** Include restored duplicates that have not reached the panel serializer yet. */
export async function closeQuotaSummaryTabsForExtensionHostRestart(context: vscode.ExtensionContext, signal?: AbortSignal): Promise<void> {
  await prepareQuotaSummaryPanelForExtensionHostRestart(signal);
  signal?.throwIfAborted();
  const readTabs = () => (vscode.window.tabGroups?.all ?? []).flatMap(group => group.tabs).filter(tab => {
    const type = (tab.input as { viewType?: string })?.viewType;
    return type === DASHBOARD_VIEW_TYPE || type === `mainThreadWebview-${DASHBOARD_VIEW_TYPE}`;
  });
  const tabs = readTabs();
  if (!tabs.length) return;
  if (tabs.some(tab => tab.isDirty)) throw new Error("A Codex Manager tab has unsaved changes. Save or close it before retrying.");
  reopenAfterRestart = true;
  await context.workspaceState.update(REOPEN_AFTER_HOST_RESTART_KEY, true);
  signal?.throwIfAborted();
  if (readTabs().some(tab => !tabs.includes(tab) || tab.isDirty)) throw new Error("Codex Manager tabs changed during reload cleanup. Close them and retry.");
  const closed = await vscode.window.tabGroups.close(tabs, true);
  signal?.throwIfAborted();
  if (!closed || readTabs().length) throw new Error("VS Code could not close all previous Codex Manager tabs. Close them and retry.");
}

export async function restoreQuotaSummaryPanelAfterExtensionHostRestart(
  context: vscode.ExtensionContext,
  repo: AccountsRepository
): Promise<void> {
  if (!reopenAfterRestart && !context.workspaceState.get<boolean>(REOPEN_AFTER_HOST_RESTART_KEY, false)) {
    return;
  }
  dashboardPanelController ??= new DashboardPanelController(context, repo);
  dashboardPanelController.open(undefined, true);
  reopenAfterRestart = false;
  await context.workspaceState.update(REOPEN_AFTER_HOST_RESTART_KEY, false);
}

export async function refreshQuotaSummaryPanel(): Promise<void> {
  if (!dashboardPanelController) {
    return;
  }

  await dashboardPanelController.refresh();
}
