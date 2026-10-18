import { onDidChangeConfiguration } from "../../storage/configurationEvents";
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
import { waitWithin } from "../../utils/concurrency";
import {
  closeQuotaSummaryTabsForExtensionHostRestart,
  prepareQuotaSummaryPanelForExtensionHostRestart,
  registerDashboardPanelSerializer,
  restoreQuotaSummaryPanelAfterExtensionHostRestart
} from "../dashboard";
import {
  ensureCrossWindowAccountAssignment,
  isCrossWindowAccountModeEnabled
} from "../../services/windowAccountMode";
import {
  cancelCodexSessionAutoResume,
  closeCodexSessionsForExtensionHostRestart,
  formatAutoResumeResult,
  prepareCodexSessionsForExtensionHostRestart,
  registerCodexSessionAutoResumeTracking,
  resumePersistedCodexSessions,
  scheduleCodexSessionAutoResume
} from "../../services/codexSessionAutoResume";

const TOKEN_REFRESH_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;

export class AccountsWorkbench {
  private readonly repo: AccountsRepository;
  private readonly statusBar: AccountsStatusBarProvider;
  private readonly refreshCoordinator: WorkbenchRefreshCoordinator;
  private readonly encryptedSync: EncryptedSyncManager;
  private readonly webDashboard: WebDashboardServer;
  private readonly alwaysOnlineServer: AlwaysOnlineServer;
  private alwaysOnlinePreparationTimer: NodeJS.Timeout | undefined;
  private autoResumeTracking: vscode.Disposable | undefined;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.repo = new AccountsRepository(context);
    this.statusBar = new AccountsStatusBarProvider(context, this.repo);
    this.encryptedSync = new EncryptedSyncManager(context, this.repo);
    this.refreshCoordinator = new WorkbenchRefreshCoordinator(context, this.repo, this.statusBar, (accountId) =>
      this.encryptedSync.canAutomateAccountAfterVaultRefresh(accountId)
    );
    this.webDashboard = new WebDashboardServer(context, this.repo, this.encryptedSync);
    this.alwaysOnlineServer = new AlwaysOnlineServer(context, this.encryptedSync, () => this.webDashboard.isConfiguredDomainLocal());
    this.repo.setAccountSwitchCoordinator(this.encryptedSync);
  }

  async activate(): Promise<void> {
    this.context.subscriptions.push(registerDashboardPanelSerializer(this.context, this.repo, this.webDashboard));
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

    // Register user-facing commands before any fallible startup work. VS Code
    // may invoke a contributed command to activate the extension, and leaving
    // registration until after repository/sync initialization makes that
    // invocation end as "command not found" when later startup work fails.
    const refreshers = this.refreshCoordinator.createRefreshView();
    const refreshWorkbench = refreshers.refresh;
    refreshers.refresh = () => {
      refreshWorkbench();
      this.webDashboard.publishLocalStateChange();
    };
    this.encryptedSync.setOnStateChanged(() => {
      refreshers.refresh();
      if (!this.disposed) {
        this.scheduleAlwaysOnlinePreparation();
      }
    });
    await measureStep("registerCommands", () => {
      registerCommands(this.context, this.repo, refreshers, this.encryptedSync);
    });
    // Dashboard actions can run while the remaining activation work is still
    // waiting on storage or encrypted sync. Register their internal commands
    // before any of that fallible work so every user action reaches a visible
    // terminal result instead of VS Code reporting "command not found".
    this.context.subscriptions.push(
      this.webDashboard,
      this.alwaysOnlineServer,
      vscode.commands.registerCommand("codexManager.openWebDashboard", (options?: { pathname?: string }) =>
        runRegisteredCommand(
          "Open web dashboard",
          () => this.webDashboard.openInBrowser(options?.pathname),
          "dashboard:open-web"
        )
      ),
      vscode.commands.registerCommand(
        "codexManager.prepareDashboardForExtensionHostRestart",
        async (options?: { autoResume?: boolean; signal?: AbortSignal }) => {
          // Save dashboard recovery before optional session discovery can stall.
          const reopenDashboard = await prepareQuotaSummaryPanelForExtensionHostRestart(options?.signal);
          // Also clear pending recovery when the setting was turned off before
          // this reload; stale IDs must not return if it is enabled afterward.
          await prepareCodexSessionsForExtensionHostRestart(this.context, options?.autoResume === true, undefined, undefined, options?.signal);
          options?.signal?.throwIfAborted();
          return reopenDashboard;
        }
      ),
      vscode.commands.registerCommand("codexManager.closeEditorsForExtensionHostRestart", async (options?: { closeSessions?: boolean; signal?: AbortSignal }) => {
        const failures: string[] = [];
        for (const close of [
          () => closeQuotaSummaryTabsForExtensionHostRestart(this.context, options?.signal),
          () => options?.closeSessions === false ? Promise.resolve() : closeCodexSessionsForExtensionHostRestart(this.context, options?.signal)
        ]) {
          try { await close(); }
          catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
        }
        if (failures.length) throw new Error(failures.join(" "));
      }),
      vscode.commands.registerCommand("codexManager.restoreDashboardAfterExtensionHostRestart", () =>
        restoreQuotaSummaryPanelAfterExtensionHostRestart(this.context, this.repo)
      )
    );

    registerDebugOutput(this.context);
    initAutoSwitchRuntimeState(this.context);
    const completedAutoSwitchNotice = consumeAutoSwitchNotice();
    if (completedAutoSwitchNotice) {
      void vscode.window.showInformationMessage(completedAutoSwitchNotice);
    }
    const repoInit = await measureStep("repo.init", async () => this.repo.init());
    const encryptedSyncStartup = measureStep("encryptedSync.start", async () => {
      // Settings Sync is an optional transport. A broken provider, stale
      // secret, or unavailable sync service must never prevent the local
      // account manager (and its schedulers) from starting.
      try {
        await this.encryptedSync.start();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn("[codexManager] encrypted sync startup failed; continuing locally", error);
        console.info("[codexManager] encrypted sync remains unavailable; local account management continues", detail);
      }
    });
    const relayHandoff = measureStep("alwaysOnlineServer.prepare", async () => {
      await this.alwaysOnlineServer.prepareForVscodeSession();
    });
    // Encrypted vault recovery is optional for local startup. The dashboard
    // can serve the local index while it finishes in the background.
    void encryptedSyncStartup.catch(() => undefined);

    // A detached relay may still own the dashboard port. Give its handoff a
    // short head start, then let the normal dashboard come up and retry after
    // the handoff settles instead of holding extension activation for seconds.
    let relayWaitTimer: NodeJS.Timeout | undefined;
    const relayCompleted = relayHandoff.then(
      () => true,
      (error) => {
        console.warn("[codexManager] previous relay handoff failed", error);
        return true;
      }
    );
    const relayReady = await Promise.race([
      relayCompleted,
      new Promise<boolean>((resolve) => {
        relayWaitTimer = setTimeout(() => resolve(false), 500);
        relayWaitTimer.unref?.();
      })
    ]);
    if (relayWaitTimer) clearTimeout(relayWaitTimer);
    await measureStep("webDashboard.start", () => this.startWebDashboard());
    if (!relayReady) {
      void relayCompleted.then(() => this.startWebDashboard()).catch((error) => {
        console.warn("[codexManager] delayed Web Dashboard startup failed", error);
      });
    }
    this.context.subscriptions.push(
      onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("codexManager")) {
          this.webDashboard.publishRealtimeState();
        }
        if (event.affectsConfiguration("codexManager.encryptedSyncEnabled") ||
            event.affectsConfiguration("codexManager.webDashboardEnabled") ||
            event.affectsConfiguration("codexManager.cloudflaredDomain") ||
            event.affectsConfiguration("codexManager.webSocketServerEnabled")) {
          this.scheduleAlwaysOnlinePreparation();
          void this.webDashboard.applyConfiguration().catch(error => {
            console.warn("[codexManager] Web Dashboard configuration update failed", error);
          });
        }
      })
    );
    await measureStep("notifyIndexHealth", async () => {
      await this.notifyIndexHealth();
    });
    await measureStep("refreshCoordinator.initObservedAuthIdentity", async () => {
      await this.refreshCoordinator.initializeObservedAuthIdentity();
    });
    this.context.subscriptions.push({ dispose: () => this.repo.dispose() });
    this.context.subscriptions.push({ dispose: () => this.refreshCoordinator.dispose() });

    if (!repoInit.authSyncCompleted) {
      this.repo.scheduleStartupSync(() => refreshers.refresh());
    }
    await measureStep("registerAuthFileWatcher", () => {
      this.context.subscriptions.push(this.refreshCoordinator.registerAuthFileWatcher(refreshers));
    });
    await measureStep("registerAutoRefreshScheduler", () => {
      this.context.subscriptions.push(
        registerAutoRefreshScheduler({
          context: this.context,
          repo: this.repo,
          onRefresh: refreshers.refresh,
          canRefreshAccount: (accountId) => this.encryptedSync.canAutomateAccount(accountId)
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
          canRefreshAccount: (accountId) => this.encryptedSync.canAutomateAccount(accountId)
        })
      );
    });
    await measureStep("autoImportCurrentAccountIfNeeded", async () => {
      await this.refreshCoordinator.autoImportCurrentAccountIfNeeded(refreshers);
    });
    await measureStep("parallelWindowAccountAssignment", async () => {
      if (!isCrossWindowAccountModeEnabled()) return;
      try {
        const result = await ensureCrossWindowAccountAssignment(await this.repo.listAccounts(), (accountId) =>
          this.repo.switchAccount(accountId)
        );
        if (!result.assigned) {
          void vscode.window.showWarningMessage(
            "Parallel window accounts is enabled, but no usable saved account is available. Add or enable an account, then reload this window."
          );
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`This window could not load its parallel account: ${detail}`);
      }
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
    // Let activation and the restored dashboard paint before optional recovery.
    const recoveryTimer = scheduleCodexSessionAutoResume(() => {
      if (this.disposed) return;
      void measureStep("autoResumeCodexSessions", async () => {
        try {
          const result = await resumePersistedCodexSessions(this.context);
          const message = formatAutoResumeResult(result);
          if (!message) {
            return;
          }
          void vscode.window.showInformationMessage(message);
          if (result.failed.length) {
            console.warn("[codexManager] automatic session resume incomplete", message);
          } else {
            console.info("[codexManager] automatic session resume complete", message);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn("[codexManager] auto resume failed", error);
          console.warn("[codexManager] automatic session resume could not restore running sessions", detail);
        }
      }).finally(() => {
        if (this.disposed) return;
        this.autoResumeTracking = registerCodexSessionAutoResumeTracking(this.context);
        this.context.subscriptions.push(this.autoResumeTracking);
      }).catch((error) => console.warn("[codexManager] auto resume startup task failed", error));
    });
    this.context.subscriptions.push(recoveryTimer);
  }

  dispose(): void {
    this.disposed = true;
    cancelCodexSessionAutoResume();
    this.autoResumeTracking?.dispose();
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

  private async startWebDashboard(): Promise<void> {
    try {
      await this.webDashboard.start();
    } catch (error) {
      console.warn("[codexManager] Web Dashboard startup failed", error);
    }
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.autoResumeTracking?.dispose();
    this.autoResumeTracking = undefined;
    this.encryptedSync.shutdown();
    try { await waitWithin(this.repo.flush(), 1500, "Final account save did not finish before shutdown."); }
    finally { this.dispose(); }
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

  private scheduleAlwaysOnlinePreparation(delay = 1_000): void {
    if (this.alwaysOnlinePreparationTimer) {
      if (delay > 1_000) return;
      clearTimeout(this.alwaysOnlinePreparationTimer);
    }
    this.alwaysOnlinePreparationTimer = setTimeout(() => {
      this.alwaysOnlinePreparationTimer = undefined;
      void this.alwaysOnlineServer.applyConfiguration().catch((error) => {
        console.warn("[codexManager] Always-online relay startup failed", error);
      }).finally(() => { if (!this.disposed) this.scheduleAlwaysOnlinePreparation(60_000); });
    }, delay);
    this.alwaysOnlinePreparationTimer.unref?.();
  }
}
