import { clearAutoSwitchLock, getAutoSwitchRuntimeSnapshot, isAutoSwitchLocked, updateAutoSwitchLock } from "../src/presentation/workbench/autoSwitchState";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountsRepository } from "../src/storage";
import { removeTestDirectory } from "./testFilesystem";
import { EncryptedSyncManager } from "../src/services/encryptedSync";
import { upsertDashboardDailyUsageCache, queryDashboardUsage } from '../src/services/dashboardUsageHistory';

const { writeAuth, refresh } = vi.hoisted(() => ({ writeAuth: vi.fn(), refresh: vi.fn() }));
vi.mock("../src/codex", async importOriginal => ({
  ...await importOriginal<typeof import("../src/codex")>(), writeAuthFile: writeAuth
}));
vi.mock("../src/auth/oauth", async importOriginal => ({
  ...await importOriginal<typeof import("../src/auth/oauth")>(), refreshTokens: refresh
}));
vi.mock("../src/services/profile", () => ({ fetchRemoteAccountProfile: vi.fn(async () => undefined) }));

let folder: string;
let repo: AccountsRepository;
function tokens(expired = false) {
  const jwt = `header.${Buffer.from(JSON.stringify({ email: "switch@example.test", exp: Date.now() / 1000 + (expired ? -60 : 3600),
    "https://api.openai.com/auth": { chatgpt_account_id: "switch-account" } })).toString("base64url")}.signature`;
  return { idToken: jwt, accessToken: jwt, refreshToken: "saved-refresh", accountId: "switch-account" };
}
beforeEach(async () => {
  clearAutoSwitchLock();
  writeAuth.mockReset().mockResolvedValue(undefined);
  refresh.mockReset();
  folder = await mkdtemp(join(tmpdir(), "account-switch-safety-"));
  const secrets = new Map<string, string>();
  repo = new AccountsRepository({ secrets: {
    get: async (key: string) => secrets.get(key),
    store: async (key: string, value: string) => { secrets.set(key, value); },
    delete: async (key: string) => { secrets.delete(key); }
  } } as never, join(folder, "accounts-index.json"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  repo.dispose();
  await removeTestDirectory(folder);
});

it('keeps the daily usage log after disabling and removing its account', async () => {
  const saved = await repo.upsertFromTokens(tokens());
  const values = new Map<string, unknown>();
  const context = { globalState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } } } as never;
  const date = new Date().toISOString().slice(0, 10), at = Date.parse(`${date}T00:00:00Z`);
  await upsertDashboardDailyUsageCache(context, saved.id, { days: 1, points: [{ date, unit: 'tokens', totalTokens: 42, extensionTokens: 42 }] });
  await repo.setAccountEnabled(saved.id, false);
  await repo.removeAccount(saved.id);
  expect(await repo.getAccount(saved.id)).toBeUndefined();
  const graph = queryDashboardUsage(context, { mode: 'tokens', from: at, to: at + 86400000 });
  expect(graph.dailyUsageCache).toMatchObject([{ accountId: saved.id, usage: { points: [{ totalTokens: 42 }] } }]);
});

it('saves tags durably, rejects stale replacements, and accepts idempotent retries', async () => {
  const saved = await repo.upsertFromTokens(tokens());
  const updated = await repo.setAccountTags(saved.id, [' Work ', 'Team'], []);
  expect(updated.tags).toEqual(['Work', 'Team']);
  const disk = JSON.parse(await readFile(join(folder, 'accounts-index.json'), 'utf8'));
  expect(disk.accounts.find((account: { id: string }) => account.id === saved.id).tags).toEqual(['Work', 'Team']);
  updated.tags!.push('Not persisted');
  expect((await repo.getAccount(saved.id))?.tags).toEqual(['Work', 'Team']);
  await expect(repo.setAccountTags(saved.id, ['Other'], [])).rejects.toThrow('changed in another window');
  const retry = await repo.setAccountTags(saved.id, ['Work', 'Team'], []);
  expect(retry.updatedAt).toBe(updated.updatedAt);
  expect((await repo.setAccountTags(saved.id, [], ['Work', 'Team'])).tags).toEqual([]);
  await expect(repo.setAccountTags('missing', ['Work'])).rejects.toThrow();
});

it('surfaces tag storage failures instead of acknowledging an undurable save', async () => {
  const saved = await repo.upsertFromTokens(tokens());
  const flush = vi.spyOn(repo, 'flush').mockRejectedValue(new Error('storage full'));
  await expect(repo.setAccountTags(saved.id, ['Work'], [])).rejects.toThrow('storage full');
  flush.mockRestore();
  await repo.flush();
});

it("persists selection before switch completion while optional rotation is pending", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  refresh.mockReturnValue(new Promise(() => undefined));
  await repo.switchAccount(saved.id, { forceTokenRefresh: true });
  expect(JSON.parse(await readFile(repo.accountsIndexPath, "utf8")).accounts[0].isActive).toBe(true);
  expect(writeAuth).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
});

it("writes auth and durably selects an account without awaiting shared claim confirmation", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  const state = new Map<string, unknown>();
  const manager = new EncryptedSyncManager({
    subscriptions: [],
    globalState: { get: (key: string, fallback?: unknown) => state.get(key) ?? fallback,
      update: async (key: string, value: unknown) => { state.set(key, value); } },
    secrets: { get: async () => "local-device", store: vi.fn() }
  } as never, repo);
  const confirm = vi.spyOn(manager as unknown as { requestCurrentClaim(): Promise<unknown> }, "requestCurrentClaim")
    .mockImplementation(() => new Promise(() => undefined));
  repo.setAccountSwitchCoordinator(manager);
  try {
    await repo.switchAccount(saved.id);
    expect(writeAuth).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(repo.accountsIndexPath, "utf8")).accounts[0].isActive).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  } finally { manager.dispose(); }
});

it("refreshes known expired credentials before writing auth and preserves edits during that wait", async () => {
  const saved = await repo.upsertFromTokens(tokens(true));
  let finish!: (value: ReturnType<typeof tokens>) => void;
  refresh.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const switched = repo.switchAccount(saved.id);
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(writeAuth).not.toHaveBeenCalled();
  await repo.setAccountQueuePriority(saved.id, true);
  const fresh = tokens();
  finish(fresh);
  await switched;
  expect(writeAuth).toHaveBeenCalledWith(fresh);
  expect(await repo.getAccount(saved.id)).toMatchObject({ isActive: true, queuePriority: true });
});

it("preserves the previous auth when required token refresh is offline", async () => {
  const saved = await repo.upsertFromTokens(tokens(true));
  refresh.mockRejectedValue(new Error("offline"));
  await expect(repo.switchAccount(saved.id)).rejects.toThrow("offline");
  expect(writeAuth).not.toHaveBeenCalled();
  expect((await repo.getAccount(saved.id))?.isActive).toBe(false);
});

it("bounds a slow required refresh and leaves the account inactive", async () => {
  const saved = await repo.upsertFromTokens(tokens(true));
  refresh.mockReturnValue(new Promise(() => undefined));
  const startedAt = Date.now();
  await expect(repo.switchAccount(saved.id, { manual: false })).rejects.toThrow("still refreshing");
  expect(Date.now() - startedAt).toBeLessThan(3_000);
  expect(writeAuth).not.toHaveBeenCalled();
  expect((await repo.getAccount(saved.id))?.isActive).toBe(false);
});

it("rejects expired credentials without a refresh token before writing auth", async () => {
  const expired = tokens(true);
  const saved = await repo.upsertFromTokens({ ...expired, refreshToken: undefined });
  await expect(repo.switchAccount(saved.id)).rejects.toThrow("Reauthorize");
  expect(writeAuth).not.toHaveBeenCalled();
});

it("reports a partial switch and retains ownership when selection storage fails after auth changed", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  await repo.flush();
  const coordinator = { prepareAccountSwitch: vi.fn(async () => undefined), cancelAccountSwitch: vi.fn(),
    completeAccountSwitch: vi.fn(), onAccountsMutated: vi.fn() };
  repo.setAccountSwitchCoordinator(coordinator);
  vi.spyOn(repo, "flush").mockRejectedValue(new Error("storage full"));
  await expect(repo.switchAccount(saved.id)).rejects.toThrow("credentials changed, but the account selection could not be saved");
  expect(writeAuth).toHaveBeenCalledOnce();
  expect(coordinator.cancelAccountSwitch).not.toHaveBeenCalled();
});

it("releases preparation after a failed auth write without selecting the account", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  const coordinator = { prepareAccountSwitch: vi.fn(async () => undefined), cancelAccountSwitch: vi.fn(),
    completeAccountSwitch: vi.fn(), onAccountsMutated: vi.fn() };
  repo.setAccountSwitchCoordinator(coordinator);
  writeAuth.mockRejectedValue(new Error("disk full"));
  await expect(repo.switchAccount(saved.id)).rejects.toThrow("disk full");
  expect(coordinator.cancelAccountSwitch).toHaveBeenCalledWith(saved.id);
  expect((await repo.getAccount(saved.id))?.isActive).toBe(false);
});

it("preserves metadata edits made while the atomic auth write is pending", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  let finish!: () => void;
  writeAuth.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const work = repo.switchAccount(saved.id);
  await vi.waitFor(() => expect(writeAuth).toHaveBeenCalledOnce());
  await repo.setAccountQueuePriority(saved.id, true);
  finish();
  await work;
  expect(await repo.getAccount(saved.id)).toMatchObject({ isActive: true, queuePriority: true });
});

it("joins duplicate switches and retries after a failed attempt", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  let finish!: () => void;
  writeAuth.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const first = repo.switchAccount(saved.id);
  await vi.waitFor(() => expect(writeAuth).toHaveBeenCalledOnce());
  const duplicate = repo.switchAccount(saved.id, { forceTokenRefresh: true });
  finish();
  expect((await Promise.all([first, duplicate])).map(account => account.id)).toEqual([saved.id, saved.id]);
  expect(writeAuth).toHaveBeenCalledOnce();
  writeAuth.mockRejectedValueOnce(new Error("storage full"));
  await expect(repo.switchAccount(saved.id)).rejects.toThrow("storage full");
  await expect(repo.switchAccount(saved.id)).resolves.toMatchObject({ id: saved.id });
});

it("rejects an automatic switch if the active account changed before the lease was acquired", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  await repo.switchAccount(saved.id);
  writeAuth.mockClear();
  await expect(repo.switchAccount(saved.id, { expectedActiveAccountId: null })).rejects.toThrow("active account changed");
  expect(writeAuth).not.toHaveBeenCalled();
});

it("uses the visible 15-minute lock for a manual empty-quota selection, with early unlock", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  await repo.updateQuota(saved.id, { hourlyWindowPresent: true, hourlyWindowMinutes: 300, hourlyPercentage: 0, weeklyWindowPresent: true, weeklyWindowMinutes: 10080, weeklyPercentage: 80 });
  const before = Date.now();
  await repo.switchAccount(saved.id);
  expect(isAutoSwitchLocked(saved.id)).toBe(true);
  expect(getAutoSwitchRuntimeSnapshot().lockedUntil).toBeGreaterThanOrEqual(before + 15 * 60000);
  expect(getAutoSwitchRuntimeSnapshot().lockedUntil).toBeLessThan(Date.now() + 15 * 60000 + 1);
  expect(JSON.parse(await readFile(repo.accountsIndexPath, "utf8"))).not.toHaveProperty('manualSelectionByCodexHome');
  writeAuth.mockClear();
  await expect(repo.switchAccount(saved.id, { expectedActiveAccountId: saved.id })).rejects.toThrow('Auto Switch is locked');
  expect(writeAuth).not.toHaveBeenCalled();
  await updateAutoSwitchLock(saved.id, 0);
  await expect(repo.switchAccount(saved.id, { expectedActiveAccountId: saved.id })).resolves.toMatchObject({ id: saved.id });
});

it("locks an unverified selection for 15 minutes and clears it when a usable account is selected", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  await repo.switchAccount(saved.id);
  expect(isAutoSwitchLocked(saved.id)).toBe(true);
  await repo.updateQuota(saved.id, { hourlyWindowPresent: true, hourlyWindowMinutes: 300, hourlyPercentage: 80, weeklyWindowPresent: false, weeklyPercentage: 0 });
  await repo.lockAutoSwitchForManualSelection(saved.id);
  expect(isAutoSwitchLocked(saved.id)).toBe(false);
});


it("keeps a manual switch pending through necessary credential renewal instead of requiring another click", async () => {
  const saved = await repo.upsertFromTokens(tokens(true));
  const fresh = tokens();
  refresh.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 1_700));
    return fresh;
  });
  const first = repo.switchAccount(saved.id);
  const duplicate = repo.switchAccount(saved.id);
  expect((await Promise.all([first, duplicate])).map(account => account.id)).toEqual([saved.id, saved.id]);
  expect(refresh).toHaveBeenCalledOnce();
  expect(writeAuth).toHaveBeenCalledWith(fresh);
  expect(writeAuth).toHaveBeenCalledOnce();
});

it("does not let delayed renewal replace a newer manual selection", async () => {
  const first = await repo.upsertFromTokens(tokens(true));
  let finish!: (value: ReturnType<typeof tokens>) => void;
  refresh.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const pending = repo.switchAccount(first.id);
  const cancelled = expect(pending).rejects.toThrow("newer manual account selection");
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  const jwt = `header.${Buffer.from(JSON.stringify({ email: "newer@example.test", exp: Date.now() / 1000 + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "newer-account" } })).toString("base64url")}.signature`;
  const newer = await repo.upsertFromTokens({ idToken: jwt, accessToken: jwt, refreshToken: "newer-refresh" });
  await repo.switchAccount(newer.id);
  finish(tokens());
  await cancelled;
  expect((await repo.getAccount(newer.id))?.isActive).toBe(true);
  expect(writeAuth).toHaveBeenCalledOnce();
});

it("switches with newer valid credentials when an older renewal loses its credential comparison", async () => {
  const saved = await repo.upsertFromTokens(tokens(true));
  let finish!: (value: ReturnType<typeof tokens>) => void;
  refresh.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const pending = repo.switchAccount(saved.id);
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  const newer = { ...tokens(), refreshToken: "newer-authorized-refresh" };
  await repo.updateTokens(saved.id, newer);
  finish(tokens());
  await expect(pending).resolves.toMatchObject({ id: saved.id, isActive: true });
  expect(await repo.getTokens(saved.id, { bypassCache: true })).toEqual(newer);
  expect(writeAuth).toHaveBeenCalledExactlyOnceWith(newer);
});

it("does not let optional token rotation overwrite a subsequently selected account", async () => {
  const first = await repo.upsertFromTokens(tokens());
  let finish!: (value: ReturnType<typeof tokens>) => void;
  refresh.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await repo.switchAccount(first.id, { forceTokenRefresh: true });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  const jwt = `header.${Buffer.from(JSON.stringify({ email: "next@example.test", exp: Date.now() / 1000 + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "next-account" } })).toString("base64url")}.signature`;
  const nextTokens = { idToken: jwt, accessToken: jwt, refreshToken: "next-refresh" };
  const next = await repo.upsertFromTokens(nextTokens);
  await repo.switchAccount(next.id);
  const rotated = { ...tokens(), refreshToken: "rotated-refresh" };
  finish(rotated);
  await vi.waitFor(async () => expect(await repo.getTokens(first.id, { bypassCache: true })).toEqual(rotated));
  expect(writeAuth).toHaveBeenCalledTimes(2);
  expect(writeAuth).toHaveBeenLastCalledWith({ ...nextTokens, accountId: "next-account" });
  expect((await repo.getAccount(next.id))?.isActive).toBe(true);
});
