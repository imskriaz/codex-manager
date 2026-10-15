import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountsRepository } from "../src/storage";
import { removeTestDirectory } from "./testFilesystem";

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

it("persists selection before switch completion while optional rotation is pending", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  refresh.mockReturnValue(new Promise(() => undefined));
  await repo.switchAccount(saved.id, { forceTokenRefresh: true });
  expect(JSON.parse(await readFile(repo.accountsIndexPath, "utf8")).accounts[0].isActive).toBe(true);
  expect(writeAuth).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
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
