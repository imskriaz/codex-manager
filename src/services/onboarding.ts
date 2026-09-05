import * as vscode from "vscode";
import type { DashboardState } from "../domain/dashboard/types";

export const ONBOARDING_COMPLETED_KEY = "codexManager.onboarding.v1.completed";

export async function resolveOnboardingCompleted(
  context: vscode.ExtensionContext,
  state: Pick<DashboardState, "accounts" | "settings">
): Promise<boolean> {
  const stored = context.globalState.get<boolean>(ONBOARDING_COMPLETED_KEY);
  if (stored !== undefined) return stored;

  // Older releases kept this marker inside the webview, whose storage can be
  // recreated by an extension update. Infer already-established installs once
  // from their durable data, then persist the result in extension globalState.
  const establishedInstallation =
    state.accounts.length > 0 ||
    (state.settings.encryptedSyncEnabled &&
      vscode.workspace.getConfiguration("codexManager").inspect<boolean>("encryptedSyncEnabled")?.globalValue === true) ||
    state.settings.webDashboardEnabled ||
    Boolean(state.settings.cloudflaredDomain?.trim());
  if (establishedInstallation) {
    try {
      await context.globalState.update(ONBOARDING_COMPLETED_KEY, true);
    } catch (error) {
      // Migration is background compatibility work. Keep established users out
      // of onboarding even if VS Code cannot persist the marker on this load.
      console.warn("[codexManager] onboarding completion migration could not be persisted:", error);
    }
  }
  return establishedInstallation;
}

export async function markOnboardingCompleted(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(ONBOARDING_COMPLETED_KEY, true);
}
