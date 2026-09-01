import { describe, expect, it } from "vitest";
import {
  compareCodexManagerAccountAutoQueueOrder,
  getCodexManagerAccountAutoQueueEfficiency,
  hasCodexManagerAccountAutoQueueCapability
} from "../src/application/accounts/autoQueueOrder";
import type { CodexManagerAccountRecord } from "../src/core/types";

describe("auto queue order", () => {
  it("scores quota near reset while protecting scarce weekly capacity", () => {
    const nowMs = 2_000_000_000_000;
    const expiring = account("expiring", { hourly: 70, hourlyResetAt: nowMs / 1_000 + 15 * 60, weekly: 75, weeklyResetAt: nowMs / 1_000 + 5 * 86400, lastQuotaAt: nowMs - 60_000 });
    const scarce = account("scarce", { hourly: 95, hourlyResetAt: nowMs / 1_000 + 4 * 3600, weekly: 22, weeklyResetAt: nowMs / 1_000 + 5 * 86400, lastQuotaAt: nowMs - 60_000 });
    expect(compareCodexManagerAccountAutoQueueOrder(expiring, scarce, { nowMs, staleAfterMs: 30 * 60_000 })).toBeLessThan(0);
    expect(getCodexManagerAccountAutoQueueEfficiency(expiring, { nowMs, staleAfterMs: 30 * 60_000 }).reason).toBe("quota-expiring");
  });

  it("lowers confidence for old snapshots without requesting new data", () => {
    const nowMs = 2_000_000_000_000;
    const fresh = account("fresh", { hourly: 70, weekly: 70, lastQuotaAt: nowMs - 60_000 });
    const stale = account("stale", { hourly: 70, weekly: 70, lastQuotaAt: nowMs - 60 * 60_000 });
    expect(getCodexManagerAccountAutoQueueEfficiency(fresh, { nowMs, staleAfterMs: 30 * 60_000 }).freshness).toBeGreaterThan(getCodexManagerAccountAutoQueueEfficiency(stale, { nowMs, staleAfterMs: 30 * 60_000 }).freshness);
    expect(getCodexManagerAccountAutoQueueEfficiency(stale, { nowMs, staleAfterMs: 30 * 60_000 }).reason).toBe("stale-data");
  });
  it("keeps starred accounts ahead of non-urgent automatic criteria", () => {
    const starred = account("starred", { hourly: 10, weekly: 10, queuePriority: true });
    const unstarred = account("unstarred", { hourly: 100, weekly: 100 });

    expect(sortedIds(unstarred, starred)).toEqual(["starred", "unstarred"]);
  });

  it("puts a 5-hour reset within 20 minutes ahead of a starred account", () => {
    const now = Date.now() / 1_000;
    const urgent = account("urgent", { hourly: 30, hourlyResetAt: now + 20 * 60, weekly: 60 });
    const starred = account("starred", {
      hourly: 100,
      hourlyResetAt: now + 60 * 60,
      weekly: 100,
      queuePriority: true
    });

    expect(sortedIds(starred, urgent)).toEqual(["urgent", "starred"]);
    expect(urgent.queuePriority).not.toBe(true);
  });

  it("uses the configured urgency thresholds for weekly, monthly, and subscription expiry", () => {
    const nowSeconds = Date.now() / 1_000;
    const nowMs = nowSeconds * 1_000;
    const starred = account("starred", {
      hourly: 100,
      hourlyResetAt: nowSeconds + 60 * 60,
      weekly: 100,
      weeklyResetAt: nowSeconds + 24 * 60 * 60,
      subscriptionExpiresAt: nowMs + 7 * 24 * 60 * 60 * 1_000,
      queuePriority: true
    });
    const urgentWeekly = account("urgent-weekly", {
      hourly: 80,
      hourlyResetAt: nowSeconds + 60 * 60,
      weekly: 80,
      weeklyResetAt: nowSeconds + 3 * 60 * 60
    });
    const urgentMonthly = account("urgent-monthly", {
      hourlyPresent: false,
      monthly: 80,
      weeklyResetAt: nowSeconds + 24 * 60 * 60,
      planType: "free"
    });
    const urgentSubscription = account("urgent-subscription", {
      hourly: 80,
      hourlyResetAt: nowSeconds + 60 * 60,
      weekly: 80,
      weeklyResetAt: nowSeconds + 24 * 60 * 60,
      subscriptionExpiresAt: nowMs + 24 * 60 * 60 * 1_000
    });

    expect(sortedIds(starred, urgentWeekly)[0]).toBe("urgent-weekly");
    expect(sortedIds(starred, urgentMonthly)[0]).toBe("urgent-monthly");
    expect(sortedIds(starred, urgentSubscription)[0]).toBe("urgent-subscription");
  });

  it("does not prioritize a starred account with no quota or credits", () => {
    const emptyStarred = account("empty-starred", { hourly: 0, weekly: 0, queuePriority: true });
    const capable = account("capable", { hourly: 50, weekly: 50 });

    expect(sortedIds(emptyStarred, capable)).toEqual(["capable", "empty-starred"]);
  });

  it("treats an account with either primary quota exhausted as incapable, even with credits", () => {
    const exhaustedWeekly = account("exhausted-weekly", { hourly: 100, weekly: 0, credits: "20" });

    expect(hasCodexManagerAccountAutoQueueCapability(exhaustedWeekly)).toBe(false);
  });

  it("uses automatic-switch thresholds instead of merely checking for quota above zero", () => {
    const belowWeeklySwitchLimit = account("below-weekly-limit", { hourly: 90, weekly: 10 });
    const aboveWeeklySwitchLimit = account("above-weekly-limit", { hourly: 90, weekly: 25 });
    const thresholds = { hourlyEnabled: false, hourlyThreshold: 20, weeklyThreshold: 20 };

    expect(hasCodexManagerAccountAutoQueueCapability(belowWeeklySwitchLimit, thresholds)).toBe(false);
    expect(hasCodexManagerAccountAutoQueueCapability(aboveWeeklySwitchLimit, thresholds)).toBe(true);
  });

  it("uses each window reset time before its percentage", () => {
    const renewsSooner = account("renews-sooner", {
      hourly: 80,
      hourlyResetAt: 1_000,
      weekly: 20
    });
    const renewsLater = account("renews-later", {
      hourly: 80,
      hourlyResetAt: 2_000,
      weekly: 100
    });

    expect(sortedIds(renewsLater, renewsSooner)).toEqual(["renews-sooner", "renews-later"]);
  });

  it("uses percentage after reset time ties within each 5h, weekly, and monthly window", () => {
    const higherHourly = account("higher-hourly", { hourly: 90, hourlyResetAt: 1_000, weekly: 20 });
    const lowerHourly = account("lower-hourly", { hourly: 80, hourlyResetAt: 1_000, weekly: 100 });
    expect(sortedIds(lowerHourly, higherHourly)).toEqual(["higher-hourly", "lower-hourly"]);

    const higherWeekly = account("higher-weekly", {
      hourly: 80,
      hourlyResetAt: 1_000,
      weekly: 90,
      weeklyResetAt: 2_000
    });
    const lowerWeekly = account("lower-weekly", {
      hourly: 80,
      hourlyResetAt: 1_000,
      weekly: 70,
      weeklyResetAt: 2_000
    });
    expect(sortedIds(lowerWeekly, higherWeekly)).toEqual(["higher-weekly", "lower-weekly"]);
  });

  it("skips a missing value and continues to the next criterion", () => {
    const missingHourlyReset = account("missing-reset", { hourly: 80, weekly: 90 });
    const knownHourlyReset = account("known-reset", {
      hourly: 80,
      hourlyResetAt: 1_000,
      weekly: 40
    });

    expect(sortedIds(knownHourlyReset, missingHourlyReset)).toEqual(["missing-reset", "known-reset"]);
  });

  it("orders monthly quota by remaining amount and then days until reset", () => {
    const renewsSooner = account("monthly-sooner", {
      hourlyPresent: false,
      monthly: 70,
      weeklyResetAt: 2_000,
      planType: "free"
    });
    const renewsLater = account("monthly-later", {
      hourlyPresent: false,
      monthly: 70,
      weeklyResetAt: 3_000,
      planType: "free"
    });

    expect(sortedIds(renewsLater, renewsSooner)).toEqual(["monthly-sooner", "monthly-later"]);
  });

  it("uses credits before the earliest subscription expiry", () => {
    const moreCredits = account("more-credits", {
      hourly: 80,
      weekly: 90,
      credits: "20",
      subscriptionExpiresAt: 3_000
    });
    const expiresSooner = account("expires-sooner", {
      hourly: 80,
      weekly: 90,
      credits: "5",
      subscriptionExpiresAt: 1_000
    });

    expect(sortedIds(expiresSooner, moreCredits)).toEqual(["more-credits", "expires-sooner"]);
  });

  it("uses the earliest subscription expiry after all earlier criteria tie", () => {
    const sooner = account("sooner", { hourly: 80, weekly: 90, subscriptionExpiresAt: 1_000 });
    const later = account("later", { hourly: 80, weekly: 90, subscriptionExpiresAt: 2_000 });

    expect(sortedIds(later, sooner)).toEqual(["sooner", "later"]);
  });
});

type AccountOptions = {
  hourly?: number;
  hourlyPresent?: boolean;
  hourlyResetAt?: number;
  weekly?: number;
  monthly?: number;
  weeklyResetAt?: number;
  credits?: string;
  subscriptionExpiresAt?: number;
  planType?: string;
  queuePriority?: boolean;
  lastQuotaAt?: number;
};

function account(id: string, options: AccountOptions): CodexManagerAccountRecord {
  const longQuota = options.monthly ?? options.weekly;
  return {
    id,
    email: `${id}@example.com`,
    isActive: false,
    createdAt: 1,
    updatedAt: 1,
    planType: options.planType,
    queuePriority: options.queuePriority,
    lastQuotaAt: options.lastQuotaAt,
    subscriptionActiveUntil:
      options.subscriptionExpiresAt === undefined ? undefined : String(options.subscriptionExpiresAt / 1_000),
    quotaSummary: {
      hourlyPercentage: options.hourly,
      hourlyResetTime: options.hourlyResetAt,
      hourlyWindowMinutes: 300,
      hourlyWindowPresent: options.hourlyPresent ?? options.hourly !== undefined,
      weeklyPercentage: longQuota,
      weeklyResetTime: options.weeklyResetAt,
      weeklyWindowMinutes: options.monthly === undefined ? 10_080 : 43_200,
      weeklyWindowPresent: longQuota !== undefined,
      credits:
        options.credits === undefined
          ? undefined
          : {
              hasCredits: true,
              unlimited: false,
              overageLimitReached: false,
              balance: options.credits,
              approxLocalMessages: [],
              approxCloudMessages: []
            }
    }
  };
}

function sortedIds(...accounts: CodexManagerAccountRecord[]): string[] {
  return accounts.sort(compareCodexManagerAccountAutoQueueOrder).map((item) => item.id);
}
