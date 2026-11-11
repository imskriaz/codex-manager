import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import type { AccountsRepository } from "../src/storage";
import type { CodexManagerAccountRecord } from "../src/core/types";
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  home: vi.fn(),
  capture: vi.fn(),
  resume: vi.fn(),
  needsReload: vi.fn(),
  notice: vi.fn(),
  subscribe: vi.fn(),
  stopStorage: vi.fn(), liveListener: undefined as undefined | ((message: any) => void)
}));
vi.mock('../src/storage/sqliteState', () => ({ getSqliteStateStore: () => ({ subscribe: mocks.subscribe }) }));
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
vi.mock("../src/services/dashboardRealtime", () => ({ publishDashboardRealtime: mocks.notice, subscribeDashboardRealtime: (listener: typeof mocks.liveListener) => { mocks.liveListener = listener; return () => { mocks.liveListener = undefined; }; } }));
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
const flush = () => vi.advanceTimersByTimeAsync(0);
const tick = async () => { recordAccountQuotaCheck(account); await vi.advanceTimersByTimeAsync(5_000); };
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
  for (const mock of Object.values(mocks)) if (vi.isMockFunction(mock)) mock.mockReset();
  mocks.enabled.mockReturnValue(true);
  mocks.home.mockReturnValue("test-home");
  mocks.needsReload.mockReturnValue(false);
  mocks.capture.mockResolvedValue([]);
  mocks.resume.mockResolvedValue({ attempted: 1, opened: 1, failed: [] });
  mocks.subscribe.mockReturnValue(mocks.stopStorage);
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
  Reflect.deleteProperty(vscode.env, 'appHost');
  vi.useRealTimers();
});

it('recovers immediately after a standalone account change above the exhaustion threshold', async () => {
  Object.defineProperty(vscode.env, 'appHost', { configurable: true, value: 'node' });
  recover(); account.quotaSummary!.hourlyPercentage = 4;
  start(); await tick(); expect(mocks.resume).not.toHaveBeenCalled();
  account.id = 'replacement'; account.quotaSummary!.hourlyPercentage = 80;
  await tick(); expect(mocks.resume).toHaveBeenCalledOnce();
  expect(saved.get('codexManager.quotaRecovery:test-home')).toBeUndefined();
  expect(mocks.notice).not.toHaveBeenCalled();
});

it('captures a quota-failed private turn once and refreshes quota without waiting for a manual prompt', async () => {
  Object.defineProperty(vscode.env, 'appHost', { configurable: true, value: 'node' });
  recover(); start(); await tick();
  account.lastQuotaAt = Date.now();
  const message = { type: 'dashboard:codex-session-live', state: { sessionId: 'failed-session', streamId: 'failed-stream', status: 'failed', error: 'usage limit reached' } };
  mocks.liveListener!(message); mocks.liveListener!(message);
  await tick();
  expect(mocks.capture).toHaveBeenCalledWith(context, expect.any(Function));
  const capture = mocks.capture.mock.calls.find(call => call[1])?.[1];
  expect(await capture()).toEqual(['failed-session']);
  expect(vscode.commands.executeCommand).toHaveBeenCalledWith('codexManager.refreshQuota', account);
  expect(mocks.resume).toHaveBeenCalledOnce();
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

it('stays idle between quota changes, reacts immediately to other-window writes, and releases its subscription', async () => {
  recover(); const service = start(); await flush(); read.mockClear();
  await vi.advanceTimersByTimeAsync(59_000);
  expect(read).not.toHaveBeenCalled();
  account.quotaSummary!.hourlyPercentage = 0;
  const changed = mocks.subscribe.mock.calls[0]![1] as () => void;
  changed(); await flush();
  expect(saved.get('codexManager.quotaRecovery:test-home')).toBe(true);
  recover(); changed(); await flush();
  expect(mocks.resume).toHaveBeenCalledOnce();
  service.dispose(); expect(mocks.stopStorage).toHaveBeenCalledOnce(); read.mockClear(); changed(); await flush();
  expect(read).not.toHaveBeenCalled();
});

it('rechecks a quota change arriving during an unfinished account read without concurrent recovery', async () => {
  let finish!: (rows: CodexManagerAccountRecord[]) => void;
  const exhausted = account;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  start(); await flush(); recover();
  const changed = mocks.subscribe.mock.calls[0]![1] as () => void;
  changed(); changed(); finish([exhausted]); await flush();
  expect(mocks.resume).toHaveBeenCalledOnce();
  expect(mocks.capture).toHaveBeenCalledOnce();
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


it('does not make a replacement account wait for the previous account recovery cooldown', async () => {
  Object.defineProperty(vscode.env, 'appHost', { configurable: true, value: 'node' });
  start(); await flush(); recover();
  mocks.resume.mockResolvedValueOnce({ attempted: 1, opened: 0, failed: [{ sessionId: 'pending' }] });
  const changed = mocks.subscribe.mock.calls[0]![1] as () => void;
  changed(); await flush();
  expect(mocks.resume).toHaveBeenCalledOnce();
  changed(); await flush(); expect(mocks.resume).toHaveBeenCalledOnce();
  account = { ...account, id: 'replacement' };
  changed(); changed(); await flush();
  expect(mocks.resume).toHaveBeenCalledTimes(2);
  expect(saved.get('codexManager.quotaRecovery:test-home')).toBeUndefined();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.resume).toHaveBeenCalledTimes(2);
});

it('does not let an old account quota refresh or failure timestamp block a freshly verified replacement', async () => {
  Object.defineProperty(vscode.env, 'appHost', { configurable: true, value: 'node' });
  recover(); start(); await flush();
  const verifiedAt = account.lastQuotaAt;
  await vi.advanceTimersByTimeAsync(1_000);
  let finish!: () => void;
  vi.mocked(vscode.commands.executeCommand).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  mocks.liveListener!({ type: 'dashboard:codex-session-live', state: { sessionId: 'failed-session', streamId: 'old-account-failure', status: 'failed', error: 'usage limit reached' } });
  await flush(); expect(mocks.resume).not.toHaveBeenCalled();
  account = { ...account, id: 'replacement', lastQuotaAt: verifiedAt };
  const changed = mocks.subscribe.mock.calls[0]![1] as () => void;
  changed(); await flush();
  expect(mocks.resume).toHaveBeenCalledOnce();
  finish(); await flush();
  expect(mocks.resume).toHaveBeenCalledOnce();
});

it.each(['exhausted', 'stale', 'disabled', 'ownership'])('keeps replacement %s safety checks while bypassing old retry cooldown', async reason => {
  Object.defineProperty(vscode.env, 'appHost', { configurable: true, value: 'node' });
  start(); await flush(); recover();
  mocks.resume.mockResolvedValueOnce({ attempted: 1, opened: 0, failed: [{ sessionId: 'pending' }] });
  const changed = mocks.subscribe.mock.calls[0]![1] as () => void;
  changed(); await flush(); expect(mocks.resume).toHaveBeenCalledOnce();
  account = { ...account, id: 'replacement', quotaSummary: { ...account.quotaSummary! } };
  if (reason === 'exhausted') account.quotaSummary!.hourlyPercentage = 0;
  if (reason === 'stale') account.lastQuotaAt = Date.now() - 3_600_000;
  if (reason === 'disabled') account.enabled = false;
  if (reason === 'ownership') allowed.mockReturnValue(false);
  changed(); await flush();
  expect(mocks.resume).toHaveBeenCalledOnce();
  expect(saved.get('codexManager.quotaRecovery:test-home')).toBe(true);
});


it.each(['missing', 'disabled', 'ownership'])('durably captures interruption before deferring for a %s active account', async reason => {
  Object.defineProperty(vscode.env, 'appHost', { configurable: true, value: 'node' });
  recover(); start(); await flush();
  if (reason === 'missing') read.mockResolvedValue([]);
  if (reason === 'disabled') account.enabled = false;
  if (reason === 'ownership') allowed.mockReturnValue(false);
  mocks.liveListener!({ type: 'dashboard:codex-session-live', state: { sessionId: 'retained-session', streamId: 'retained-stream', status: 'failed', error: 'usage limit reached' } });
  await flush();
  expect(mocks.capture).toHaveBeenCalledWith(context, expect.any(Function));
  const capture = mocks.capture.mock.calls.find(call => call[1])?.[1];
  expect(await capture()).toEqual(['retained-session']);
  expect(saved.get('codexManager.quotaRecovery:test-home')).toBe(true);
  expect(mocks.resume).not.toHaveBeenCalled();
});
