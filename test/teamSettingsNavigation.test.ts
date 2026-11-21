import { describe, expect, it } from "vitest";
import { canShowTeamSettings } from "../webview-src/dashboard/settingsOverlay";
import type { DashboardOfficeView, DashboardSettings } from "../src/domain/dashboard/types";
import { isSettingsSectionEnabled, matchesSettingsSearch } from "../webview-src/dashboard/settingsNavigation";

const enabled = { webDashboardEnabled: true, teamWorkspaceEnabled: true } as DashboardSettings;
const admin = { id: "master", role: "unrestricted-admin" } as DashboardOfficeView;

describe("conditional Settings sections", () => {
  it.each([
    ["dashboard", "webDashboardEnabled"], ["sessions", "cliIntegrationEnabled"],
    ["sync", "encryptedSyncEnabled"], ["desktop", "codexAppRestartEnabled"],
    ["usage", "dailyTokenUsageEnabled"], ["system-log", "persistentLoggingEnabled"],
    ["connections", "webSocketServerEnabled"]
  ])("shows %s only when its module is enabled", (section, key) => {
    expect(isSettingsSectionEnabled(section, { [key]: true } as unknown as DashboardSettings, true)).toBe(true);
    expect(isSettingsSectionEnabled(section, { [key]: false } as unknown as DashboardSettings, true)).toBe(false);
  });
  it("searches option text with all words regardless of case or order", () => {
    expect(matchesSettingsSearch("Capacity retry delay seconds", "RETRY capacity")).toBe(true);
    expect(matchesSettingsSearch("Capacity retry delay seconds", "retry database")).toBe(false);
  });
  it("requires Team administration and the API module for proxy activity", () => {
    expect(isSettingsSectionEnabled("proxy", { apiAccessEnabled: true } as DashboardSettings, true)).toBe(true);
    expect(isSettingsSectionEnabled("proxy", { apiAccessEnabled: false } as DashboardSettings, true)).toBe(false);
    expect(isSettingsSectionEnabled("proxy", { apiAccessEnabled: true } as DashboardSettings, false)).toBe(false);
  });
  it("shows the same Team sections to the local VS Code user and browser administrators", () => {
    expect(canShowTeamSettings(enabled)).toBe(true);
    expect(canShowTeamSettings(enabled, admin, true)).toBe(true);
  });
  it.each(["webDashboardEnabled", "teamWorkspaceEnabled"] as const)("hides Team sections when %s is off", key => {
    expect(canShowTeamSettings({ ...enabled, [key]: false })).toBe(false);
    expect(canShowTeamSettings({ ...enabled, [key]: false }, admin, true)).toBe(false);
  });
  it("retains browser authorization and keeps host settings off remote system tabs", () => {
    expect(canShowTeamSettings(enabled, undefined, true)).toBe(false);
    expect(canShowTeamSettings(enabled, { ...admin, role: "user" }, true)).toBe(false);
    expect(canShowTeamSettings(enabled, admin, true, "other-system")).toBe(false);
    expect(canShowTeamSettings(enabled, undefined, false, "other-system")).toBe(false);
  });
});
