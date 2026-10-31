import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import type { AccountsRepository } from "../src/storage";
import type { CodexManagerAccountRecord } from "../src/core/types";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  home: vi.fn(),
  capture: vi.fn(),
  resume: vi.fn(),
  needsReload: vi.fn(),
  notice: vi.fn()
}));
vi.mock("../src/infrastructure/config/extensionSettings", () => ({ isAutoResumeEnabled: mocks.enabled }));
vi.mock("../src/services/codexSessionResume", () => ({ resolveCodexHome: mocks.home }));
vi.mock("../src/services/codexSessionAutoResume", () => ({
  isAutoResumeAvailable: mocks.enabled,
  persistRunningCodexSessions: mocks.capture,
  resumePersistedCodexSessions: mocks.resume,
  formatAutoResumeResult: () => "Recovered unfinished conversations."
}));
vi.mock("../src/presentation/workbench/windowRuntimeAccount", () => ({
  needsWindowReloadForAccount: mocks.needsReload
}));
vi.mock("../src/services/dashboardRealtime", () => ({ publishDashboardRealtime: mocks.notice }));
vi.mock("../src/application/accounts/autoQueueOrder", async () => {
  const { createAutoQueuePolicy } = await import("../src/domain/autoQueuePolicy");
  return {
    getAccountAutoQueuePolicy: () => createAutoQueuePolicy(),
    toAutoQueueOrderValue: (account: CodexManagerAccountRecord) => ({
      lastQuotaAt: account.lastQuotaAt,
      sessionStartedAt: account.sessionStartedAt
    })
  };
});
import { registerQuotaRecoveryAutoResume } from "../src/services/quotaRecoveryAutoResume";
import { recordAccountQuotaCheck } from "../src/services/quotaCheckCoordination";

let account: CodexManagerAccountRecord, saved: Map<string, unknown>, context: ExtensionContext;
let read: ReturnType<typeof vi.fn>, write: ReturnType<typeof vi.fn>, allowed: ReturnType<typeof vi.fn>;
const services: Array<{ dispose(): void }> = [];
const start = () => {
  const service = registerQuotaRecoveryAutoResume(
    context,
    { listAccounts: read } as unknown as AccountsRepository,
    allowed
  );
  services.push(service);
  return service;
};
const tick = () => vi.advanceTimersByTimeAsync(5_000);
const recover = () => {
  account = {
    ...account,
    lastQuotaAt: Date.now(),
    quotaSummary: {
      hourlyPercentage: 90,
      weeklyPercentage: 80,
      hourlyWindowPresent: true,
      weeklyWindowPresent: true,
      hourlyWindowMinutes: 300,
      weeklyWindowMinutes: 10080
    }
  };
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T00:00:00Z"));
  saved = new Map();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.enabled.mockReturnValue(true);
  mocks.home.mockReturnValue("test-home");
  mocks.needsReload.mockReturnValue(false);
  mocks.capture.mockResolvedValue([]);
  mocks.resume.mockResolvedValue({ attempted: 1, opened: 1, failed: [] });
  allowed = vi.fn(() => true);
  account = {
    id: "active",
    email: "example@example.com",
    isActive: true,
    createdAt: 1,
    updatedAt: 1,
    lastQuotaAt: Date.now(),
    quotaSummary: {
      hourlyPercentage: 0,
      weeklyPercentage: 0,
      hourlyWindowPresent: true,
      weeklyWindowPresent: true,
      hourlyWindowMinutes: 300,
      weeklyWindowMinutes: 10080
    }
  };
  read = vi.fn(async () => [account]);
  write = vi.fn(async (key: string, value: unknown) => {
    saved.set(key, value);
  });
  context = { workspaceState: { get: (key: string) => saved.get(key), update: write } } as unknown as ExtensionContext;
});
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
});

it("recovers the current account after exhaustion, retains the marker across reboot and does not repeat success", async () => {
  const service = start();
  await tick();
  expect(saved.get("codexManager.quotaRecovery:test-home")).toBe(true);
  service.dispose();
  recover();
  start();
  await tick();
  expect(mocks.resume).toHaveBeenCalledOnce();
  expect(saved.get("codexManager.quotaRecovery:test-home")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.resume).toHaveBeenCalledOnce();
});

it("observes exhaustion even when quota is reset between periodic checks", async () => {
  recover();
  start();
  await tick();
  recordAccountQuotaCheck({ ...account, quotaSummary: { ...account.quotaSummary!, hourlyPercentage: 0 } });
  await tick();
  expect(mocks.resume).toHaveBeenCalledOnce();
});

it('retains known exhaustion through an offline restart and waits for verified usable quota', async () => {
  account.quotaError={message:'Offline',timestamp:1};
  start();await tick();expect(saved.get('codexManager.quotaRecovery:test-home')).toBe(true);
  recover();await tick();expect(mocks.resume).not.toHaveBeenCalled();
  account.quotaError=undefined;await tick();expect(mocks.resume).toHaveBeenCalledOnce();
});
it.each(["disabled", "stale", "unknown", "exhausted", "ownership", "credentials", "missing", "reset", "changed-home"])(
  "does not resume on %s quota or authorization",
  async (reason) => {
    start();
    await tick();
    recover();
    if (reason === "disabled") mocks.enabled.mockReturnValue(false);
    if (reason === "stale") account.lastQuotaAt = Date.now() - 3_600_000;
    if (reason === "unknown") account.quotaError = { message: "Offline", timestamp: 1 };
    if (reason === "exhausted") account.quotaSummary!.weeklyPercentage = 0;
    if (reason === "ownership") allowed.mockReturnValue(false);
    if (reason === "credentials") mocks.needsReload.mockReturnValue(true);
    if (reason === "missing") read.mockResolvedValue([]);
    if (reason === "reset") account.resetCreditAttempt = { attemptedAt: 1 } as never;
    if (reason === "changed-home") mocks.home.mockReturnValue("another-home");
    await tick();
    expect(mocks.resume).not.toHaveBeenCalled();
  }
);
it("leaves ordinary healthy accounts alone and stops on disposal", async () => {
  recover();
  const service = start();
  await tick();
  expect(mocks.resume).not.toHaveBeenCalled();
  const before = read.mock.calls.length;
  service.dispose();
  await tick();
  expect(read).toHaveBeenCalledTimes(before);
});
it("retains partial recovery and retries through the existing duplicate-safe recovery path", async () => {
  start();
  await tick();
  recover();
  mocks.resume.mockResolvedValueOnce({ attempted: 2, opened: 1, failed: [{ sessionId: "pending" }] });
  await tick();
  expect(saved.get("codexManager.quotaRecovery:test-home")).toBe(true);
  expect(mocks.notice).toHaveBeenCalledWith(expect.objectContaining({ level: "warning" }));
  await tick();
  expect(mocks.resume).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.resume).toHaveBeenCalledTimes(2);
});
it.each(["storage", "offline", "capture", "resume"])(
  "retains recovery after %s failures without a rapid retry loop",
  async (reason) => {
    start();
    await tick();
    recover();
    if (reason === "storage") write.mockRejectedValue(new Error("Storage full"));
    if (reason === "offline") read.mockRejectedValue(new Error("Offline"));
    if (reason === "capture") mocks.capture.mockRejectedValue(new Error("Discovery unavailable"));
    if (reason === "resume") mocks.resume.mockRejectedValue(new Error("Timeout"));
    await tick();
    expect(saved.get("codexManager.quotaRecovery:test-home")).toBe(true);
    const attempts = mocks.resume.mock.calls.length;
    await tick();
    expect(mocks.resume).toHaveBeenCalledTimes(attempts);
  }
);
it("joins duplicate checks while recovery is pending and rechecks the account after discovery", async () => {
  start();
  await tick();
  recover();
  let finish!: () => void;
  mocks.capture.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  await tick();
  await tick();
  expect(mocks.capture).toHaveBeenCalledOnce();
  account = { ...account, id: "other" };
  finish();
  await tick();
  expect(mocks.resume).not.toHaveBeenCalled();
});
it("bounds stalled storage and account reads, retaining the durable marker for retry", async () => {
  saved.set("codexManager.quotaRecovery:test-home", true);
  recover();
  read.mockImplementationOnce(() => new Promise(() => undefined));
  start();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(saved.get("codexManager.quotaRecovery:test-home")).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.resume).toHaveBeenCalledOnce();
});
it("does not resume when Auto Resume is disabled or the service is disposed during discovery", async () => {
  start();
  await tick();
  recover();
  let finish!: () => void;
  mocks.capture.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  await tick();
  mocks.enabled.mockReturnValue(false);
  finish();
  await tick();
  expect(mocks.resume).not.toHaveBeenCalled();
});
