import { describe, expect, it } from "vitest";
import {
  compareAutoQueueCandidates,
  createAutoQueuePolicy,
  hasAutoQueueCapability,
  isAutoQueueCandidateEligible,
  isAutoQueueResetCandidate,
  isAutoQueueSnapshotFresh,
  shouldKeepCurrentAutoQueueAccount,
  usableAutoQueueResetCount,
  type AutoQueueCandidate
} from "../src/domain/autoQueuePolicy";
import { compareCodexManagerAccountAutoQueueOrder, toAutoQueueOrderValue } from "../src/application/accounts/autoQueueOrder";
import { compareDashboardAutoQueueAccounts } from "../webview-src/dashboard/accountSorting";

const now = 2_000_000_000_000;
const policy = createAutoQueuePolicy({ autoSwitchEnabled: true, autoResetEnabled: true }, now);
const candidate = (id: string, overrides: Partial<AutoQueueCandidate> = {}): AutoQueueCandidate => ({ id, windows: [{ percentage: 70 }, { percentage: 70 }, {}], lastQuotaAt: now - 1_000, ...overrides });

describe("shared auto queue policy", () => {
  it("requires verified capability, timestamps, and post-session quota before selecting", () => {
    for (const overrides of [
      { lastQuotaAt: undefined }, { lastQuotaAt: Number.NaN }, { lastQuotaAt: 0 },
      { lastQuotaAt: now + 1 }, { lastQuotaAt: now - policy.staleAfterMs - 1 },
      { sessionStartedAt: now }, { quotaError: true }, { disabled: true },
      { resetCreditAttempt: true }, { invalidQuota: true }
    ]) expect(isAutoQueueCandidateEligible(candidate("a", overrides), policy)).toBe(false);
    expect(isAutoQueueCandidateEligible(candidate("a"), policy)).toBe(true);
    expect(isAutoQueueSnapshotFresh(candidate("a", { lastQuotaAt: now - policy.staleAfterMs }), policy)).toBe(true);
  });

  it("keeps usable current quota even when future selection is disabled", () => {
    expect(shouldKeepCurrentAutoQueueAccount(candidate("current", { disabled: true }), policy)).toBe(true);
    expect(shouldKeepCurrentAutoQueueAccount(candidate("current", { windows: [{ percentage: 5 }, { percentage: 70 }] }), policy)).toBe(false);
  });

  it("rejects malformed limits and does not revive exhausted quota with credits or resets", () => {
    for (const percentage of [0, -1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hasAutoQueueCapability(candidate("a", { windows: [{ percentage }], credits: Number.POSITIVE_INFINITY }), policy)).toBe(false);
    }
    expect(isAutoQueueCandidateEligible(candidate("a", { windows: [{ percentage: 0 }, { percentage: 0 }], resetCreditsAvailable: 10 }), policy)).toBe(false);
    expect(hasAutoQueueCapability(candidate("hourly-only", { windows: [{ percentage: 70 }] }), policy)).toBe(true);
  });

  it("honors eligible stars before all expiry pressure, but never a stale star", () => {
    const starred = candidate("star", { queuePriority: true, windows: [{ percentage: 10 }, { percentage: 10 }] });
    const urgent = candidate("urgent", { windows: [{ percentage: 100, resetAt: now / 1_000 + 30 }, { percentage: 100 }], resetCreditsAvailable: 50, resetCreditsNextExpiresAt: now / 1_000 + 10 });
    expect(compareAutoQueueCandidates(starred, urgent, policy)).toBeLessThan(0);
    expect(compareAutoQueueCandidates({ ...starred, lastQuotaAt: 0 }, urgent, policy)).toBeGreaterThan(0);
  });

  it("uses only effective, fresh, unexpired reset reserves", () => {
    const reserve = candidate("reserve", { resetCreditsAvailable: 8, resetCreditsNextExpiresAt: now / 1_000 + 60 });
    expect(usableAutoQueueResetCount(reserve, policy)).toBe(8);
    for (const settings of [{ autoSwitchEnabled: false, autoResetEnabled: true }, { autoSwitchEnabled: true, autoResetEnabled: false }]) {
      const off = createAutoQueuePolicy(settings, now);
      expect(usableAutoQueueResetCount(reserve, off)).toBe(0);
      expect(compareAutoQueueCandidates(reserve, candidate("other"), off)).toBe(compareAutoQueueCandidates({ ...reserve, resetCreditsAvailable: 0, resetCreditsNextExpiresAt: undefined }, candidate("other"), off));
    }
    for (const expiry of [now / 1_000, now / 1_000 - 1, Number.NaN]) expect(usableAutoQueueResetCount({ ...reserve, resetCreditsNextExpiresAt: expiry }, policy)).toBe(0);
    expect(isAutoQueueResetCandidate({ ...reserve, windows: [{ percentage: 100 }, { percentage: 0 }] }, policy)).toBe(true);
    expect(isAutoQueueResetCandidate({ ...reserve, windows: [{ percentage: 0 }, { percentage: 50 }] }, policy)).toBe(false);
  });

  it("considers expiring resets, then reserve capacity, then least recent equal use", () => {
    const fewer = candidate("fewer", { resetCreditsAvailable: 1 });
    const more = candidate("more", { resetCreditsAvailable: 5 });
    expect(compareAutoQueueCandidates(more, fewer, policy)).toBeLessThan(0);
    expect(compareAutoQueueCandidates({ ...fewer, resetCreditsNextExpiresAt: now / 1_000 + 60 }, more, policy)).toBeLessThan(0);
    expect(compareAutoQueueCandidates(candidate("used", { lastSelectedAt: now - 10 }), candidate("unused"), policy)).toBeGreaterThan(0);
    expect(compareAutoQueueCandidates(candidate("used", { lastSelectedAt: now - 10, lastQuotaAt: now }), candidate("unused"), policy)).toBeGreaterThan(0);
  });

  it("provides a total order across partial, stale, missing and exhausted records", () => {
    const values = [candidate("a"), candidate("b", { windows: [{ percentage: 90 }] }), candidate("c", { windows: [{ percentage: 40, resetAt: now / 1_000 + 1 }, { percentage: 80 }] }), candidate("d", { lastQuotaAt: 1 }), candidate("e", { windows: [{ percentage: 0 }, { percentage: 0 }] }), candidate("f", { disabled: true }), candidate("g", { quotaError: true }), candidate("h", { queuePriority: true })];
    const sorted = [...values].sort((a, b) => compareAutoQueueCandidates(a, b, policy));
    for (let left = 0; left < sorted.length; left++) for (let right = left + 1; right < sorted.length; right++) {
      expect(compareAutoQueueCandidates(sorted[left], sorted[right], policy)).toBeLessThan(0);
      expect(compareAutoQueueCandidates(sorted[right], sorted[left], policy)).toBeGreaterThan(0);
    }
    expect([...values].reverse().sort((a, b) => compareAutoQueueCandidates(a, b, policy))).toEqual(sorted);
  });

  it("keeps backend and dashboard ordering identical across monthly, partial and reset records", () => {
    const records = [
      { id: "monthly", planType: "free", hourly: undefined, long: 70, minutes: 43_200 },
      { id: "hourly", hourly: 80, long: undefined, minutes: 10_080 },
      { id: "star", hourly: 10, long: 10, minutes: 10_080, queuePriority: true },
      { id: "reset", hourly: 70, long: 70, minutes: 10_080, resetCreditsAvailable: 8, resetCreditsNextExpiresAt: now / 1_000 + 60 },
      { id: "exhausted", hourly: 80, long: 0, minutes: 10_080 },
      { id: "old", hourly: 100, long: 100, minutes: 10_080, lastQuotaAt: 1 }
    ].map((row) => ({ id: row.id, email: `${row.id}@example.com`, createdAt: 1, updatedAt: 1, isActive: false, queuePriority: row.queuePriority, lastQuotaAt: row.lastQuotaAt ?? now - 1_000, planType: row.planType, quotaSummary: { hourlyPercentage: row.hourly ?? 0, hourlyWindowPresent: row.hourly !== undefined, hourlyWindowMinutes: 300, weeklyPercentage: row.long ?? 0, weeklyWindowPresent: row.long !== undefined, weeklyWindowMinutes: row.minutes, resetCreditsAvailable: row.resetCreditsAvailable, resetCreditsNextExpiresAt: row.resetCreditsNextExpiresAt } }));
    const views = records.map((record) => {
      const value = toAutoQueueOrderValue(record);
      return { id: record.id, email: record.email, enabled: true, queuePriority: record.queuePriority, lastQuotaAt: record.lastQuotaAt, resetCreditsAvailable: value.resetCreditsAvailable, resetCreditsNextExpiresAt: value.resetCreditsNextExpiresAt, metrics: value.windows.flatMap((window, index) => window.percentage === undefined ? [] : [{ key: index === 0 ? "hourly" : "weekly", period: index === 0 ? "hourly" : index === 1 ? "weekly" : "monthly", visible: true, ...window }]) } as any;
    });
    expect(records.sort((a, b) => compareCodexManagerAccountAutoQueueOrder(a, b, policy)).map((row) => row.id)).toEqual(views.sort((a, b) => compareDashboardAutoQueueAccounts(a, b, policy)).map((row: any) => row.id));
  });
});
