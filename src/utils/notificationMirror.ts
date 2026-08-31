import * as crypto from "crypto";
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
let installed = false;
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
      if (listeners.size === 0) uninstall();
    }
  };
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
}

function wrap(level: MirroredNotificationLevel, original: NotificationMethod): NotificationMethod {
  return (...args: unknown[]) => {
    const message = extractMessage(args[0]);
    const actions = extractActions(args);
    if (!message || listeners.size === 0) return original.apply(vscode.window, args);

    const notificationId = actions.length ? crypto.randomUUID() : undefined;
    const notification: MirroredNotification = { notificationId, level, message, ...(actions.length ? { actions } : {}) };
    for (const listener of listeners) {
      try {
        listener(notification);
      } catch (error) {
        console.warn("[codexManager] notification mirror listener failed", error);
      }
    }

    if (!notificationId) return original.apply(vscode.window, args);
    const nativeResult = Promise.resolve(original.apply(vscode.window, args)).finally(() => {
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
    return Promise.race([nativeResult, browserResult.then((action) => actions.find((candidate) => candidate === action))]).finally(
      () => pendingResponses.delete(notificationId)
    );
  };
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
