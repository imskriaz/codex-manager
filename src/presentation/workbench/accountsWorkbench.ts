import * as vscode from "vscode";
import { registerCommands, runRegisteredCommand } from "../../commands";
import { AccountsRepository } from "../../storage";
import { AccountsStatusBarProvider } from "../../ui";
import { registerDebugOutput, runWithPersistentOperation, t } from "../../utils";
import { consumeAutoSwitchNotice, initAutoSwitchRuntimeState } from "./autoSwitchState";
import { WorkbenchRefreshCoordinator } from "./refreshCoordinator";
import { registerAutoRefreshScheduler, registerTokenRefreshScheduler } from "./schedulerRegistration";
import { EncryptedSyncManager } from "../../services/encryptedSync";
import { WebDashboardServer } from "../../services/webDashboardServer";
import { AlwaysOnlineServer } from "../../services/alwaysOnlineServer";
import { getCodexManagerConfiguration } from "../../infrastructure/config/extensionSettings";
import {
  prepareQuotaSummaryPanelForExtensionHostRestart,
  restoreQuotaSummaryPanelAfterExtensionHostRestart
} from "../dashboard";
import { unloadDisabledActiveAccountOnStartup } from "./startupAccountSafety";

const TOKEN_REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;

export class AccountsWorkbench {
  private readonly repo: AccountsRepository;
  private readonly statusBar: AccountsStatusBarProvider;
  private readonly refreshCoordinator: WorkbenchRefreshCoordinator;
  private readonly encryptedSync: EncryptedSyncManager;
  private readonly webDashboard: WebDashboardServer;
  private readonly alwaysOnlineServer: AlwaysOnlineServer;
  private alwaysOnlinePreparationTimer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.repo = new AccountsRepository(context);
    this.statusBar = new AccountsStatusBarProvider(context, this.repo);
    this.refreshCoordinator = new WorkbenchRefreshCoordinator(context, this.repo, this.statusBar);
    this.encryptedSync = new EncryptedSyncManager(context, this.repo);
    this.webDashboard = new WebDashboardServer(context, this.repo, this.encryptedSync);
    this.alwaysOnlineServer = new AlwaysOnlineServer(context, this.encryptedSync);
    this.repo.setAccountSwitchCoordinator(this.encryptedSync);
  }

  async activate(): Promise<void> {
    const activationStartedAt = Date.now();
    const activationSteps: Array<{ name: string; durationMs: number }> = [];
    const measureStep = async <T>(name: string, task: () => T | Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      try {
        return await runWithPersistentOperation(`activation:${name}`, task);
      } finally {
        activationSteps.push({ name, durationMs: Date.now() - startedAt });
      }
    };

    registerDebugOutput(this.context);
    initAutoSwitchRuntimeState(this.context);
    const completedAutoSwitchNotice = consumeAutoSwitchNotice();
    if (completedAutoSwitchNotice) {
      void vscode.window.showInformationMessage(completedAutoSwitchNotice);
    }
    await measureStep("repo.init", async () => {
      await this.repo.init({ deferSync: true });
    });
    await measureStep("disabledActiveAccountFence", async () => {
      await unloadDisabledActiveAccountOnStartup(this.context, this.repo);
    });
    await measureStep("encryptedSync.start", async () => {
      // Settings Sync is an optional transport. A broken provider, stale
      // secret, or unavailable sync service must never prevent the local
      // account manager (and its schedulers) from starting.
      try {
        await this.encryptedSync.start();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn("[codexManager] encrypted sync startup failed; continuing locally", error);
        void vscode.window.showWarningMessage(
          `Encrypted Sync could not start. Local account management will continue; retry Sync later. ${detail}`
        );
      }
    });
    await measureStep("alwaysOnlineServer.prepare", async () => {
      await this.alwaysOnlineServer.prepareForVscodeSession();
    });
    await measureStep("webDashboard.start", async () => {
      try {
        await this.webDashboard.start();
      } catch (error) {
        console.warn("[codexManager] Web Dashboard startup failed", error);
        void vscode.window.showWarningMessage(
          `Web Dashboard could not start on port 39875: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("codexManager.webDashboardEnabled") ||
          event.affectsConfiguration("codexManager.cloudflaredDomain") ||
          event.affectsConfiguration("codexManager.webDashboardAlwaysOnlineEnabled")
        ) {
          void this.webDashboard.applyConfiguration().catch((error) => {
            console.warn("[codexManager] Web Dashboard configuration update failed", error);
            void vscode.window.showWarningMessage(
              `Web Dashboard configuration failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });
          if (event.affectsConfiguration("codexManager.webDashboardAlwaysOnlineEnabled")) {
            void this.alwaysOnlineServer
              .applyConfiguration()
              .then((result) => {
                if (result === "started")
                  void vscode.window.showInformationMessage("Always-online WebSocket host started on this PC.");
                if (result === "stopped")
                  void vscode.window.showInformationMessage("Always-online WebSocket host stopped.");
                if (result === "paused")
                  void vscode.window.showInformationMessage(
                    "Always-online WebSocket host is armed and will take over when VS Code closes."
                  );
              })
              .catch((error) => {
                void vscode.window.showErrorMessage(
                  `Always-online WebSocket host failed: ${error instanceof Error ? error.message : String(error)}`
                );
              });
          }
        }
      }),
      this.webDashboard,
      this.alwaysOnlineServer,
      vscode.commands.registerCommand("codexManager.openWebDashboard", (options?: { pathname?: string }) =>
        runRegisteredCommand(
          "Open web dashboard",
          () => this.webDashboard.openInBrowser(options?.pathname),
          "dashboard:open-web"
        )
      ),
      vscode.commands.registerCommand("codexManager.prepareDashboardForExtensionHostRestart", () =>
        prepareQuotaSummaryPanelForExtensionHostRestart()
      )
    );
    await measureStep("notifyIndexHealth", async () => {
      await this.notifyIndexHealth();
    });
    await measureStep("refreshCoordinator.initObservedAuthIdentity", async () => {
      await this.refreshCoordinator.initializeObservedAuthIdentity();
    });
    this.context.subscriptions.push({ dispose: () => this.repo.dispose() });
    this.context.subscriptions.push({ dispose: () => this.refreshCoordinator.dispose() });

    const refreshers = this.refreshCoordinator.createRefreshView();
    const refreshWorkbench = refreshers.refresh;
    refreshers.refresh = () => {
      refreshWorkbench();
      this.webDashboard.publishLocalStateChange();
    };
    this.repo.scheduleStartupSync(refreshers.refresh);
    this.encryptedSync.setOnStateChanged(refreshers.refresh);
    await measureStep("registerCommands", () => {
      registerCommands(this.context, this.repo, refreshers, this.encryptedSync);
    });
    await measureStep("registerAuthFileWatcher", () => {
      this.context.subscriptions.push(this.refreshCoordinator.registerAuthFileWatcher(refreshers));
    });
    await measureStep("registerAutoRefreshScheduler", () => {
      this.context.subscriptions.push(
        registerAutoRefreshScheduler({
          context: this.context,
          repo: this.repo,
          onRefresh: refreshers.refresh,
          canRefreshAccount: (accountId) => this.encryptedSync.canRefreshAccount(accountId)
        })
      );
    });
    await measureStep("registerTokenRefreshScheduler", () => {
      this.context.subscriptions.push(
        registerTokenRefreshScheduler({
          context: this.context,
          repo: this.repo,
          view: refreshers,
          checkIntervalMs: TOKEN_REFRESH_CHECK_INTERVAL_MS,
          skewSeconds: TOKEN_REFRESH_SKEW_SECONDS,
          canRefreshAccount: (accountId) => this.encryptedSync.canRefreshAccount(accountId)
        })
      );
    });
    await measureStep("autoImportCurrentAccountIfNeeded", async () => {
      await this.refreshCoordinator.autoImportCurrentAccountIfNeeded(refreshers);
    });
    await measureStep("statusBar.refresh", async () => {
      await this.statusBar.refresh();
    });
    await measureStep("restoreDashboardAfterExtensionHostRestart", async () => {
      await restoreQuotaSummaryPanelAfterExtensionHostRestart(this.context, this.repo);
    });
    console.info(
      `[codexManager] activation completed in ${Date.now() - activationStartedAt}ms`,
      activationSteps.map((step) => `${step.name}=${step.durationMs}ms`).join(", ")
    );
    this.scheduleAlwaysOnlinePreparation();
  }

  dispose(): void {
    if (this.alwaysOnlinePreparationTimer) {
      clearTimeout(this.alwaysOnlinePreparationTimer);
      this.alwaysOnlinePreparationTimer = undefined;
    }
    this.encryptedSync.dispose();
    this.refreshCoordinator.dispose();
    this.repo.dispose();
  }

  showActivationFailure(error: unknown): void {
    this.statusBar.showActivationFailure(error instanceof Error ? error.message : String(error));
  }

  shutdown(): void {
    this.encryptedSync.shutdown();
    this.dispose();
  }

  private async notifyIndexHealth(): Promise<void> {
    const summary = await this.repo.getIndexHealthSummary();
    const translate = t();
    if (summary.status === "restored_from_backup") {
      void vscode.window.showInformationMessage(translate("message.indexAutoRestored"));
      return;
    }

    if (summary.status === "corrupted_unrecoverable") {
      void vscode.window.showWarningMessage(translate("message.indexRecoveryFailed"));
    }
  }

  private scheduleAlwaysOnlinePreparation(): void {
    if (this.alwaysOnlinePreparationTimer) return;
    this.alwaysOnlinePreparationTimer = setTimeout(() => {
      this.alwaysOnlinePreparationTimer = undefined;
      void runWithPersistentOperation("startup:alwaysOnlineServer.prepare", () =>
        this.alwaysOnlineServer.applyConfiguration()
      ).catch((error) => {
        console.warn("[codexManager] Always-online relay startup failed", error);
        if (getAlwaysOnlineEnabled()) {
          void vscode.window.showWarningMessage(
            `Always-online WebSocket host could not start: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      });
    }, 1_000);
    this.alwaysOnlinePreparationTimer.unref?.();
  }
}

function getAlwaysOnlineEnabled(): boolean {
  return getCodexManagerConfiguration().get<boolean>("webDashboardAlwaysOnlineEnabled", false);
}
