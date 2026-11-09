import { afterEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ registrations: [] as string[], recovery: undefined as undefined | (() => Promise<boolean>), resume: vi.fn(), publish: vi.fn(), canUse: undefined as undefined | ((id: string) => boolean), encrypted: false,
  handlers: new Map<string, (...args: any[]) => unknown>(), refreshQuota: vi.fn().mockResolvedValue(undefined), refreshAll: vi.fn().mockResolvedValue(undefined) }));
function disposable(name: string) { fixture.registrations.push(name); return { dispose: vi.fn() }; }
vi.mock("vscode", () => ({ commands: { registerCommand: vi.fn((name, handler) => { fixture.handlers.set(name, handler); return { dispose: vi.fn() }; }) } }));
vi.mock("../src/infrastructure/config/extensionSettings", () => ({ getCodexManagerConfiguration: () => ({ get: () => fixture.encrypted }), getAutoRefreshMinutes: () => 10, getAutoRefreshCurrentMinutes: () => 1 }));
vi.mock("../src/presentation/workbench/autoSwitchState", () => ({ initAutoSwitchRuntimeState: () => disposable("locks") }));
vi.mock("../src/presentation/workbench/schedulerRegistration", () => ({
  registerAutoRefreshScheduler: (options: { canRefreshAccount: () => boolean }) => { fixture.canUse = options.canRefreshAccount; return disposable("quota"); },
  registerTokenRefreshScheduler: () => disposable("tokens")
}));
vi.mock("../src/services/sessionRecording", () => ({ registerSessionRecording: () => disposable("recording") }));
vi.mock("../src/services/codexSessionQueue", () => ({ registerCodexSessionQueue: () => disposable("queue") }));
vi.mock("../src/services/workspaceTools", () => ({ registerWorkspaceTerminalMonitoring: () => disposable("terminals") }));
vi.mock("../src/services/modelCapacitySwitch", () => ({ registerModelCapacitySwitch: () => disposable("capacity") }));
vi.mock("../src/services/quotaRecoveryAutoResume", () => ({ registerQuotaRecoveryAutoResume: () => disposable("quota-recovery") }));
vi.mock("../src/services/codexSessionAutoResume", () => ({
  registerCodexSessionAutoResumeTracking: () => disposable("tracking"), resumePersistedCodexSessions: fixture.resume,
  scheduleCodexSessionAutoResume: (start: () => Promise<boolean>) => { fixture.recovery = start; return disposable("recovery"); },
  formatAutoResumeResult: () => "Recovery checked."
}));
vi.mock("../src/services/dashboardRealtime", () => ({ publishDashboardRealtime: fixture.publish }));
vi.mock("../src/application/accounts/commandService", () => ({ AccountsCommandService: class { refreshQuota = fixture.refreshQuota; refreshAllQuotas = fixture.refreshAll; } }));
import { registerNodeBackgroundServices } from "../src/services/nodeBackgroundServices";
afterEach(() => { fixture.registrations = []; fixture.encrypted = false; fixture.handlers.clear(); vi.clearAllMocks(); });
it("registers the existing queue, recording, recovery, quota and token services", async () => {
  const context = { subscriptions: [] };
  registerNodeBackgroundServices(context as never, {} as never, { publishLocalStateChange: vi.fn() } as never);
  expect(fixture.registrations).toEqual(["locks", "terminals", "recording", "queue", "tracking", "capacity", "quota-recovery", "quota", "tokens", "recovery"]);
  expect(context.subscriptions).toHaveLength(8);
  fixture.resume.mockResolvedValue({ failed: [] });
  await expect(fixture.recovery!()).resolves.toBe(false);
  fixture.resume.mockResolvedValue({ failed: ["unconfirmed"] });
  await expect(fixture.recovery!()).resolves.toBe(true);
  expect(fixture.publish).toHaveBeenLastCalledWith({ type: "dashboard:notice", level: "warning", message: "Recovery checked." });
  expect(fixture.refreshAll).toHaveBeenCalledWith({ silent: true, forceRefresh: true, respectQuotaCheckGap: false });
  await fixture.handlers.get('codexManager.refreshQuota')!({ id: 'manual' });
  expect(fixture.refreshQuota).toHaveBeenCalledWith({ id: 'manual' });
  await fixture.handlers.get('codexManager.refreshAllQuotas')!({ silent: false });
  expect(fixture.refreshAll).toHaveBeenLastCalledWith({ silent: false });
  expect(fixture.canUse!('local')).toBe(true);
  fixture.encrypted = true;
  expect(fixture.canUse!('local')).toBe(false);
});

it('retains shared claim checks instead of disabling all accounts in standalone', () => {
  const canUse = vi.fn(id => id === 'owned-here');
  registerNodeBackgroundServices({ subscriptions: [] } as never, {} as never, { publishLocalStateChange: vi.fn() } as never, canUse);
  expect(fixture.canUse!('owned-here')).toBe(true);
  expect(fixture.canUse!('foreign')).toBe(false);
});
