import * as vscode from "vscode";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import { flushNotificationDelivery } from "./notificationMirror";

let inFlight: Promise<void> | undefined;
let inFlightAutomatic = false;
let manualReload: AbortController | undefined;
let uncertainCommand: Promise<unknown> | undefined;
class ReloadCommandTimeoutError extends Error {}
export class AutomaticReloadCancelledError extends Error {
  constructor() {
    super("Automatic reload is disabled. Reload VS Code to apply the queued account change.");
    this.name = "AutomaticReloadCancelledError";
  }
}

async function command(name: string, timeoutMs: number, args: unknown[] = [], fence = true, signal?: AbortSignal): Promise<void> {
  const raw = Promise.resolve(vscode.commands.executeCommand(name, ...args));
  // A timed-out best-effort command may still settle later. Keep its rejection
  // observed even when it is intentionally not fenced by the caller.
  void raw.catch(() => undefined);
  if (fence) {
    uncertainCommand = raw;
    void raw
      .finally(() => {
        if (uncertainCommand === raw) uncertainCommand = undefined;
      })
      .catch(() => undefined);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      raw,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ReloadCommandTimeoutError(
                "VS Code did not acknowledge the reload command within its deadline. Retry after the pending command settles."
              )
            ),
          Math.max(1, timeoutMs)
        );
      }),
      new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        abort = () => reject(new Error("Manual reload is continuing without optional preparation."));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

/** One bounded reload workflow for explicit actions and automatic recovery. */
export function reloadExtensionHostWithSessionCapture(
  autoResume: boolean,
  clearNotifications = false,
  automatic = false
): Promise<void> {
  if (inFlight) {
    inFlightAutomatic &&= automatic;
    if (!automatic) manualReload?.abort();
    return inFlight;
  }
  if (uncertainCommand)
    return Promise.reject(new Error("A previous VS Code reload command is still pending. Retry after it settles."));
  inFlightAutomatic = automatic;
  const manual = new AbortController();
  manualReload = manual;
  const verifyAutomaticPreference = (): void => {
    if (inFlightAutomatic && !getCodexManagerConfiguration().get<boolean>("autoSwitchReloadWindowEnabled", false)) {
      throw new AutomaticReloadCancelledError();
    }
  };
  const work = (async () => {
    const deadline = Date.now() + 45_000;
    const capture = new AbortController();
    let captureWarning: string | undefined;
    void vscode.window.showInformationMessage("Preparing to reload Codex Manager.");
    try {
      // Session discovery is recovery work. A stalled Windows lock probe or
      // session store must never prevent the account switch reload itself.
      // Cancellation prevents a late discovery result from replacing recovery.
      await command("codexManager.prepareDashboardForExtensionHostRestart", automatic ? 5_000 : 500, [
        { autoResume: autoResume || getCodexManagerConfiguration().get<boolean>("autoResumeEnabled", false), signal: capture.signal }
      ], false, manual.signal);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn("[codexManager] session capture did not complete before reload", error);
      captureWarning = `Reload will continue, but Codex sessions could not be fully preserved: ${detail}`;
    } finally { capture.abort(new Error("Reload session capture deadline ended.")); }
    verifyAutomaticPreference();
    if (clearNotifications && !manual.signal.aborted) {
      try {
        await command("notifications.clearAll", inFlightAutomatic ? 2_000 : 500, [], false, manual.signal);
      } catch (error) {
        console.warn("[codexManager] could not clear VS Code notifications before reload", error);
      }
    }
    if (captureWarning) void vscode.window.showWarningMessage(captureWarning);
    verifyAutomaticPreference();
    const config = getCodexManagerConfiguration();
    let interruptDelivery: (() => void) | undefined;
    let delivered = false;
    try {
      delivered = await Promise.race([
        manual.signal.aborted ? Promise.resolve(false) : flushNotificationDelivery(Math.max(1, Math.min(inFlightAutomatic ? 8500 : 500, deadline - Date.now() - 2000))),
        new Promise<boolean>(resolve => {
          interruptDelivery = () => resolve(false);
          if (manual.signal.aborted) interruptDelivery();
          else manual.signal.addEventListener("abort", interruptDelivery, { once: true });
        })
      ]);
    } finally {
      if (interruptDelivery) manual.signal.removeEventListener("abort", interruptDelivery);
    }
    if (!delivered) {
      void vscode.window.showWarningMessage("Reload will continue, but browser notification delivery could not be confirmed. Review the dashboard once reconnected.");
    }
    verifyAutomaticPreference();
    if (typeof config.inspect === "function" && ["autoSwitchWaitForSessionsEnabled", "encryptedSyncCurrentAccountOnlyEnabled"].some(key => !config.inspect(key))) {
      await command("workbench.action.reloadWindow", deadline - Date.now());
      return;
    }
    try {
      await command("workbench.action.restartExtensionHost", deadline - Date.now());
    } catch (error) {
      // A timed-out command may already have restarted VS Code. Never issue a
      // second restart while its acknowledgement has an uncertain outcome.
      if (error instanceof ReloadCommandTimeoutError) throw error;
      verifyAutomaticPreference();
      console.warn("[codexManager] extension host restart failed; reloading the window", error);
      await command("workbench.action.reloadWindow", deadline - Date.now());
    }
  })();
  inFlight = work;
  void work
    .finally(() => {
      if (inFlight === work) {
        inFlight = undefined;
        manualReload = undefined;
      }
    })
    .catch(() => undefined);
  return work;
}
