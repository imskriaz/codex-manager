import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { readManuallyStoppedCodexSessionIds } from '../src/services/codexSessionResume';
import { filterAutoResumeGoalSessionIds } from '../src/services/codexSessionAutoResumeSelection';
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { clearCodexSessionManualStop, isCodexSessionAutoResumeDisabled, markCodexSessionManualStop, orderCodexSessionRecoveryIds, readCodexSessionPreferences, readCodexSessionTitleOverrides, writeCodexSessionPreference, writeCodexSessionTitleOverride, reconcileCodexSessionTitles, claimCodexSessionQueue, finishCodexSessionQueueClaim } from "../src/services/codexSessionPreferences";

const ids = [
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  "cccccccc-cccc-cccc-cccc-cccccccccccc"
];
let root: string | undefined;
let store: SqliteStateStore | undefined;

afterEach(async () => {
  configureSqliteStateStore(undefined);
  store?.close();
  store = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it("persists per-session recovery state and orders queued sessions after immediate work", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-session-preferences-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
  writeCodexSessionPreference(root, ids[0]!, { autoResume: false });
  writeCodexSessionPreference(root, ids[1]!, { queue: true, priority: 1 });
  writeCodexSessionPreference(root, ids[2]!, { queue: true, priority: 2 });
  expect(isCodexSessionAutoResumeDisabled(root, ids[0]!)).toBe(true);
  expect(readCodexSessionPreferences(root, ids).get(ids[1]!)?.priority).toBe(1);
  expect(orderCodexSessionRecoveryIds(root, ids)).toEqual([ids[0], ids[1], ids[2]]);
});

it("retains a just-renamed title across a catalogue refresh", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-session-preferences-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
  writeCodexSessionTitleOverride(root, ids[0]!, "Fresh title");
  expect(readCodexSessionTitleOverrides(root, ids).get(ids[0]!)).toBe("Fresh title");
});

it("persists a manual stop suppression until the user resumes the session", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-session-preferences-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
  markCodexSessionManualStop(root, ids[0]!);
  expect(readCodexSessionPreferences(root, ids).get(ids[0]!)?.manualStop).toBe(true);
  clearCodexSessionManualStop(root, ids[0]!);
  expect(readCodexSessionPreferences(root, ids).get(ids[0]!)?.manualStop).toBeUndefined();
});

it('excludes stopped non-goals with missing transcript metadata after reopening storage', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codex-stopped-reload-'));
  const file = path.join(root, 'manager.sqlite');
  store = await SqliteStateStore.open(file); configureSqliteStateStore(store);
  writeCodexSessionPreference(root, ids[0]!, { queue: true, priority: 1 });
  markCodexSessionManualStop(root, ids[0]!, 'stopped-turn');
  store.close(); store = await SqliteStateStore.open(file); configureSqliteStateStore(store);
  expect(readCodexSessionPreferences(root, ids).get(ids[0]!)).toMatchObject({ manualStop: true, manualStopTurnId: 'stopped-turn', queue: false });
  expect(await filterAutoResumeGoalSessionIds([ids[0]!], root, undefined, false)).toEqual([]);
});

it('keeps Stop effective when storage fills and persists it once storage recovers', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codex-stopped-full-'));
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  const fail = vi.spyOn(store, 'set').mockImplementation(() => { throw new Error('storage full'); });
  expect(() => markCodexSessionManualStop(root!, ids[0]!, 'stopped-turn')).toThrow('storage full');
  expect(readCodexSessionPreferences(root, ids).get(ids[0]!)?.manualStop).toBe(true);
  fail.mockRestore();
  expect(readCodexSessionPreferences(root, ids).get(ids[0]!)?.manualStop).toBe(true);
  store.close(); store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  expect(readCodexSessionPreferences(root, ids).get(ids[0]!)?.manualStop).toBe(true);
  clearCodexSessionManualStop(root, ids[0]!);
});

it('retires the Stop marker only after a different native turn is recorded', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codex-stopped-next-'));
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  await mkdir(path.join(root, 'sessions'));
  const transcript = path.join(root, 'sessions', `rollout-${ids[0]}.jsonl`);
  await writeFile(transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'old-turn' } }) + '\n');
  markCodexSessionManualStop(root, ids[0]!, 'old-turn');
  expect(await readManuallyStoppedCodexSessionIds(root, [ids[0]!])).toEqual([ids[0]]);
  await appendFile(transcript, JSON.stringify({ timestamp: new Date(Date.now() - 60000).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'delayed-old-turn' } }) + '\n');
  expect(await readManuallyStoppedCodexSessionIds(root, [ids[0]!])).toEqual([ids[0]], 'A delayed older turn cannot clear Stop');
  await appendFile(transcript, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-user-turn' } }) + '\n');
  expect(await readManuallyStoppedCodexSessionIds(root, [ids[0]!])).toEqual([]);
  expect(readCodexSessionPreferences(root, ids).get(ids[0]!)?.manualStop).toBeUndefined();
});

it("retires confirmed title overrides so later native renames are visible", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-session-preferences-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
  writeCodexSessionTitleOverride(root, ids[0]!, "Dashboard rename");
  expect(reconcileCodexSessionTitles(root, [{ id: ids[0]!, title: 'Old title' }]).get(ids[0]!)).toBe('Dashboard rename');
  expect(reconcileCodexSessionTitles(root, [{ id: ids[0]!, title: 'Dashboard rename' }]).size).toBe(0);
  expect(readCodexSessionTitleOverrides(root, ids).size).toBe(0);
  expect(reconcileCodexSessionTitles(root, [{ id: ids[0]!, title: 'Later native rename' }]).size).toBe(0);
});

it("does not let an old scheduler claim overwrite a later user queue change", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-session-preferences-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
  writeCodexSessionPreference(root, ids[0]!, { queue: true, priority: 1, queueRevision: 'first' });
  const claim = claimCodexSessionQueue(root, ids[0]!, 'first')!;
  expect(claim).toBeTruthy(); expect(claimCodexSessionQueue(root, ids[0]!, 'first')).toBeUndefined();
  writeCodexSessionPreference(root, ids[0]!, { queue: true, priority: 3, queueRevision: 'second', queueClaimId: undefined, queueClaimedAt: undefined });
  finishCodexSessionQueueClaim(root, ids[0]!, claim, 'Old failure');
  expect(readCodexSessionPreferences(root, ids).get(ids[0]!)).toMatchObject({ queue: true, priority: 3, queueRevision: 'second' });
  expect(readCodexSessionPreferences(root, ids).get(ids[0]!)?.queueError).toBeUndefined();
  expect(claimCodexSessionQueue(root, ids[0]!, 'first')).toBeUndefined();
  const second = claimCodexSessionQueue(root, ids[0]!, 'second')!;
  finishCodexSessionQueueClaim(root, ids[0]!, second, 'Unconfirmed start');
  expect(claimCodexSessionQueue(root, ids[0]!, 'second')).toBeUndefined();
});
