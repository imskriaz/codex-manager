import * as vscode from "vscode";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";

let inFlight: Promise<void> | undefined;
let uncertainCommand: Promise<unknown> | undefined;
class ReloadCommandTimeoutError extends Error {}

async function command(name: string, timeoutMs: number, args: unknown[] = [], fence = true): Promise<void> {
  const raw = Promise.resolve(vscode.commands.executeCommand(name, ...args));
  if (fence) {
    uncertainCommand = raw;
    void raw
      .finally(() => {
        if (uncertainCommand === raw) uncertainCommand = undefined;
      })
      .catch(() => undefined);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
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
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One bounded reload workflow for explicit actions and automatic recovery. */
export function reloadExtensionHostWithSessionCapture(autoResume: boolean, clearNotifications = false): Promise<void> {
  if (inFlight) return inFlight;
  if (uncertainCommand)
    return Promise.reject(new Error("A previous VS Code reload command is still pending. Retry after it settles."));
  const work = (async () => {
    const deadline = Date.now() + 45_000;
    try {
      await command("codexManager.prepareDashboardForExtensionHostRestart", 35_000, [
        { autoResume: autoResume || getCodexManagerConfiguration().get<boolean>("autoResumeEnabled", false) }
      ]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Codex Manager could not preserve sessions before restarting: ${detail}`);
    }
    if (clearNotifications) {
      try {
        await command("notifications.clearAll", 2_000, [], false);
      } catch (error) {
        console.warn("[codexManager] could not clear VS Code notifications before reload", error);
      }
    }
    try {
      await command("workbench.action.restartExtensionHost", deadline - Date.now());
    } catch (error) {
      // A timed-out command may already have restarted VS Code. Never issue a
      // second restart while its acknowledgement has an uncertain outcome.
      if (error instanceof ReloadCommandTimeoutError) throw error;
      console.warn("[codexManager] extension host restart failed; reloading the window", error);
      await command("workbench.action.reloadWindow", deadline - Date.now());
    }
  })();
  inFlight = work;
  void work
    .finally(() => {
      if (inFlight === work) inFlight = undefined;
    })
    .catch(() => undefined);
  return work;
}
