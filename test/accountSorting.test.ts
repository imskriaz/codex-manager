import { describe, expect, it } from "vitest";
import {
  compareDashboardAutoQueueAccounts,
  hasDashboardAutoQueueCapability,
  sortWithQueuedAccount
} from "../webview-src/dashboard/accountSorting";

describe("sortWithQueuedAccount", () => {
  it("keeps a queued switch immediately after the active account", () => {
    const accounts = [
      { id: "healthy", isActive: false, switchQueued: false },
      { id: "queued", isActive: false, switchQueued: true },
      { id: "active", isActive: true, switchQueued: false }
    ] as any;

    const sorted = sortWithQueuedAccount(accounts, (left, right) => left.id.localeCompare(right.id));

    expect(sorted.map((account) => account.id)).toEqual(["active", "queued", "healthy"]);
  });
});

describe("compareDashboardAutoQueueAccounts", () => {
  it("puts a capable starred account ahead of quota balance ordering", () => {
    const base = {
      isActive: false,
      switchQueued: false,
      creditsUnlimited: false,
      subscriptionExpiresAt: 1_000,
      lastQuotaAt: 1
    };
    const unstarred = {
      ...base,
      id: "unstarred",
      queuePriority: false,
      creditsBalance: 20,
      metrics: [{ key: "hourly", period: "hourly", percentage: 100, visible: true }]
    } as any;
    const starred = {
      ...base,
      id: "starred",
      queuePriority: true,
      creditsBalance: 1,
      metrics: [{ key: "hourly", period: "hourly", percentage: 10, visible: true }]
    } as any;

    expect([unstarred, starred].sort(compareDashboardAutoQueueAccounts).map((item) => item.id)).toEqual([
      "starred",
      "unstarred"
    ]);
  });

  it("keeps dashboard ordering aligned with quota reset and credit ordering", () => {
    const base = {
      isActive: false,
      switchQueued: false,
      creditsUnlimited: false,
      subscriptionExpiresAt: 1_000,
      lastQuotaAt: 1
    };
    const lowerCredits = {
      ...base,
      id: "lower-credits",
      creditsBalance: 5,
      metrics: [
        { key: "hourly", period: "hourly", percentage: 80, resetAt: 100, visible: true },
        { key: "weekly", period: "weekly", percentage: 90, resetAt: 200, visible: true }
      ]
    } as any;
    const higherCredits = {
      ...base,
      id: "higher-credits",
      creditsBalance: 20,
      metrics: lowerCredits.metrics
    } as any;

    expect([lowerCredits, higherCredits].sort(compareDashboardAutoQueueAccounts).map((item) => item.id)).toEqual([
      "higher-credits",
      "lower-credits"
    ]);
  });

  it("does not treat a zero-quota, zero-credit account as capable", () => {
    const account = {
      creditsBalance: 0,
      creditsUnlimited: false,
      metrics: [{ key: "hourly", period: "hourly", percentage: 0, visible: true }]
    } as any;

    expect(hasDashboardAutoQueueCapability(account)).toBe(false);
  });

  it("treats an account with either primary quota exhausted as incapable, even with credits", () => {
    const account = {
      creditsBalance: 25,
      creditsUnlimited: false,
      metrics: [
        { key: "hourly", period: "hourly", percentage: 100, visible: true },
        { key: "weekly", period: "weekly", percentage: 0, visible: true }
      ]
    } as any;

    expect(hasDashboardAutoQueueCapability(account)).toBe(false);
  });

  it("matches capability to the automatic-switch thresholds", () => {
    const account = {
      creditsBalance: 25,
      creditsUnlimited: false,
      metrics: [
        { key: "hourly", period: "hourly", percentage: 5, visible: true },
        { key: "weekly", period: "weekly", percentage: 15, visible: true }
      ]
    } as any;

    expect(hasDashboardAutoQueueCapability(account, {
      hourlyEnabled: false,
      hourlyThreshold: 20,
      weeklyThreshold: 20
    })).toBe(false);
    account.metrics[1].percentage = 25;
    expect(hasDashboardAutoQueueCapability(account, {
      hourlyEnabled: false,
      hourlyThreshold: 20,
      weeklyThreshold: 20
    })).toBe(true);
  });
});
