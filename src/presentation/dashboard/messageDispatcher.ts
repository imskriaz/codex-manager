import * as vscode from "vscode";
import type { DashboardClientMessage, DashboardSettingKey, DashboardUsageSample } from "../../domain/dashboard/types";
import { runWithPersistentOperation } from "../../utils/persistentLog";

export type DashboardMessageHandlers = {
  onReady: () => void | Promise<void>;
  onAction: (message: Extract<DashboardClientMessage, { type: "dashboard:action" }>) => Promise<void>;
  onSetting: (key: DashboardSettingKey, value: string | number | boolean) => Promise<void>;
  onPickCodexAppPath: () => Promise<void>;
  onClearCodexAppPath: () => Promise<void>;
  onPickCodexCliPath: () => Promise<void>;
  onClearCodexCliPath: () => Promise<void>;
  onUsageHistory: (samples: DashboardUsageSample[]) => Promise<void>;
};

export async function dispatchDashboardClientMessage(
  message: DashboardClientMessage,
  handlers: DashboardMessageHandlers
): Promise<void> {
  await runWithPersistentOperation(
    describeDashboardMessage(message),
    () => dispatchDashboardClientMessageCore(message, handlers),
    { messageType: message.type }
  );
}

async function dispatchDashboardClientMessageCore(
  message: DashboardClientMessage,
  handlers: DashboardMessageHandlers
): Promise<void> {
  switch (message.type) {
    case "dashboard:ready":
      await handlers.onReady();
      return;
    case "dashboard:action":
      await handlers.onAction(message);
      return;
    case "dashboard:setting":
      await handlers.onSetting(message.key, message.value);
      return;
    case "dashboard:pickCodexAppPath":
      await handlers.onPickCodexAppPath();
      return;
    case "dashboard:clearCodexAppPath":
      await handlers.onClearCodexAppPath();
      return;
    case "dashboard:pickCodexCliPath":
      await handlers.onPickCodexCliPath();
      return;
    case "dashboard:clearCodexCliPath":
      await handlers.onClearCodexCliPath();
      return;
    case "dashboard:usage-history":
      await handlers.onUsageHistory(message.samples);
      return;
    default:
      throw new Error("Unsupported dashboard request.");
  }
}

function describeDashboardMessage(message: DashboardClientMessage): string {
  if (message.type === "dashboard:action") {
    return `dashboard-message:action:${message.action}`;
  }
  if (message.type === "dashboard:setting") {
    return `dashboard-message:setting:${message.key}`;
  }
  return `dashboard-message:${message.type}`;
}

export async function clearDashboardCodexAppPath(): Promise<void> {
  await vscode.workspace.getConfiguration("codexManager").update("codexAppPath", "", vscode.ConfigurationTarget.Global);
}

export async function clearDashboardCodexCliPath(): Promise<void> {
  await vscode.workspace.getConfiguration("codexManager").update("codexCliPath", "", vscode.ConfigurationTarget.Global);
}
