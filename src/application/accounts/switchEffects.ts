import * as vscode from "vscode";
import type { CodexManagerAccountRecord } from "../../core/types";
import { getCodexManagerConfiguration } from "../../infrastructure/config/extensionSettings";
import {
  getCurrentWindowRuntimeAccountId,
  clearQueuedAccountSwitch,
  needsWindowReloadForAccount,
  queueAccountSwitch
} from "../../presentation/workbench/windowRuntimeAccount";
import { getCodexAppRestartCopy, getCodexAppState, getCommandCopy, restartCodexAppIfInstalled } from "../../utils";
import { shouldSuppressDashboardNotifications } from "../../utils/notificationPolicy";

const CODEX_APP_RESTART_MODE = "codexAppRestartMode";
const CODEX_APP_RESTART_ENABLED = "codexAppRestartEnabled";
let reloadPromptInFlight: Promise<boolean> | undefined;

export function scheduleExtensionHostReload(
  onError?: (message: string) => void,
  delayMs = 150,
  changeDescription = "Codex credentials changed"
): NodeJS.Timeout {
  return setTimeout(() => {
    void reloadExtensionHostWithWindowFallback().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `${changeDescription}, but VS Code could not reload: ${detail}. Run Developer: Reload Window and try again.`;
      console.error("[codexManager] unable to reload after Codex credentials changed", error);
      void vscode.window.showErrorMessage(message);
      onError?.(message);
    });
  }, delayMs);
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
      clearQueuedAccountSwitch();
      await reloadExtensionHostWithWindowFallback();
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

  clearQueuedAccountSwitch();
  await reloadExtensionHostWithWindowFallback();
  return true;
}

/** Reload the current VS Code window regardless of the queued-account marker. */
export async function reloadWindowNow(): Promise<boolean> {
  clearQueuedAccountSwitch();
  await reloadExtensionHostWithWindowFallback();
  return true;
}

/** Record a browser-dashboard switch that the current window has not reloaded for yet. */
export function deferWindowReloadForAccount(accountId: string): boolean {
  if (!needsWindowReloadForAccount(accountId)) {
    clearQueuedAccountSwitch();
    return false;
  }
  const currentWindowAccountId = getCurrentWindowRuntimeAccountId();
  if (currentWindowAccountId && currentWindowAccountId !== accountId) {
    queueAccountSwitch(accountId, currentWindowAccountId);
    return true;
  }
  clearQueuedAccountSwitch();
  return false;
}

async function reloadExtensionHostWithWindowFallback(): Promise<void> {
  await vscode.commands.executeCommand("codexManager.prepareDashboardForExtensionHostRestart");
  try {
    await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
  } catch (error) {
    console.warn("[codexManager] extension host restart failed; reloading the VS Code window", error);
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}
