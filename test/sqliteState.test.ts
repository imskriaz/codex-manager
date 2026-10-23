import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureSqliteStateStore, createSqliteMemento, deleteSqliteStateFile, listSqliteStateFiles,
  readSqliteStateFile, SqliteStateStore, writeSqliteStateFile
} from "../src/storage/sqliteState";
import { readIndexSnapshot } from "../src/storage/accountsPersistence";
import { persistIndexWithBackups } from "../src/storage/accountsWriteCoordinator";
import { disposeWriteCoordinator, flushPendingSave, markPendingSave } from "../src/storage/accountsWriteCoordinator";
import * as persistence from "../src/storage/accountsPersistence";
import { cloneIndex, mergeAccountsIndexChanges } from "../src/storage/accountsIndex";
import { saveAccountIndex, readAccountIndex } from "../src/storage/sqliteAccounts";
import { configureCrossWindowOperationCoordinator, runCrossWindowExclusive } from "../src/utils/crossWindowOperations";
import { readDashboardDailyUsageCache, upsertDashboardDailyUsageCache } from "../src/services/dashboardUsageHistory";
import { createAccountsRepositoryState } from "../src/storage/accountsRepositoryState";
import { readSafeFileSnapshot } from "../src/utils/safeFileReads";
import { AUTO_RESUME_OPEN_SESSION_IDS_KEY, persistOpenCodexSessions, resumePersistedCodexSessions } from "../src/services/codexSessionAutoResume";
import * as selection from "../src/services/codexSessionAutoResumeSelection";
import * as vscode from "vscode";
import { removeTestDirectory } from "./testFilesystem";

let root: string;
const stores = new Set<SqliteStateStore>();
async function open() {
  const store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  stores.add(store);
  return store;
}

it('retains compact account tags through SQLite reopen and clearing', async () => {
  const store = await open();
  saveAccountIndex(store, { accounts: [{ id: 'tagged', email: 'tags@example.test', createdAt: 1, updatedAt: 2, tags: ['Work', 'Team'] }] });
  store.close(); stores.delete(store);
  const reopened = await open();
  const index = readAccountIndex(reopened);
  expect(index.accounts[0]?.tags).toEqual(['Work', 'Team']);
  index.accounts[0]!.tags = [];
  saveAccountIndex(reopened, index);
  expect(readAccountIndex(reopened).accounts[0]?.tags).toEqual([]);
});

it('removes retired manual pause metadata when the account header is saved', async () => {
  const store = await open();
  const index = { accounts: [{ id: 'manual', email: 'manual@example.test', createdAt: 1, updatedAt: 1 }],
    manualSelectionByCodexHome: { first: { accountId: 'manual' } } };
  saveAccountIndex(store, index);
  store.close(); stores.delete(store);
  const reopened = await open();
  expect(readAccountIndex(reopened)).not.toHaveProperty('manualSelectionByCodexHome');
  expect(readAccountIndex(reopened).accounts[0]!.id).toBe('manual');
});
function legacy(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
    update: vi.fn(async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, value); }),
    setKeysForSync: vi.fn(), values
  };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sqlite-state-"));
  await configureCrossWindowOperationCoordinator(root);
});
afterEach(async () => {
  configureSqliteStateStore(undefined);
  for (const store of stores) store.close();
  stores.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await removeTestDirectory(root);
});

describe("SQLite WAL state", () => {
  it("prevents a queued save from writing after its repository is disposed", async () => {
    const store = await open(); configureSqliteStateStore(store);
    const file = path.join(root,"accounts-index.json"), original = { accounts:[{id:"a",email:"a@example.com",createdAt:1,updatedAt:1}] };
    writeSqliteStateFile(file,JSON.stringify(original));
    const state = createAccountsRepositoryState(); state.persistedIndex = cloneIndex(original);
    let release!:()=>void; const gate = new Promise<void>(resolve=>{release=resolve;});
    const read = persistence.readIndexSnapshot;
    const paused = vi.spyOn(persistence,"readIndexSnapshot").mockImplementationOnce(async (...args)=>{const result=await read(...args);await gate;return result;});
    const changed = cloneIndex(original); changed.accounts[0]!.enabled=false;
    markPendingSave(state,changed,60_000,()=>undefined);clearTimeout(state.saveDebounceTimer!);
    vi.spyOn(console,"error").mockImplementation(()=>undefined);
    const saving = flushPendingSave(state,index=>persistIndexWithBackups({state,index,indexPath:file,tempSuffix:".tmp",backupCount:3}));
    await vi.waitFor(()=>expect(paused).toHaveBeenCalledOnce());
    disposeWriteCoordinator(state);release();await saving;
    await expect(state.persistChain).rejects.toThrow();
    expect((await readIndexSnapshot(file)).accounts[0]?.enabled).not.toBe(false);
    expect(await fs.stat(file).catch(()=>undefined)).toBeUndefined();
  });

  it("merges simultaneous account edits, additions, deletions and separate home selections", () => {
    const account = (id: string) => ({ id, email: `${id}@example.com`, createdAt: 1, updatedAt: 1 });
    const base = { accounts: [account("a"), account("b"), account("removed")], activeAccountStateVersion: 1 as const, activeAccountIdsByCodexHome: { first: "a", second: "b" } };
    const local = cloneIndex(base);
    local.accounts[0]!.enabled = false;
    local.accounts[0]!.updatedAt = 2;
    local.accounts.push(account("local-added"));
    local.activeAccountIdsByCodexHome!.first = "b";
    const peer = cloneIndex(base);
    peer.accounts[0]!.queuePriority = 3;
    peer.accounts[0]!.updatedAt = 10;
    peer.accounts = peer.accounts.filter(item => item.id !== "removed");
    peer.accounts.push(account("peer-added"));
    peer.activeAccountIdsByCodexHome!.second = "a";
    const merged = mergeAccountsIndexChanges(base, local, peer, "first");
    expect(merged.accounts.find(item => item.id === "a")).toMatchObject({ enabled: false, queuePriority: 3, updatedAt: 10 });
    expect(merged.accounts.map(item => item.id).sort()).toEqual(["a", "b", "local-added", "peer-added"]);
    expect(merged.currentAccountId).toBe("b");
    expect(merged.activeAccountIdsByCodexHome).toEqual({ first: "b", second: "a" });
    expect(base.accounts[0]).not.toHaveProperty("enabled");
  });

  it("rebases queued writes on the committed index instead of erasing another window's fields", async () => {
    configureSqliteStateStore(await open());
    const file = path.join(root, "accounts-index.json");
    const base = { accounts: [{ id: "a", email: "a@example.com", createdAt: 1, updatedAt: 1 }] };
    const state = createAccountsRepositoryState();
    state.persistedIndex = cloneIndex(base);
    writeSqliteStateFile(file, JSON.stringify({ accounts: [{ ...base.accounts[0], enabled: false }] }));
    const first = cloneIndex(base);
    first.accounts[0]!.queuePriority = 2;
    markPendingSave(state, first, 60_000, () => undefined);
    clearTimeout(state.saveDebounceTimer!);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = persistence.readIndexSnapshot;
    const paused = vi.spyOn(persistence, "readIndexSnapshot").mockImplementationOnce(async (...args) => { const snapshot = await read(...args); await gate; return snapshot; });
    const save = (index: typeof first) => persistIndexWithBackups({ state, indexPath: file, index, tempSuffix: ".tmp", backupCount: 3 });
    const savingFirst = flushPendingSave(state, save);
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    const second = cloneIndex(first);
    second.accounts[0]!.showInStatusBar = true;
    markPendingSave(state, second, 60_000, () => undefined);
    clearTimeout(state.saveDebounceTimer!);
    const savingSecond = flushPendingSave(state, save);
    release();
    await Promise.all([savingFirst, savingSecond]);
    await state.persistChain;
    expect((await readIndexSnapshot(file)).accounts[0]).toMatchObject({ enabled: false, queuePriority: 2, showInStatusBar: true });
    expect(state.pendingSave).toBeNull();
    expect(state.isDirty).toBe(false);
  });

  it("serializes separate dashboard windows before reading and updating shared usage", async () => {
    const store = await open();
    configureSqliteStateStore(store);
    const firstState = createSqliteMemento(store, "global", legacy());
    const secondState = createSqliteMemento(await open(), "global", legacy());
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    try {
      const blocker = runCrossWindowExclusive("state:dashboard-usage", "Competing usage writer", async () => { entered(); await gate; });
      await ready;
      const first = upsertDashboardDailyUsageCache({ globalState: firstState } as never, "a", { days: 1, points: [] });
      const second = upsertDashboardDailyUsageCache({ globalState: secondState } as never, "b", { days: 1, points: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(readDashboardDailyUsageCache({ globalState: secondState } as never)).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(150);
      await Promise.all([blocker, first, second]);
      expect(readDashboardDailyUsageCache({ globalState: secondState } as never).map(item => item.accountId).sort()).toEqual(["a", "b"]);
    } finally { release(); vi.useRealTimers(); }
  });

  it("uses WAL and full commits, exposes updates across connections, and rolls back incomplete transactions", async () => {
    const store = await open();
    const peer = await open();
    const native = (store as unknown as { database: DatabaseSync }).database;
    expect(native.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(native.prepare("PRAGMA synchronous").get()).toMatchObject({ synchronous: 2 });
    store.set("global", "setting", true);
    expect(peer.get("global", "setting")).toBe(true);
    expect(() => store.transaction(() => { store.set("global", "setting", false); store.set("global", "partial", 1); throw new Error("interrupted"); })).toThrow("interrupted");
    expect(peer.get("global", "setting")).toBe(true);
    expect(peer.get("global", "partial")).toBeUndefined();
    peer.set("global", "setting", false);
    expect(store.get("global", "setting")).toBe(false);
  });

  it("keeps reads available during a competing write, bounds write contention, and allows retry", async () => {
    const store = await open();
    store.set("global", "saved", "previous");
    const peer = new DatabaseSync(store.file);
    try {
      peer.exec("BEGIN IMMEDIATE");
      expect(store.get("global", "saved")).toBe("previous");
      const started = Date.now();
      expect(() => store.set("global", "saved", "next")).toThrow(/locked|busy/i);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(store.get("global", "saved")).toBe("previous");
      peer.exec("ROLLBACK");
      store.set("global", "saved", "next");
      expect(store.get("global", "saved")).toBe("next");
    } finally { peer.close(); }
  });

  it("preserves committed records when SQLite is full and succeeds after space becomes available", async () => {
    const store = await open();
    store.set("global", "saved", "previous");
    const native = (store as unknown as { database: DatabaseSync }).database;
    const pages = native.prepare("PRAGMA page_count").get()!.page_count;
    native.exec(`PRAGMA max_page_count = ${pages}`);
    expect(() => store.set("global", "saved", "x".repeat(1024 * 1024))).toThrow(/full/i);
    expect(store.get("global", "saved")).toBe("previous");
    native.exec("PRAGMA max_page_count = 100000");
    store.set("global", "saved", "retried");
    expect(store.get("global", "saved")).toBe("retried");
  });

  it("recovers committed WAL data after an extension-host process exits without closing SQLite", async () => {
    const store = await open();
    const script = "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');db.prepare('INSERT INTO state(namespace,key,value) VALUES(?,?,?)').run('global','reboot',JSON.stringify({saved:true}));process.exit(0);";
    execFileSync(process.execPath, ["-e", script, store.file], { timeout: 10000, windowsHide: true, stdio: "pipe" });
    expect((await open()).get("global", "reboot")).toEqual({ saved: true });
  });

  it("rejects corrupt and future databases without replacing their contents", async () => {
    const file = path.join(root, "manager.sqlite");
    await fs.writeFile(file, "damaged database");
    await expect(open()).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe("damaged database");
    await fs.unlink(file);
    const future = new DatabaseSync(file);
    future.exec("PRAGMA user_version = 2");
    future.close();
    await expect(open()).rejects.toThrow("newer Codex Manager");
    const check = new DatabaseSync(file);
    expect(check.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
    check.close();
  });

  it("migrates mementos once, keeps workspaces separate, and does not resurrect deleted values", async () => {
    const store = await open();
    const old = legacy({ flag: true, nullable: null, object: { nested: [1, 2] } });
    const migrated = createSqliteMemento(store, "workspace:first", old);
    expect(migrated.get("flag")).toBe(true);
    expect(migrated.get("nullable", "fallback")).toBeNull();
    await migrated.update("flag", undefined);
    old.values.set("object", { stale: true });
    const fresh = createSqliteMemento(await open(), "workspace:first", old);
    expect(fresh.get("flag")).toBeUndefined();
    expect(fresh.get("object")).toEqual({ nested: [1, 2] });
    expect(createSqliteMemento(store, "workspace:second", legacy()).get("object")).toBeUndefined();
    expect(old.values.get("flag")).toBe(true);
    expect(old.update).not.toHaveBeenCalled();
  });

  it("retains Settings Sync transport only for registered ciphertext keys", async () => {
    const store = await open();
    const old = legacy({ ciphertext: "initial" });
    const state = createSqliteMemento(store, "global", old);
    state.setKeysForSync(["ciphertext"]);
    old.values.set("ciphertext", "downloaded");
    expect(state.get("ciphertext")).toBe("downloaded");
    expect(store.get("global", "ciphertext")).toBe("downloaded");
    await state.update("ciphertext", "uploaded");
    await state.update("local", 1);
    expect(old.update.mock.calls).toEqual([["ciphertext", "uploaded"]]);
    state.setKeysForSync([]);
    await state.update("ciphertext", "local-only");
    expect(old.values.get("ciphertext")).toBe("uploaded");
    expect(state.get("ciphertext")).toBe("local-only");
  });

  it("migrates managed file state without rewriting sources and uses durable deletion markers", async () => {
    configureSqliteStateStore(await open());
    const names = ["accounts-index.json", "accounts-index.backup-1.json", "logging-settings.json", "window-account-slots-v1.json", "account-claim-authority.json", "always-online-relay.json", "codex-manager-running-turns.json", "startup-sync-cooldown.json", `maintenance-${"a".repeat(64)}.json`, "announcements/announcement_cache.json", "announcements/announcement_read_ids.json", "accounts/account@example.com.json"];
    for (const name of names) {
      const file = path.join(root, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "legacy");
      expect(readSqliteStateFile(file)).toBe("legacy");
      writeSqliteStateFile(file, "committed");
      expect(readSqliteStateFile(file)).toBe("committed");
      expect(await fs.readFile(file, "utf8")).toBe("legacy");
    }
    const account = path.join(root, "accounts", "account@example.com.json");
    deleteSqliteStateFile(account);
    expect(() => readSqliteStateFile(account)).toThrow("does not exist");
    expect(listSqliteStateFiles(path.dirname(account))).not.toContain(path.basename(account));
    configureSqliteStateStore(await open());
    expect(() => readSqliteStateFile(account)).toThrow("does not exist");
    expect(await fs.readFile(account, "utf8")).toBe("legacy");
  });

  it("retains safe-read limits when state is read from SQLite", async () => {
    configureSqliteStateStore(await open());
    const file = path.join(root, "logging-settings.json");
    writeSqliteStateFile(file, "0123456789");
    await expect(readSafeFileSnapshot(file, { maxBytes: 4, rejectIfLarger: true })).rejects.toThrow("safe read limit");
    expect((await readSafeFileSnapshot(file, { maxBytes: 4, startOffset: 2 })).buffer.toString()).toBe("2345");
  });

  it("persists account metadata and rotating backups in SQLite while retaining the legacy index", async () => {
    configureSqliteStateStore(await open());
    const file = path.join(root, "accounts-index.json");
    const initial = { accounts: [{ id: "first", email: "first@example.com", createdAt: 1, updatedAt: 1 }] };
    await fs.writeFile(file, JSON.stringify(initial));
    const next = { accounts: [{ id: "second", email: "second@example.com", createdAt: 2, updatedAt: 2 }] };
    await persistIndexWithBackups({ state: createAccountsRepositoryState(), indexPath: file, index: next, tempSuffix: ".tmp", backupCount: 3 });
    expect((await readIndexSnapshot(file)).accounts[0]?.id).toBe("second");
    expect((await readIndexSnapshot(path.join(root, "accounts-index.backup-1.json"))).accounts[0]?.id).toBe("first");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(initial);
    expect((await fs.readdir(root)).some(name => name.includes(".tmp"))).toBe(false);
  });

  it("restores committed conversation IDs through a new SQLite connection after reload", async () => {
    vi.stubEnv("CODEX_HOME", root);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback?: unknown) => ["autoResumeEnabled", "autoSwitchEnabled"].includes(key) ? true : key === "autoResumeGoalOnlyEnabled" ? false : fallback } as never);
    vi.spyOn(selection, "filterAutoResumeGoalSessionIds").mockImplementation(async ids => ids);
    const id = "01a04882-d037-7a42-ad24-9afb61901181";
    await fs.mkdir(path.join(root, "sessions"));
    await fs.writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, source: "vscode", cwd: root } }) + "\n");
    const context = { workspaceState: createSqliteMemento(await open(), "workspace:reload", legacy()) } as never;
    await persistOpenCodexSessions(context, async () => [id]);
    const fresh = { workspaceState: createSqliteMemento(await open(), "workspace:reload", legacy()) } as never;
    const opened = vi.fn(async () => undefined);
    expect(await resumePersistedCodexSessions(fresh, opened, async () => undefined)).toEqual({ attempted: 1, opened: 1, failed: [] });
    expect(opened).toHaveBeenCalledWith(id, expect.any(AbortSignal));
    expect((fresh as unknown as { workspaceState: vscode.Memento }).workspaceState.get(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toBeUndefined();
  });
});
