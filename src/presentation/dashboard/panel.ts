import * as vscode from "vscode";
import * as fs from "fs";
import { getDashboardCopy } from "../../application/dashboard/copy";
import { buildDashboardState } from "../../application/dashboard/buildDashboardState";
import type {
  DashboardActionName,
  DashboardClientMessage,
  DashboardHostMessage,
  DashboardSettingKey
} from "../../domain/dashboard/types";
import { ExtensionSettingsStore, getCodexManagerConfiguration } from "../../infrastructure/config/extensionSettings";
import { AccountsRepository } from "../../storage";
import { AnnouncementService, type AnnouncementOptions } from "../../services/announcements";
import { renderDashboardShell } from "./shell";
import { buildDashboardStateSignature } from "./signature";
import { executeDashboardActionMessage } from "./actionHandlers";
import { clearDashboardCodexAppPath, clearDashboardCodexCliPath, dispatchDashboardClientMessage } from "./messageDispatcher";
import { DashboardOAuthCoordinator } from "./oauthCoordinator";
import { backfillMissingResetCreditExpiries } from "./resetCreditsBackfill";
import { consumeDashboardActionPrompts, withDashboardNotificationSuppression } from "../../utils/notificationPolicy";
import { readDashboardDailyUsageCache, saveDashboardUsageHistory } from "../../services/dashboardUsageHistory";
import { handleDashboardSettingUpdate, pickDashboardCodexAppPath, pickDashboardCodexCliPath } from "./settings";
import { scheduleExtensionHostReload } from "../../application/accounts/switchEffects";
import { resolveOnboardingCompleted } from "../../services/onboarding";
import { readCodexCliSessions, resolveCodexHome } from "../../services/codexSessionResume";
import { stabilizeSessionProjectPaths } from "../../services/sessionProjectBindings";
import { publishDashboardRealtime } from "../../services/dashboardRealtime";

const DASHBOARD_VIEW_TYPE = "codexQuotaSummary";
const REOPEN_AFTER_HOST_RESTART_KEY = "codexManager.reopenDashboardAfterHostRestart";

function isLocalCliSessionWatchPath(filename: string | Buffer | null): boolean {
  if (filename === null) return true;
  const normalized = String(filename).replace(/\\/g, "/").toLowerCase();
  return normalized === "session_index.jsonl"
    || normalized.startsWith("sessions/")
    || normalized.startsWith("archived_sessions/")
    || normalized.startsWith("thread-writer-locks/");
}

let dashboardPanelController: DashboardPanelController | undefined;

type PublishDashboardSnapshotParams = {
  context: vscode.ExtensionContext;
  repo: AccountsRepository;
  settingsStore: ExtensionSettingsStore;
  logoUri: string;
  announcementsState: Awaited<ReturnType<AnnouncementService["getState"]>>;
  setPanelTitle: (title: string) => void;
  postMessage: (message: DashboardHostMessage) => Thenable<boolean>;
  schedulePublishState: () => void;
  lastPublishedStateSignature?: string;
  force?: boolean;
};

export async function publishDashboardSnapshot(params: PublishDashboardSnapshotParams): Promise<string | undefined> {
  const baseState = await buildDashboardState(params.repo, params.settingsStore, params.logoUri, params.announcementsState);
  const state = {
    ...baseState,
    onboardingCompleted: await resolveOnboardingCompleted(params.context, baseState),
    dailyUsageCache: readDashboardDailyUsageCache(params.context)
  };
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

class DashboardPanelController {
  private readonly settingsStore = new ExtensionSettingsStore();
  private readonly announcements: AnnouncementService;
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
  private lastPublishedStateSignature: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repo: AccountsRepository
  ) {
    this.announcements = new AnnouncementService(context.globalStorageUri.fsPath, context.extensionUri.fsPath);
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
      }
    );
  }

  open(): void {
    const panelTitle = this.getPanelTitle();
    const iconUri = this.getPanelIconUri();
    const targetColumn = this.getTargetViewColumn();

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(DASHBOARD_VIEW_TYPE, panelTitle, targetColumn, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
      });
      this.panel.iconPath = iconUri;
      this.panel.webview.html = renderDashboardShell(this.context, this.panel.webview, this.settingsStore);

      this.panel.onDidDispose(() => {
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

      this.panel.webview.onDidReceiveMessage((message: DashboardClientMessage) => {
        void dispatchDashboardClientMessage(message, {
          onReady: () => {
            this.webviewReady = true;
            this.schedulePublishState();
            this.startCliSessionRealtime();
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
      this.panel.reveal(targetColumn, false);
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

  private async publishState(force = false): Promise<void> {
    if (!this.panel || !this.webviewReady) {
      return;
    }

    const logoUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "product-icons", "codex-openai.svg"))
      .toString();
    const signature = await publishDashboardSnapshot({
      context: this.context,
      repo: this.repo,
      settingsStore: this.settingsStore,
      logoUri,
      announcementsState: await this.announcements.getState(this.getAnnouncementOptions()),
      setPanelTitle: (title) => {
        if (this.panel) {
          this.panel.title = title;
        }
      },
      postMessage: (message) => this.panel!.webview.postMessage(message),
      schedulePublishState: () => this.schedulePublishState(),
      lastPublishedStateSignature: this.lastPublishedStateSignature,
      force
    });
    if (!signature) {
      return;
    }

    this.lastPublishedStateSignature = signature;
  }

  private async handleActionMessage(
    message: Extract<DashboardClientMessage, { type: "dashboard:action" }>
  ): Promise<void> {
    const collected = await withDashboardNotificationSuppression(async () => {
      const result = await executeDashboardActionMessage(
        {
          context: this.context,
          repo: this.repo,
          resolveLanguage: () => this.settingsStore.resolveLanguage(),
          schedulePublishState: () => this.schedulePublishState(),
          publishState: async (force = false) => this.publishState(force),
          oauth: this.oauth,
          announcements: this.announcements,
          getAnnouncementOptions: () => this.getAnnouncementOptions(),
          hostKind: "webview"
        },
        message
      );
      return { result, actionPrompts: consumeDashboardActionPrompts() };
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
      result.status === "completed" &&
      (message.action === "unloadAuth" || result.payload?.reloadScheduled === true)
    ) {
      scheduleExtensionHostReload((errorMessage) => {
        void this.postNotice("error", errorMessage).catch(() => undefined);
      }, 150, message.action === "switch" ? "The account switched" : "Codex auth was unloaded");
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

  async prepareForExtensionHostRestart(): Promise<boolean> {
    if (!this.panel) {
      return false;
    }
    await this.context.workspaceState.update(REOPEN_AFTER_HOST_RESTART_KEY, true);
    this.panel.dispose();
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
  }

  private async pickCodexAppPath(): Promise<void> {
    await pickDashboardCodexAppPath(this.settingsStore);
  }

  private startCliSessionRealtime(): void {
    if (this.cliSessionWatcher || !getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false)) return;
    this.cliSessionReconcileTimer ??= setInterval(() => {
      if (!this.panel || !this.webviewReady) return;
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
    this.cliSessionPublish = undefined;
  }

  private publishCliSessionsRealtime(): Promise<void> {
    if (this.cliSessionPublish) return this.cliSessionPublish;
    this.cliSessionPublish = (async () => {
      if (!this.panel || !this.webviewReady || !getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false)) return;
      const sessions = await readCodexCliSessions();
      const stabilized = await stabilizeSessionProjectPaths(this.context, sessions);
      await this.postActionResult(
        `realtime-cli-${Date.now()}`,
        "listCodexCliSessions",
        "completed",
        undefined,
        { cliSessions: stabilized, realtimeRevision: ++this.cliSessionRealtimeRevision }
      );
    })().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      return this.postNotice("warning", `Realtime sessions could not refresh: ${detail}`);
    }).finally(() => {
      this.cliSessionPublish = undefined;
    });
    return this.cliSessionPublish;
  }

  private async pickCodexCliPath(): Promise<void> {
    if (!(await pickDashboardCodexCliPath(this.settingsStore))) {
      await this.postNotice("warning", "Codex CLI path selection was cancelled.");
    }
  }

  private getAnnouncementOptions(): AnnouncementOptions {
    const packageJson = this.context.extension.packageJSON as { version?: string };
    return {
      version: packageJson.version ?? "0.0.0",
      locale: this.settingsStore.resolveLanguage()
    };
  }
}

export function openQuotaSummaryPanel(context: vscode.ExtensionContext, repo: AccountsRepository): void {
  dashboardPanelController ??= new DashboardPanelController(context, repo);
  dashboardPanelController.open();
}

export async function prepareQuotaSummaryPanelForExtensionHostRestart(): Promise<boolean> {
  return dashboardPanelController?.prepareForExtensionHostRestart() ?? false;
}

export async function restoreQuotaSummaryPanelAfterExtensionHostRestart(
  context: vscode.ExtensionContext,
  repo: AccountsRepository
): Promise<void> {
  if (!context.workspaceState.get<boolean>(REOPEN_AFTER_HOST_RESTART_KEY, false)) {
    return;
  }
  await context.workspaceState.update(REOPEN_AFTER_HOST_RESTART_KEY, false);
  openQuotaSummaryPanel(context, repo);
}

export async function refreshQuotaSummaryPanel(): Promise<void> {
  if (!dashboardPanelController) {
    return;
  }

  await dashboardPanelController.refresh();
}
