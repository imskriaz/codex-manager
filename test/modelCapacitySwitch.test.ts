import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountsRepository } from '../src/storage';
import type { DashboardCodexSessionLiveState } from '../src/domain/dashboard/types';
const mocks = vi.hoisted(() => ({ records: new Map<string, unknown>(), config: {} as Record<string, unknown>, account: 'active', home: 'D:/home', failStorage: false, running: vi.fn(), live: vi.fn(), switch: vi.fn(), inspect: vi.fn(), recent: vi.fn(), observe: vi.fn() }));
vi.mock('../src/storage/sqliteState', () => ({ getSqliteStateStore: () => ({ get: (n: string, k: string) => mocks.records.get(n + k), set: (n: string, k: string, value: unknown) => { if (mocks.failStorage) throw Error('Storage full'); mocks.records.set(n + k, structuredClone(value)); } }) }));
vi.mock('../src/infrastructure/config/extensionSettings', async original => ({ ...await original<typeof import('../src/infrastructure/config/extensionSettings')>(), getCodexManagerConfiguration: () => ({ get: (key: string, fallback: unknown) => mocks.config[key] ?? fallback }) }));
vi.mock('../src/services/sessionRecording', () => ({ captureSessionAccount: () => mocks.account }));
vi.mock('../src/services/codexSessionResume', () => ({ resolveCodexHome: () => mocks.home, readRunningCodexSessionIds: mocks.running, onDidInspectRunningCodexSessions: mocks.inspect, readRecentRunningCodexSessionIds: mocks.recent, observeRunningCodexSession: mocks.observe }));
vi.mock('../src/services/codexSessionLive', () => ({ listCodexSessionLiveStates: mocks.live }));
vi.mock('../src/application/accounts/quota', () => ({ maybeAutoSwitchForActiveQuota: mocks.switch }));
import { CAPACITY_TAG_TTL_MS, countModelCapacityOutcome, isCapacityTagExpired, registerModelCapacitySwitch } from '../src/services/modelCapacitySwitch';
import { publishDashboardRealtime, subscribeDashboardRealtime } from '../src/services/dashboardRealtime';

let repo: { listAccounts: ReturnType<typeof vi.fn>; setAccountTags: ReturnType<typeof vi.fn> }, registration: ReturnType<typeof registerModelCapacitySwitch>;
let tags: string[], notices: string[], stopNotices: () => void;
const snapshot = (id: string, patch: Partial<DashboardCodexSessionLiveState> = {}): DashboardCodexSessionLiveState => ({ sessionId: id, streamId: id, turnId: id, updatedAt: Date.now(), sequence: 1, status: 'failed', error: 'Selected model is at capacity', messages: [], ...patch });
const emit = (state: DashboardCodexSessionLiveState) => publishDashboardRealtime({ type: 'dashboard:codex-session-live', state });
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const ledger = () => [...mocks.records.values()][0] as { count: number } | undefined;
beforeEach(() => {
  mocks.records.clear(); mocks.config = {}; mocks.account = 'active'; mocks.home = 'D:/home'; mocks.failStorage = false;
  mocks.running.mockReset().mockResolvedValue([]); mocks.live.mockReset().mockReturnValue([]); mocks.switch.mockReset().mockResolvedValue(true);
  tags = ['Work']; notices = [];
  mocks.inspect.mockReset().mockReturnValue({ dispose: vi.fn() }); mocks.recent.mockReset().mockReturnValue([]); mocks.observe.mockReset();
  repo = { listAccounts: vi.fn(async () => [{ id: mocks.account, tags: [...tags] }]), setAccountTags: vi.fn(async (_id, next) => { tags = next; }) };
  registration = registerModelCapacitySwitch(repo as unknown as AccountsRepository, { refresh: vi.fn() }, () => true);
  stopNotices = subscribeDashboardRealtime(message => { if (message.type === 'dashboard:notice') notices.push(message.message); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { registration.dispose(); stopNotices(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('counts consecutive failures across sessions once, preserves tags, and switches at the threshold', async () => {
  emit(snapshot('one')); await flush(); emit(snapshot('one', { streamId: 'mirrored-stream' })); await flush(); emit(snapshot('two')); await flush();
  expect(ledger()?.count).toBe(2); expect(mocks.switch).not.toHaveBeenCalled();
  emit(snapshot('three')); await flush();
  expect(ledger()?.count).toBe(3); expect(mocks.switch).toHaveBeenCalledOnce();
  expect(mocks.switch.mock.calls[0]?.[2]).toMatchObject({ modelCapacityAccountId: 'active' });
  expect(tags).toEqual(['Work', 'Capacity']); expect(repo.setAccountTags).toHaveBeenCalledOnce();
});
it('observes discovered native turns independently of Auto Resume and ignores another home', () => {
  mocks.config.autoResumeEnabled = false;
  mocks.recent.mockReturnValue(['native']);
  const inspect = mocks.inspect.mock.calls[0]![0];
  inspect('another-home'); expect(mocks.observe).not.toHaveBeenCalled();
  inspect(mocks.home); expect(mocks.observe).toHaveBeenCalledExactlyOnceWith({ id: 'native', title: 'native', status: 'running' });
});
it('resets on success and other failures, and honors a configurable threshold', async () => {
  mocks.config.modelCapacityFailureCount = 2;
  emit(snapshot('one')); await flush(); emit(snapshot('ok', { status: 'completed', error: undefined })); await flush();
  expect(ledger()?.count).toBe(0);
  emit(snapshot('two')); await flush(); emit(snapshot('network', { error: 'Connection interrupted' })); await flush();
  expect(ledger()?.count).toBe(0);
  emit(snapshot('three')); await flush(); expect(mocks.switch).not.toHaveBeenCalled();
  emit(snapshot('four')); await flush(); expect(mocks.switch).toHaveBeenCalledOnce();
});
it('ignores failures while any other session is running without tagging the account', async () => {
  emit(snapshot('one')); await flush();
  mocks.running.mockResolvedValue(['other']); emit(snapshot('ignored')); await flush();
  expect(ledger()?.count).toBe(1); expect(tags).not.toContain('Capacity');
  mocks.running.mockResolvedValue([]); emit(snapshot('ignored')); await flush(); expect(ledger()?.count).toBe(1);
  mocks.live.mockReturnValue([snapshot('other', { status: 'running' })]); emit(snapshot('also-ignored')); await flush(); expect(ledger()?.count).toBe(1);
  mocks.live.mockReturnValue([]); emit(snapshot('last')); await flush(); expect(ledger()?.count).toBe(2);
  expect(mocks.switch).not.toHaveBeenCalled();
});
it.each(['autoSwitchEnabled', 'modelCapacityAutoSwitchEnabled'])('does not count or switch with %s off', async key => {
  mocks.config[key] = false;
  for (const id of ['one', 'two', 'three']) { emit(snapshot(id)); await flush(); }
  expect(ledger()?.count).toBe(0); expect(mocks.switch).not.toHaveBeenCalled(); expect(tags).not.toContain('Capacity');
});
it('recovers counts across restart without counting replayed terminal events', async () => {
  emit(snapshot('one')); await flush(); emit(snapshot('two')); await flush(); registration.dispose();
  registration = registerModelCapacitySwitch(repo as unknown as AccountsRepository, { refresh: vi.fn() }, () => true);
  emit(snapshot('two')); await flush(); expect(ledger()?.count).toBe(2);
  emit(snapshot('three')); await flush(); expect(mocks.switch).toHaveBeenCalledOnce();
});
it('rejects stale, remote, and old-account streams and resets on account changes', async () => {
  emit(snapshot('stale', { updatedAt: 1 })); emit(snapshot('remote', { deviceId: 'remote' }));
  emit(snapshot('old-stream', { status: 'running' })); mocks.account = 'new'; emit(snapshot('old-stream')); await flush();
  expect(ledger()).toBeUndefined();
  emit(snapshot('new')); await flush(); expect(ledger()?.count).toBe(1); expect(mocks.switch).not.toHaveBeenCalled();
});
it('keeps failures inconclusive when storage or session inspection fails', async () => {
  mocks.failStorage = true; emit(snapshot('disk')); await flush();
  mocks.failStorage = false; emit(snapshot('disk')); await flush();
  expect(ledger()?.count).toBe(1); expect(mocks.switch).not.toHaveBeenCalled();
  mocks.running.mockRejectedValueOnce(Error('Owner offline')); emit(snapshot('offline')); await flush();
  expect(ledger()?.count).toBe(1); expect(mocks.switch).not.toHaveBeenCalled(); expect(notices.length).toBe(2);
});
it('does not lose user tags on a conflict and reports a full tag list separately', async () => {
  mocks.config.modelCapacityFailureCount = 1;
  tags = Array.from({ length: 10 }, (_, i) => 'Tag' + i); repo.setAccountTags.mockRejectedValueOnce(Error('Use at most 10 tags'));
  emit(snapshot('full')); await flush(); expect(tags).toHaveLength(10); expect(notices.some(message => message.includes('Existing tags were kept'))).toBe(true);
});
it('retries a Capacity tag conflict without dropping a concurrent user tag', async () => {
  mocks.config.modelCapacityFailureCount = 1;
  repo.setAccountTags.mockImplementationOnce(async () => { tags.push('New'); throw Error('Tags changed in another window'); });
  emit(snapshot('race')); await flush(); expect(tags).toEqual(['Work', 'New', 'Capacity']);
});
it('expires only auto-managed Capacity tags after two hours', () => {
  const now = 10_000_000;
  expect(isCapacityTagExpired(now - CAPACITY_TAG_TTL_MS, now)).toBe(true);
  expect(isCapacityTagExpired(now - CAPACITY_TAG_TTL_MS + 1, now)).toBe(false);
});
it('cancels the switch guard if another session starts during recovery', async () => {
  mocks.config.modelCapacityFailureCount = 1;
  emit(snapshot('failed')); await flush(); const guard = mocks.switch.mock.calls[0]?.[2].capacityStillNeeded;
  expect(guard()).toBe(true); emit(snapshot('another', { status: 'running' })); expect(guard()).toBe(false);
});
it('preserves the streak for ignored outcomes and rejects malformed persisted counters', () => {
  const state = countModelCapacityOutcome(undefined, 'a', 'one', true);
  expect(countModelCapacityOutcome(state, 'a', 'one', true)).toBe(state);
  expect(countModelCapacityOutcome(state, 'a', 'ignored', undefined).count).toBe(1);
  expect(countModelCapacityOutcome(state, 'b', 'new', true).count).toBe(1);
  expect(countModelCapacityOutcome({ accountId: 'a', count: NaN, seen: [] }, 'a', 'new', true).count).toBe(1);
});
