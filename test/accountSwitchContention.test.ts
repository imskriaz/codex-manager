import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AccountsRepository } from "../src/storage";
import { getCodexHomeStateKey } from "../src/codex";
import { configureCrossWindowOperationCoordinator, runCrossWindowExclusive } from "../src/utils/crossWindowOperations";
import { removeTestDirectory } from "./testFilesystem";

const { writeAuth } = vi.hoisted(() => ({ writeAuth: vi.fn(async () => undefined) }));
vi.mock("../src/codex", async importOriginal => ({
  ...await importOriginal<typeof import("../src/codex")>(), writeAuthFile: writeAuth
}));
vi.mock("../src/services/profile", () => ({ fetchRemoteAccountProfile: vi.fn(async () => undefined) }));

it("completes a manual switch after a short auth commit without a busy/retry failure", async () => {
  const folder = await mkdtemp(join(tmpdir(), "account-switch-contention-"));
  await configureCrossWindowOperationCoordinator(folder);
  const secrets = new Map<string, string>();
  const repo = new AccountsRepository({ secrets: {
    get: async (key: string) => secrets.get(key),
    store: async (key: string, value: string) => { secrets.set(key, value); },
    delete: async (key: string) => { secrets.delete(key); }
  } } as never, join(folder, "accounts-index.json"));
  try {
    const jwt = `header.${Buffer.from(JSON.stringify({ email: "switch@example.test", exp: Date.now() / 1000 + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "switch-account" } })).toString("base64url")}.signature`;
    const saved = await repo.upsertFromTokens({ idToken: jwt, accessToken: jwt, refreshToken: "saved-refresh" });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const commit = runCrossWindowExclusive(`account:switch:${getCodexHomeStateKey()}`, "Existing auth commit", async () => {
      started();
      await new Promise(resolve => setTimeout(resolve, 700));
    });
    await ready;
    const switched = repo.switchAccount(saved.id);
    await commit;
    await expect(switched).resolves.toMatchObject({ id: saved.id, isActive: true });
    expect(writeAuth).toHaveBeenCalledOnce();
  } finally {
    repo.dispose();
    await removeTestDirectory(folder);
  }
});
