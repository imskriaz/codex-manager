import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AccountsRepository } from "../src/storage";
import { removeTestDirectory } from "./testFilesystem";

const { profile } = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock("../src/services/profile", () => ({ fetchRemoteAccountProfile: profile }));
const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  profile.mockReset();
  for (const folder of folders.splice(0)) await removeTestDirectory(folder);
});

function tokens(email: string) {
  const payload = { email, "https://api.openai.com/auth": { chatgpt_account_id: email } };
  const jwt = `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
  return { idToken: jwt, accessToken: jwt, refreshToken: "refresh", accountId: email };
}

async function repository() {
  const folder = await mkdtemp(join(tmpdir(), "manual-profile-"));
  folders.push(folder);
  const secrets = new Map<string, string>();
  const repo = new AccountsRepository({ secrets: {
    get: async (key: string) => secrets.get(key),
    store: async (key: string, value: string) => { secrets.set(key, value); },
    delete: async (key: string) => { secrets.delete(key); }
  } } as never, join(folder, "accounts-index.json"));
  await writeFile(repo.accountsIndexPath, JSON.stringify({ accounts: [] }));
  return repo;
}

it("saves an account when optional profile loading stalls", async () => {
  const repo = await repository();
  profile.mockReturnValue(new Promise(() => undefined));
  const saved = await repo.upsertFromTokens(tokens("first@example.test"));
  await repo.flush();
  expect(saved.email).toBe("first@example.test");
  expect(profile.mock.calls[0]?.[1].signal.aborted).toBe(true);
  expect(await repo.getTokens(saved.id)).toMatchObject({ refreshToken: "refresh" });
  expect(JSON.parse(await readFile(repo.accountsIndexPath, "utf8")).accounts).toHaveLength(1);
});

it("preserves account edits and additions made during a slow profile refresh", async () => {
  const repo = await repository();
  profile.mockResolvedValue(undefined);
  const first = await repo.upsertFromTokens(tokens("first@example.test"));
  await repo.flush();
  let finish!: (value: object) => void;
  profile.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const refresh = repo.refreshAccountProfileMetadata(first.id);
  await vi.waitFor(() => expect(profile).toHaveBeenCalledTimes(2));
  await repo.setAccountQueuePriority(first.id, true);
  await repo.upsertFromTokens(tokens("second@example.test"));
  await repo.flush();
  finish({ accountName: "Workspace", accountId: first.accountId });
  await refresh;
  await repo.flush();
  expect(await repo.listAccounts()).toHaveLength(2);
  expect(await repo.getAccount(first.id)).toMatchObject({ queuePriority: true });
});

it("rejects a delayed profile result after the account credentials change", async () => {
  const repo = await repository();
  profile.mockResolvedValue(undefined);
  const first = await repo.upsertFromTokens(tokens("first@example.test"));
  await repo.flush();
  let finish!: (value: object) => void;
  profile.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const refresh = repo.refreshAccountProfileMetadata(first.id);
  const checked = expect(refresh).rejects.toThrow("account changed");
  await vi.waitFor(() => expect(profile).toHaveBeenCalledTimes(2));
  await repo.updateTokens(first.id, { ...tokens(first.email), refreshToken: "replacement" });
  finish({ accountName: "Outdated", accountId: first.accountId });
  await checked;
  await repo.flush();
  expect((await repo.getAccount(first.id))?.accountName).not.toBe("Outdated");
});

it("applies quota updates to current account metadata after optional profile work", async () => {
  const repo = await repository();
  profile.mockResolvedValue(undefined);
  const first = await repo.upsertFromTokens(tokens("first@example.test"));
  await repo.flush();
  let finish!: (value: object) => void;
  profile.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const refresh = repo.updateQuota(first.id, { hourlyPercentage: 75, hourlyWindowPresent: true, hourlyWindowMinutes: 300,
    hourlyResetTime: Math.floor(Date.now() / 1000) + 300 });
  await vi.waitFor(() => expect(profile).toHaveBeenCalledTimes(2));
  await repo.setAccountQueuePriority(first.id, true);
  await repo.upsertFromTokens(tokens("second@example.test"));
  await repo.flush();
  finish({ accountName: "Workspace", accountId: first.accountId });
  await refresh;
  await repo.flush();
  expect(await repo.listAccounts()).toHaveLength(2);
  expect(await repo.getAccount(first.id)).toMatchObject({ queuePriority: true, quotaSummary: { hourlyPercentage: 75 } });
});
