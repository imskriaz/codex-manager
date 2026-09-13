import * as crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import * as vscode from "vscode";

export type MirroredNotificationLevel = "info" | "warning" | "error";

export interface MirroredNotification {
  notificationId?: string;
  level: MirroredNotificationLevel;
  message: string;
  actions?: string[];
}

type NotificationListener = (notification: MirroredNotification) => void;
type NotificationResolutionListener = (notificationId: string) => void;
type NotificationMethod = (...args: unknown[]) => Thenable<unknown>;

const listeners = new Set<NotificationListener>();
const resolutionListeners = new Set<NotificationResolutionListener>();
const pendingResponses = new Map<string, (action?: string) => void>();
const commandNotificationContext = new AsyncLocalStorage<boolean>();
const TRANSIENT_NOTICE_DURATION_MS = 10_000;
let installed = false;
let transientNoticeUsers = 0;
let activeStatusMessage: vscode.Disposable | undefined;
let pendingNativeChoices = 0;
let latestChoiceGeneration = 0;
let originals: {
  info: NotificationMethod;
  warning: NotificationMethod;
  error: NotificationMethod;
} | undefined;

export function subscribeToVscodeNotifications(listener: NotificationListener): vscode.Disposable {
  listeners.add(listener);
  install();
  return {
    dispose: () => {
      listeners.delete(listener);
      if (listeners.size === 0 && transientNoticeUsers === 0) uninstall();
    }
  };
}

/** Show passive extension notices discreetly; actionable prompts remain native. */
export function enableTransientVscodeNotices(): vscode.Disposable {
  transientNoticeUsers += 1;
  install();
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      transientNoticeUsers -= 1;
      if (transientNoticeUsers === 0) {
        activeStatusMessage?.dispose();
        activeStatusMessage = undefined;
        if (listeners.size === 0) uninstall();
      }
    }
  };
}

/** Command Palette warnings can be the only visible failure result. */
export function runWithNativeCommandWarnings<T>(task: () => T): T {
  return commandNotificationContext.run(true, task);
}

export function resolveMirroredNotification(notificationId: string, action?: string): boolean {
  const resolve = pendingResponses.get(notificationId);
  if (!resolve) return false;
  pendingResponses.delete(notificationId);
  resolve(action);
  return true;
}

export function subscribeToVscodeNotificationResolutions(listener: NotificationResolutionListener): vscode.Disposable {
  resolutionListeners.add(listener);
  return { dispose: () => resolutionListeners.delete(listener) };
}

function install(): void {
  if (installed) return;
  const windowApi = vscode.window as typeof vscode.window;
  originals = {
    info: windowApi.showInformationMessage as unknown as NotificationMethod,
    warning: windowApi.showWarningMessage as unknown as NotificationMethod,
    error: windowApi.showErrorMessage as unknown as NotificationMethod
  };
  windowApi.showInformationMessage = wrap("info", originals.info) as typeof windowApi.showInformationMessage;
  windowApi.showWarningMessage = wrap("warning", originals.warning) as typeof windowApi.showWarningMessage;
  windowApi.showErrorMessage = wrap("error", originals.error) as typeof windowApi.showErrorMessage;
  installed = true;
}

function uninstall(): void {
  if (!installed || !originals) return;
  const windowApi = vscode.window as typeof vscode.window;
  windowApi.showInformationMessage = originals.info as typeof windowApi.showInformationMessage;
  windowApi.showWarningMessage = originals.warning as typeof windowApi.showWarningMessage;
  windowApi.showErrorMessage = originals.error as typeof windowApi.showErrorMessage;
  originals = undefined;
  installed = false;
  pendingResponses.clear();
  activeStatusMessage?.dispose();
  activeStatusMessage = undefined;
}

function wrap(level: MirroredNotificationLevel, original: NotificationMethod): NotificationMethod {
  return (...args: unknown[]) => {
    const message = extractMessage(args[0]);
    const actions = extractActions(args);
    if (!message) return original.apply(vscode.window, args);

    const notificationId = listeners.size > 0 && actions.length > 0 ? crypto.randomUUID() : undefined;
    if (listeners.size) {
      const notification: MirroredNotification = { notificationId, level, message, ...(actions.length ? { actions } : {}) };
      for (const listener of listeners) {
        try {
          listener(notification);
        } catch (error) {
          console.warn("[codexManager] notification mirror listener failed", error);
        }
      }
    }

    // VS Code does not expose a handle for closing native message pop-ups. A
    // status-bar message can be replaced and disposed without clearing notices
    // from VS Code itself or from other extensions.
    if (transientNoticeUsers && level !== "error" && args.length === 1 &&
        !(level === "warning" && commandNotificationContext.getStore())) {
      try {
        activeStatusMessage?.dispose();
        activeStatusMessage = vscode.window.setStatusBarMessage(
          `${level === "warning" ? "$(warning)" : "$(info)"} Codex Manager: ${message}`,
          TRANSIENT_NOTICE_DURATION_MS
        );
        return Promise.resolve(undefined);
      } catch (error) {
        console.warn("[codexManager] transient notice failed; using native notification", error);
      }
    }

    if (transientNoticeUsers) {
      activeStatusMessage?.dispose();
      activeStatusMessage = undefined;
    }

    const nativeResult = actions.length && transientNoticeUsers
      ? showLatestNativeChoice(original, args)
      : Promise.resolve(original.apply(vscode.window, args));
    if (!notificationId) return nativeResult;
    const mirroredNativeResult = nativeResult.finally(() => {
      for (const listener of resolutionListeners) {
        try {
          listener(notificationId);
        } catch (error) {
          console.warn("[codexManager] notification resolution listener failed", error);
        }
      }
    });
    const browserResult = new Promise<string | undefined>((resolve) => {
      pendingResponses.set(notificationId, resolve);
    });
    return Promise.race([mirroredNativeResult, browserResult.then((action) => actions.find((candidate) => candidate === action))]).finally(
      () => pendingResponses.delete(notificationId)
    );
  };
}

function showLatestNativeChoice(original: NotificationMethod, args: unknown[]): Promise<unknown> {
  const generation = ++latestChoiceGeneration;
  const replacePrevious = pendingNativeChoices > 0;
  pendingNativeChoices += 1;
  return (replacePrevious
    ? Promise.resolve().then(() => vscode.commands.executeCommand("notifications.clearAll")).catch((error: unknown) => {
        console.warn("[codexManager] could not replace the previous VS Code choice", error);
      })
    : Promise.resolve()
  )
    .then(() => generation === latestChoiceGeneration ? original.apply(vscode.window, args) : undefined)
    .finally(() => {
      pendingNativeChoices -= 1;
    });
}

function extractMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object" && "value" in value && typeof value.value === "string") {
    return value.value.trim() || undefined;
  }
  return undefined;
}

function extractActions(args: readonly unknown[]): string[] {
  return args
    .slice(1)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}
