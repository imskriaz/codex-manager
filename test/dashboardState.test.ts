import { describe, expect, it } from "vitest";
import {
  buildMetrics,
  resolveTerminalNotice,
  resolveDashboardQueuedSwitch,
  sortDashboardAccounts
} from "../src/application/dashboard/buildDashboardState";
import { formatPlanType, getDashboardCopy } from "../src/application/dashboard/copy";

describe("sortDashboardAccounts", () => {
  it("puts the current window account before active accounts", () => {
    const accounts = [
      { id: "active", isActive: true, createdAt: 3, email: "active@example.com" },
      { id: "current", isActive: false, createdAt: 2, email: "current@example.com" },
      { id: "other", isActive: false, createdAt: 1, email: "other@example.com" }
    ];

    const sorted = sortDashboardAccounts(accounts, "current");

    expect(sorted.map((account) => account.id)).toEqual(["current", "active", "other"]);
  });
});

describe("resolveDashboardQueuedSwitch", () => {
  it("ignores a queue without a known previous window account", () => {
    expect(
      resolveDashboardQueuedSwitch(
        [{ id: "selected" }],
        { toAccountId: "selected", queuedAt: 1 }
      )
    ).toBeUndefined();
  });

  it("keeps a queue only when both the previous and selected accounts exist", () => {
    const queuedSwitch = { fromAccountId: "previous", toAccountId: "selected", queuedAt: 1 };

    expect(resolveDashboardQueuedSwitch([{ id: "previous" }, { id: "selected" }], queuedSwitch)).toBe(
      queuedSwitch
    );
    expect(resolveDashboardQueuedSwitch([{ id: "selected" }], queuedSwitch)).toBeUndefined();
  });
});

describe("resolveTerminalNotice", () => {
  it("explains how to recover a chat after an automatic reload", () => {
    const notice = resolveTerminalNotice(
      {
        level: "info",
        message: "Switched to next@example.com and reloaded.",
        createdAt: 123,
        accountId: "next",
        switchResult: "switched-and-reloaded"
      },
      {
        id: "next",
        email: "next@example.com",
        isActive: true,
        createdAt: 1,
        updatedAt: 1
      } as never,
      getDashboardCopy("en")
    );

    expect(notice?.message).toMatch(/resume it from Sessions/i);
  });
});

describe("formatPlanType", () => {
  it("normalizes raw ChatGPT plan identifiers", () => {
    expect(formatPlanType("chatgptteamplan", "zh")).toBe("Team");
    expect(formatPlanType("chatgptplusplan", "zh")).toBe("Plus");
  });
});

describe("buildMetrics", () => {
  it("labels a Free 30-day quota as monthly", () => {
    const metrics = buildMetrics(
      {
        id: "free-account",
        email: "free@example.com",
        isActive: true,
        planType: "chatgptfreeplan",
        createdAt: 1,
        updatedAt: 1,
        quotaSummary: {
          hourlyPercentage: 0,
          weeklyPercentage: 1,
          weeklyWindowMinutes: 43_200,
          weeklyWindowPresent: true
        }
      },
      getDashboardCopy("zh"),
      "zh"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.label).toBe("每月");
  });

  it("does not pass provider reserve quota into the dashboard UI", () => {
    const metrics = buildMetrics(
      {
        id: "plus-account",
        email: "plus@example.com",
        isActive: true,
        planType: "plus",
        createdAt: 1,
        updatedAt: 1,
        quotaSummary: {
          weeklyPercentage: 80,
          weeklyWindowPresent: true,
          additionalRateLimits: [
            {
              limitName: "gpt-reserve",
              weeklyPercentage: 100,
              weeklyWindowPresent: true
            },
            {
              limitName: "Spark",
              weeklyPercentage: 60,
              weeklyWindowPresent: true
            }
          ]
        }
      },
      getDashboardCopy("en"),
      "en"
    );

    expect(metrics.map((metric) => metric.label)).toEqual(["5h", "Weekly", "Spark Weekly"]);
  });
});
