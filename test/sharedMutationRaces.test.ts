import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import {
  configureCrossWindowOperationCoordinator,
  runCrossWindowExclusive,
  sharedPathKey
} from "../src/utils/crossWindowOperations";
import { WebDashboardServer } from "../src/services/webDashboardServer";
import {
  readWorkspaceFile,
  saveWorkspaceFile,
  deleteWorkspaceFile,
  commitWorkspaceChanges
} from "../src/services/workspaceTools";
import { runAccountBatch } from "../src/application/accounts/batch";
import { removeTestDirectory } from "./testFilesystem";
import { execFileSync } from "node:child_process";
import { EncryptedSyncManager } from "../src/services/encryptedSync";

let root: string, store: SqliteStateStore;
const workspaceDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "manager-mutation-races-"));
  store = await SqliteStateStore.open(join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
  await configureCrossWindowOperationCoordinator(root);
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    value: [{ uri: vscode.Uri.file(root), name: "test", index: 0 }]
  });
});
afterEach(async () => {
  if (workspaceDescriptor) Object.defineProperty(vscode.workspace, "workspaceFolders", workspaceDescriptor);
  else Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: undefined });
  vi.restoreAllMocks();
  configureSqliteStateStore(undefined);
  store.close();
  await removeTestDirectory(root);
});

it("preserves concurrent browser logins and does not revive a logged-out session", async () => {
  const secrets = new Map<string, string>();
  const context = {
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      }
    }
  };
  const server = () =>
    Object.assign(Object.create(WebDashboardServer.prototype), {
      context,
      sessions: new Map(),
      closeRemoteBrowserSockets: vi.fn(),
      browserSocketSessionFingerprint: new Map()
    });
  const first = server(),
    second = server();
  const a = "a".repeat(64),
    b = "b".repeat(64),
    c = "c".repeat(64),
    expires = Date.now() + 60_000;
  await Promise.all([first.rememberSession(a, expires), second.rememberSession(b, expires)]);
  expect(await first.isAuthorizedSessionToken(a)).toBe(true);
  expect(await first.isAuthorizedSessionToken(b)).toBe(true);
  await Promise.all([first.forgetSession(a), second.rememberSession(c, expires)]);
  expect(await second.isAuthorizedSessionToken(a)).toBe(false);
  expect(await second.isAuthorizedSessionToken(b)).toBe(true);
  expect(await second.isAuthorizedSessionToken(c)).toBe(true);
  context.secrets.store = async () => {
    throw new Error("storage full");
  };
  await expect(first.rememberSession("d".repeat(64), expires)).rejects.toThrow("storage full");
  expect(first.sessions.has("d".repeat(64))).toBe(false);
});

it("initializes one device identity across independent manager instances and retries failed storage", async () => {
  const secrets = new Map<string, string>();
  const context = {
    secrets: {
      get: vi.fn(async (key: string) => secrets.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        secrets.set(key, value);
      })
    }
  };
  const manager = () => Object.assign(Object.create(EncryptedSyncManager.prototype), { context });
  const a = manager(),
    b = manager();
  context.secrets.store.mockRejectedValueOnce(new Error("storage full"));
  await expect(a.getDeviceId()).rejects.toThrow("storage full");
  const ids = await Promise.all([a.getDeviceId(), b.getDeviceId()]);
  expect(ids[0]).toBe(ids[1]);
  expect([...secrets.values()]).toEqual([ids[0]]);
  expect(context.secrets.store).toHaveBeenCalledTimes(2);
});

it("protects the file revision check through the write and rejects save/delete overlap", async () => {
  await writeFile(join(root, "proof.txt"), "original");
  const file = await readWorkspaceFile(root, "proof.txt");
  await saveWorkspaceFile(root, "proof.txt", "first", file.revision);
  await expect(saveWorkspaceFile(root, "proof.txt", "stale", file.revision)).rejects.toThrow(/changed/i);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const holding = runCrossWindowExclusive(
    sharedPathKey("workspace-file", join(root, "proof.txt")),
    "File",
    async () => {
      entered();
      await new Promise<void>((done) => {
        release = done;
      });
    }
  );
  await started;
  await expect(deleteWorkspaceFile(root, "proof.txt")).rejects.toThrow("still in progress");
  await expect(
    saveWorkspaceFile(root, "proof.txt", "second", (await readWorkspaceFile(root, "proof.txt")).revision)
  ).rejects.toThrow("still in progress");
  release();
  await holding;
  expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("first");
  await deleteWorkspaceFile(root, "proof.txt");
});

it("coordinates Git mutations by the canonical Git common directory", async () => {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, windowsHide: true });
  const gitDir = join(root, ".git");
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const holding = runCrossWindowExclusive(sharedPathKey("workspace-git", gitDir), "Git", async () => {
    entered();
    await new Promise<void>((done) => {
      release = done;
    });
  });
  await started;
  await expect(commitWorkspaceChanges(root, "proof", true)).rejects.toThrow("still in progress");
  release();
  await holding;
});

it("deduplicates a batch and completes the remaining accounts after failures", async () => {
  const worker = vi.fn(async (id: string) => {
    if (id === "bad") throw new Error("offline");
  });
  const repo = {
    getAccount: vi.fn(async (id: string) => (id === "gone" ? undefined : { id, email: `${id}@example.test` }))
  };
  const result = await runAccountBatch(repo as never, ["ok", "bad", "ok", "gone", "last"], worker, {
    kind: "batch_refresh"
  });
  expect(result).toMatchObject({ successCount: 2, failedCount: 2 });
  expect(result.failures.map((item) => item.accountId).sort()).toEqual(["bad", "gone"]);
  expect(worker.mock.calls.flat().sort()).toEqual(["bad", "last", "ok"]);
});
