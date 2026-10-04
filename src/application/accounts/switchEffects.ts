import * as vscode from "vscode";
import { AutomaticReloadCancelledError, reloadExtensionHostWithSessionCapture } from "../../utils/extensionHostReload";

const reloadExtensionHostWithWindowFallback = (autoResume: boolean, automatic = false): Promise<void> =>
  reloadExtensionHostWithSessionCapture(autoResume, true, automatic);
import type { CodexManagerAccountRecord } from "../../core/types";
import { getCodexManagerConfiguration } from "../../infrastructure/config/extensionSettings";
import {
  getCurrentWindowRuntimeAccountId,
  clearQueuedAccountSwitch,
  needsWindowReloadForAccount,
  queueAccountSwitch
} from "../../presentation/workbench/windowRuntimeAccount";
import { getCodexAppRestartCopy, getCodexAppState, getCommandCopy, restartCodexAppIfInstalled } from "../../utils";
import { isCrossWindowAccountModeEnabled } from "../../services/windowAccountMode";
import { shouldSuppressDashboardNotifications } from "../../utils/notificationPolicy";

const CODEX_APP_RESTART_MODE = "codexAppRestartMode";
const CODEX_APP_RESTART_ENABLED = "codexAppRestartEnabled";
let reloadPromptInFlight: Promise<boolean> | undefined;
let scheduledExtensionHostReload: NodeJS.Timeout | undefined;
const reloadFailureListeners = new Set<(message: string) => void>();
let scheduledAutoResume = false;
let scheduledReloadIsAutomatic = true;

export function scheduleExtensionHostReload(
  onError?: (message: string) => void,
  delayMs = 150,
  changeDescription = "Codex credentials changed",
  autoResume = false,
  automatic = false
): NodeJS.Timeout {
  if (onError) reloadFailureListeners.add(onError);
  scheduledAutoResume ||= autoResume;
  scheduledReloadIsAutomatic &&= automatic;
  if (scheduledExtensionHostReload) {
    return scheduledExtensionHostReload;
  }
  scheduledExtensionHostReload = setTimeout(() => {
    scheduledExtensionHostReload = undefined;
    const preserveSessions = scheduledAutoResume;
    scheduledAutoResume = false;
    const automaticOnly = scheduledReloadIsAutomatic;
    scheduledReloadIsAutomatic = true;
    const failureListeners = [...reloadFailureListeners];
    reloadFailureListeners.clear();
    if (automaticOnly && !isAutomaticWindowReloadEnabled()) {
      const message = "Automatic reload is disabled. Reload VS Code to apply the queued account change.";
      void vscode.window.showInformationMessage(message);
      for (const listener of failureListeners) {
        try {
          listener(message);
        } catch (error) {
          console.warn("[codexManager] reload cancellation callback failed", error);
        }
      }
      return;
    }
    void reloadExtensionHostWithWindowFallback(preserveSessions, automaticOnly)
      .then(() => {
        clearQueuedAccountSwitch();
      })
      .catch((error: unknown) => {
        if (error instanceof AutomaticReloadCancelledError) {
          void vscode.window.showInformationMessage(error.message);
          for (const listener of failureListeners) {
            try {
              listener(error.message);
            } catch (callbackError) {
              console.warn("[codexManager] reload cancellation callback failed", callbackError);
            }
          }
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        const message = `${changeDescription}, but VS Code could not reload: ${detail}. Run Developer: Reload Window and try again.`;
        console.error("[codexManager] unable to reload after Codex credentials changed", error);
        void vscode.window.showErrorMessage(message);
        for (const listener of failureListeners) {
          try {
            listener(message);
          } catch (listenerError) {
            console.warn("[codexManager] reload failure callback failed", listenerError);
          }
        }
      });
  }, delayMs);
  return scheduledExtensionHostReload;
}

export async function handleCodexAppRestartPreference(options?: { allowManualPrompt?: boolean }): Promise<void> {
  if (!getCodexManagerConfiguration().get<boolean>(CODEX_APP_RESTART_ENABLED, false)) {
    return;
  }

  const state = await getCodexAppState();
  if (!state.installed || !state.running) {
    return;
  }

  const config = getCodexManagerConfiguration();
  const mode = config.get<string>(CODEX_APP_RESTART_MODE);
  if (mode === "auto") {
    await restartCodexAppIfInstalled();
    return;
  }

  if (mode !== "manual" || options?.allowManualPrompt === false) {
    return;
  }

  // Dashboard-originated actions render their confirmation in the webview so
  // the choice stays beside the account action. Command Palette/tree actions
  // continue to use the native VS Code notification below.
  if (shouldSuppressDashboardNotifications()) {
    return;
  }

  const copy = getCodexAppRestartCopy();
  const manualChoice = await vscode.window.showInformationMessage(copy.manualMessage, copy.restartNow, copy.later);
  if (manualChoice === copy.restartNow) {
    await restartCodexAppIfInstalled();
  }
}

export async function promptWindowReloadForAccount(
  account: Pick<CodexManagerAccountRecord, "id" | "email">,
  options?: { message?: string }
): Promise<boolean> {
  if (!needsWindowReloadForAccount(account.id)) {
    clearQueuedAccountSwitch();
    return false;
  }

  queueAccountChangeForReload(account.id);
  if (!isCrossWindowAccountModeEnabled() && isAutomaticWindowReloadEnabled()) {
    // Shared auth is a unit: the initiating window reloads automatically;
    // every other window observes the same auth-file change and reloads too.
    scheduleExtensionHostReload(undefined, 300, "Shared Codex account changed", true, true);
    return true;
  }

  // The dashboard will render the Reload/Later choice in its action area.
  // Returning false preserves the queued reload state without opening a
  // second, detached native prompt.
  if (shouldSuppressDashboardNotifications()) {
    return false;
  }

  if (reloadPromptInFlight) {
    return reloadPromptInFlight;
  }

  reloadPromptInFlight = (async () => {
    const copy = getCommandCopy();
    const choice = await vscode.window.showInformationMessage(
      options?.message ?? copy.switchedAndAskReload(account.email),
      copy.reloadNow,
      copy.later
    );
    if (choice === copy.reloadNow) {
      await reloadExtensionHostWithWindowFallback(true);
      clearQueuedAccountSwitch();
      return true;
    }
    const currentWindowAccountId = getCurrentWindowRuntimeAccountId();
    if (currentWindowAccountId && currentWindowAccountId !== account.id) {
      queueAccountSwitch(account.id, currentWindowAccountId);
    } else {
      clearQueuedAccountSwitch();
    }
    return false;
  })().finally(() => {
    reloadPromptInFlight = undefined;
  });

  return reloadPromptInFlight;
}

export async function autoReloadWindowForAccount(accountId?: string): Promise<boolean> {
  if (!needsWindowReloadForAccount(accountId)) {
    clearQueuedAccountSwitch();
    return false;
  }

  if (accountId) queueAccountChangeForReload(accountId);
  if (!isAutomaticWindowReloadEnabled()) {
    return false;
  }

  try {
    await reloadExtensionHostWithWindowFallback(true, true);
    clearQueuedAccountSwitch();
    return true;
  } catch (error) {
    if (error instanceof AutomaticReloadCancelledError) {
      void vscode.window.showInformationMessage(error.message);
      return false;
    }
    throw error;
  }
}

/** Reload the current VS Code window regardless of the queued-account marker. */
export async function reloadWindowNow(): Promise<boolean> {
  await reloadExtensionHostWithWindowFallback(true);
  clearQueuedAccountSwitch();
  return true;
}

/** Record a browser-dashboard switch that the current window has not reloaded for yet. */
export function deferWindowReloadForAccount(accountId: string): boolean {
  if (!needsWindowReloadForAccount(accountId)) {
    clearQueuedAccountSwitch();
    return false;
  }
  if (!isCrossWindowAccountModeEnabled() && isAutomaticWindowReloadEnabled()) {
    queueAccountChangeForReload(accountId);
    scheduleExtensionHostReload(undefined, 300, "Shared Codex account changed", true, true);
    return true;
  }
  const currentWindowAccountId = getCurrentWindowRuntimeAccountId();
  if (currentWindowAccountId && currentWindowAccountId !== accountId) {
    queueAccountSwitch(accountId, currentWindowAccountId);
    return true;
  }
  clearQueuedAccountSwitch();
  return false;
}

function isAutomaticWindowReloadEnabled(): boolean {
  return getCodexManagerConfiguration().get<boolean>("autoSwitchReloadWindowEnabled", false);
}

function queueAccountChangeForReload(accountId: string): void {
  const currentWindowAccountId = getCurrentWindowRuntimeAccountId();
  if (currentWindowAccountId && currentWindowAccountId !== accountId) {
    queueAccountSwitch(accountId, currentWindowAccountId);
  }
}
