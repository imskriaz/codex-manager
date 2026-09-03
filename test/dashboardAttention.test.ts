import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
  countAccountEnablement,
  isAccountAttention,
  isAccountClaimedByAnotherDevice,
  shouldShowAccountCountFilter
} from "../webview-src/dashboard/helpers";
import type { DashboardAccountViewModel } from "../src/domain/dashboard/types";

describe("dashboard attention state", () => {
  it.each(["reauthorize", "refresh_failed", "disabled"] as const)("treats %s as invalid attention", (healthKind) => {
    expect(isAccountAttention(account(healthKind))).toBe(true);
  });

  it("does not put a merely expiring account in the invalid attention list", () => {
    expect(isAccountAttention(account("expiring"))).toBe(false);
  });

  it("does not put quota warnings in the invalid attention list", () => {
    expect(isAccountAttention(account("quota"))).toBe(false);
  });

  it("does not put a dismissed issue in the invalid attention list", () => {
    expect(isAccountAttention(account("disabled", true))).toBe(false);
  });

  it("counts enabled and disabled accounts for the Saved Accounts header", () => {
    expect(
      countAccountEnablement([
        { enabled: true } as DashboardAccountViewModel,
        { enabled: true } as DashboardAccountViewModel,
        { enabled: false } as DashboardAccountViewModel
      ])
    ).toEqual({ enabled: 2, disabled: 1 });

    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(source).toContain('filter: "enabled"');
    expect(source).toContain('filter: "disabled"');
    expect(source).toContain('resolveUiText("enabled", snapshot.lang)');
    expect(source).toContain('resolveUiText("disabled", snapshot.lang)');
    expect(source).toContain('capable: zh ? "配额内" : hant ? "配額內" : "Within quota"');
    expect(source).toContain('incapable: zh ? "超出配额" : hant ? "超出配額" : "Over quota"');
  });

  it("hides account count filters that match the total account count", () => {
    expect(shouldShowAccountCountFilter(12, 12)).toBe(false);
    expect(shouldShowAccountCountFilter(0, 12)).toBe(false);
    expect(shouldShowAccountCountFilter(6, 12)).toBe(true);
  });

  it("shows the claimed filter only for online claims from another device", () => {
    expect(isAccountClaimedByAnotherDevice(accountClaim("Office PC", false, true))).toBe(true);
    expect(isAccountClaimedByAnotherDevice(accountClaim("Office PC", true, true))).toBe(false);
    expect(isAccountClaimedByAnotherDevice(accountClaim("Office PC", false, false))).toBe(false);

    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(source).toContain('filter: "claimed"');
    expect(source).toContain("shouldShowAccountCountFilter(claimedAccountCount, displayedAccounts.length)");
    expect(source).toContain("shouldShowAccountCountFilter(accountEnablement.enabled, displayedAccounts.length)");
    expect(source).toContain("shouldShowAccountCountFilter(accountEnablement.disabled, displayedAccounts.length)");
    expect(source).toContain("shouldShowAccountCountFilter(validAccountCount, displayedAccounts.length)");
    expect(source).toContain("shouldShowAccountCountFilter(invalidAccountCount, displayedAccounts.length)");
    expect(source.indexOf('filter: "claimed"')).toBeGreaterThan(source.indexOf('filter: "disabled"'));
  });
});

function accountClaim(
  runningDeviceName: string,
  runningOnThisDevice: boolean,
  runningDeviceOnline: boolean
): DashboardAccountViewModel {
  return { runningDeviceName, runningOnThisDevice, runningDeviceOnline } as DashboardAccountViewModel;
}

function account(
  healthKind: DashboardAccountViewModel["healthKind"],
  dismissedHealth = false
): DashboardAccountViewModel {
  return { healthKind, dismissedHealth } as DashboardAccountViewModel;
}
