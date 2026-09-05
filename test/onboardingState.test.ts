import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { DashboardState } from "../src/domain/dashboard/types";
import {
  markOnboardingCompleted,
  ONBOARDING_COMPLETED_KEY,
  resolveOnboardingCompleted
} from "../src/services/onboarding";

function createContext(stored?: boolean) {
  return {
    globalState: {
      get: vi.fn(() => stored),
      update: vi.fn(async () => undefined)
    }
  } as unknown as vscode.ExtensionContext;
}

function createState(established: boolean) {
  return {
    accounts: established ? [{ id: "existing-account" }] : [],
    settings: {
      encryptedSyncEnabled: false,
      webDashboardEnabled: false,
      cloudflaredDomain: ""
    }
  } as unknown as Pick<DashboardState, "accounts" | "settings">;
}

describe("durable onboarding completion", () => {
  it("does not treat default-on sync as completed first-run setup", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      inspect: () => ({ defaultValue: true })
    } as never);
    const context = createContext();
    const state = createState(false);
    state.settings.encryptedSyncEnabled = true;
    await expect(resolveOnboardingCompleted(context, state)).resolves.toBe(false);
    expect(context.globalState.update).not.toHaveBeenCalled();
  });

  it("still recognizes sync explicitly enabled by an established install", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      inspect: () => ({ defaultValue: true, globalValue: true })
    } as never);
    const context = createContext();
    const state = createState(false);
    state.settings.encryptedSyncEnabled = true;
    await expect(resolveOnboardingCompleted(context, state)).resolves.toBe(true);
  });
  it("honors a completion marker stored in extension global state", async () => {
    const context = createContext(true);

    await expect(resolveOnboardingCompleted(context, createState(false))).resolves.toBe(true);
    expect(context.globalState.update).not.toHaveBeenCalled();
  });

  it("migrates established installations so an extension update does not reopen onboarding", async () => {
    const context = createContext();

    await expect(resolveOnboardingCompleted(context, createState(true))).resolves.toBe(true);
    expect(context.globalState.update).toHaveBeenCalledWith(ONBOARDING_COMPLETED_KEY, true);
  });

  it("keeps onboarding available for a genuinely fresh installation", async () => {
    const context = createContext();

    await expect(resolveOnboardingCompleted(context, createState(false))).resolves.toBe(false);
    expect(context.globalState.update).not.toHaveBeenCalled();
  });

  it("persists explicit completion", async () => {
    const context = createContext();

    await markOnboardingCompleted(context);
    expect(context.globalState.update).toHaveBeenCalledWith(ONBOARDING_COMPLETED_KEY, true);
  });
});
