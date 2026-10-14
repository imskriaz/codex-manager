import { AsyncLocalStorage } from "async_hooks";
import * as vscode from "vscode";
import type { DashboardActionPrompt, DashboardNotice } from "../domain/dashboard/types";

type DashboardActionContext = {
  prompts: DashboardActionPrompt[];
  collectPrompts: boolean;
  notices: DashboardNotice[];
};
const dashboardActionContext = new AsyncLocalStorage<DashboardActionContext>();
let suppressionUsers = 0;
let restoreNotifications: (() => void) | undefined;

/** Run a dashboard request without duplicating its terminal result as a VS Code toast. */
export function withDashboardNotificationSuppression<T>(
  task: () => Promise<T>,
  options: { collectPrompts?: boolean } = {}
): Promise<T> {
  if (suppressionUsers++ === 0) installSuppression();
  return dashboardActionContext.run({ prompts: [], notices: [], collectPrompts: options.collectPrompts !== false }, async () => task()).finally(() => {
    if (--suppressionUsers === 0) {
      restoreNotifications?.();
      restoreNotifications = undefined;
    }
  });
}

function installSuppression(): void {
  const windowApi = vscode.window as typeof vscode.window;
  const originalInfo = windowApi.showInformationMessage;
  const originalWarning = windowApi.showWarningMessage;
  const originalError = windowApi.showErrorMessage;
  const hasAction = (args: unknown[]): boolean =>
    args.slice(1).some((arg) => typeof arg === "string" || (typeof arg === "object" && arg !== null && "title" in arg));
  const suppress = (level: DashboardNotice["level"], args: unknown[]): boolean => {
    const context = dashboardActionContext.getStore();
    if (!context || hasAction(args)) return false;
    if (typeof args[0] === "string") context.notices.push({ level, message: args[0] });
    return true;
  };
  windowApi.showInformationMessage = ((...args: unknown[]) =>
    suppress("info", args) ? Promise.resolve(undefined) : originalInfo.apply(windowApi, args as never)) as typeof originalInfo;
  windowApi.showWarningMessage = ((...args: unknown[]) =>
    suppress("warning", args) ? Promise.resolve(undefined) : originalWarning.apply(windowApi, args as never)) as typeof originalWarning;
  windowApi.showErrorMessage = ((...args: unknown[]) =>
    suppress("error", args) ? Promise.resolve(undefined) : originalError.apply(windowApi, args as never)) as typeof originalError;
  restoreNotifications = () => {
    windowApi.showInformationMessage = originalInfo;
    windowApi.showWarningMessage = originalWarning;
    windowApi.showErrorMessage = originalError;
  };
}

/** Keep suppressed command feedback attached to its initiating dashboard action. */
export function consumeDashboardActionNotice(): DashboardNotice | undefined {
  const context = dashboardActionContext.getStore();
  if (!context?.notices.length) return undefined;
  const notices = context.notices.splice(0);
  const level = notices.some(notice => notice.level === "error") ? "error"
    : notices.some(notice => notice.level === "warning") ? "warning" : "info";
  return { level, message: [...new Set(notices.filter(notice => notice.level === level).map(notice => notice.message))].join(" ") };
}

export function shouldSuppressDashboardNotifications(): boolean {
  return dashboardActionContext.getStore() !== undefined;
}

/** Record a choice prompt for the dashboard host instead of opening native UI. */
export function recordDashboardActionPrompt(prompt: DashboardActionPrompt): boolean {
  const context = dashboardActionContext.getStore();
  if (!context?.collectPrompts) return false;
  context.prompts.push(prompt);
  return true;
}

/** Consume prompts while still inside the suppression context. */
export function consumeDashboardActionPrompts(): DashboardActionPrompt[] {
  const context = dashboardActionContext.getStore();
  if (!context) return [];
  const prompts = context.prompts.slice();
  context.prompts.length = 0;
  return prompts;
}
