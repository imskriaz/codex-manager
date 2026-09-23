import { describe, expect, it, vi } from "vitest";

const { needsTokenRefreshMock, refreshTokensMock } = vi.hoisted(() => ({
  needsTokenRefreshMock: vi.fn(),
  refreshTokensMock: vi.fn()
}));

vi.mock("../src/auth/oauth", () => ({
  needsTokenRefresh: needsTokenRefreshMock,
  refreshTokens: refreshTokensMock
}));

import {
  buildDashboardState,
  buildMetrics,
  resolveTerminalNotice,
  resolveDashboardQueuedSwitch,
  sortDashboardAccounts
} from "../src/application/dashboard/buildDashboardState";
import { formatPlanType, getDashboardCopy } from "../src/application/dashboard/copy";

describe("sortDashboardAccounts", () => {
  it("always puts the active Codex account first even when window state is stale", () => {
    const accounts = [
      { id: "active", isActive: true, createdAt: 3, email: "active@example.com" },
      { id: "current", isActive: false, createdAt: 2, email: "current@example.com" },
      { id: "other", isActive: false, createdAt: 1, email: "other@example.com" }
    ];

    const sorted = sortDashboardAccounts(accounts, "current");

    expect(sorted.map((account) => account.id)).toEqual(["active", "current", "other"]);
  });
});

describe("buildDashboardState token recovery", () => {
  it("tries one refresh for an expired access token before rendering reauthorization", async () => {
    needsTokenRefreshMock.mockImplementation((tokens: { accessToken: string }) => tokens.accessToken === "access-1");
    refreshTokensMock.mockResolvedValue({
      idToken: "id-2",
      accessToken: "access-2",
      refreshToken: "refresh-2"
    });

    const account = {
      id: "expired-account",
      email: "expired@example.com",
      isActive: false,
      createdAt: 1,
      updatedAt: 1,
      quotaError: { code: "auth", message: "token expired" }
    };
    const repo = {
      getIndexHealthSummary: vi.fn().mockResolvedValue({ status: "healthy", availableBackups: 0 }),
      listAccounts: vi.fn().mockResolvedValue([account]),
      getTokens: vi.fn().mockResolvedValueOnce({
        idToken: "id-1",
        accessToken: "access-1",
        refreshToken: "refresh-1"
      }).mockResolvedValue({
        idToken: "id-2",
        accessToken: "access-2",
        refreshToken: "refresh-2"
      }),
      updateTokens: vi.fn().mockResolvedValue({ ...account, quotaError: undefined })
    };
    const settingsStore = {
      resolveLanguage: () => "en",
      getDashboardSettings: () => ({ dashboardTheme: "dark", displayLanguage: "en" })
    };

    const first = await buildDashboardState(repo as never, settingsStore as never, "logo", {
      announcements: [],
      unreadIds: []
    });
    const second = await buildDashboardState(repo as never, settingsStore as never, "logo", {
      announcements: [],
      unreadIds: []
    });

    expect(refreshTokensMock).toHaveBeenCalledTimes(1);
    expect(repo.updateTokens).toHaveBeenCalledTimes(1);
    expect(first.accounts[0]?.healthKind).toBe("healthy");
    expect(second.accounts[0]?.healthKind).toBe("healthy");
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
