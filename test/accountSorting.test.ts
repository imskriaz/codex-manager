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
  it("ignores exhausted quota until a refresh reports quota after reset", () => {
    const now = Date.now() / 1_000;
    const base = {
      isActive: false,
      switchQueued: false,
      creditsUnlimited: false,
      creditsBalance: 0,
      subscriptionExpiresAt: Date.now() + 7 * 86_400_000,
      lastQuotaAt: Date.now()
    };
    const exhausted = {
      ...base,
      id: "exhausted",
      metrics: [
        { key: "hourly", period: "hourly", percentage: 0, resetAt: now + 6 * 60, visible: true },
        { key: "weekly", period: "weekly", percentage: 53, resetAt: now + 6 * 86_400, visible: true }
      ]
    } as any;
    const full = {
      ...base,
      id: "full",
      metrics: [
        { key: "hourly", period: "hourly", percentage: 100, resetAt: now + 5 * 60 * 60, visible: true },
        { key: "weekly", period: "weekly", percentage: 68, resetAt: now + 6 * 86_400, visible: true }
      ]
    } as any;

    expect([exhausted, full].sort(compareDashboardAutoQueueAccounts).map((item) => item.id)).toEqual([
      "full",
      "exhausted"
    ]);
    exhausted.metrics[0].percentage = 100;
    expect(hasDashboardAutoQueueCapability(exhausted)).toBe(true);
  });

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

  it("puts an urgent 5-hour reset ahead of a starred dashboard account without changing its star", () => {
    const now = Date.now() / 1_000;
    const base = {
      isActive: false,
      switchQueued: false,
      creditsUnlimited: false,
      creditsBalance: 0,
      subscriptionExpiresAt: Date.now() + 7 * 86_400_000,
      lastQuotaAt: 1
    };
    const urgent = {
      ...base,
      id: "urgent",
      queuePriority: false,
      metrics: [{ key: "hourly", period: "hourly", percentage: 30, resetAt: now + 20 * 60, visible: true }]
    } as any;
    const starred = {
      ...base,
      id: "starred",
      queuePriority: true,
      metrics: [{ key: "hourly", period: "hourly", percentage: 100, resetAt: now + 60 * 60, visible: true }]
    } as any;

    expect([starred, urgent].sort(compareDashboardAutoQueueAccounts).map((item) => item.id)).toEqual([
      "urgent",
      "starred"
    ]);
    expect(urgent.queuePriority).toBe(false);
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

  it("requires every enabled main quota window to remain available", () => {
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

  it("keeps an account incapable when its primary 5-hour quota is exhausted", () => {
    const account = {
      creditsBalance: 25,
      creditsUnlimited: false,
      metrics: [
        { key: "hourly", period: "hourly", percentage: 0, visible: true },
        { key: "weekly", period: "weekly", percentage: 100, visible: true }
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

    expect(
      hasDashboardAutoQueueCapability(account, {
        hourlyEnabled: false,
        hourlyThreshold: 20,
        weeklyThreshold: 20
      })
    ).toBe(false);
    account.metrics[1].percentage = 25;
    expect(
      hasDashboardAutoQueueCapability(account, {
        hourlyEnabled: false,
        hourlyThreshold: 20,
        weeklyThreshold: 20
      })
    ).toBe(true);
  });
});
