import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SqliteStateStore } from '../src/storage/sqliteState';
import { readSessionRunTimings, saveSessionLive } from '../src/storage/sqliteSessions';
import { removeTestDirectory } from './testFilesystem';
import type { DashboardCodexSessionLiveState } from '../src/domain/dashboard/types';

let root: string, store: SqliteStateStore;
const id = '11111111-1111-4111-8111-111111111111';
const stream = (n: number) => `${String(n).padStart(8,'0')}-2222-4222-8222-222222222222`;
const snapshot = (n: number, at: number, sequence: number, status: DashboardCodexSessionLiveState['status'], turnId = 'turn-one'): DashboardCodexSessionLiveState => ({ sessionId: id, streamId: stream(n), turnId, sequence, updatedAt: at, status, messages: [] });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'manager-run-timings-')); store = await SqliteStateStore.open(join(root, 'manager.sqlite')); });
afterEach(async () => { store.close(); await removeTestDirectory(root); });

it('sums separate observed turns, deduplicates the same native turn, and excludes idle gaps', async () => {
  saveSessionLive(store, root, snapshot(1,1000,1,'running'));
  saveSessionLive(store, root, snapshot(1,6000,2,'completed'));
  saveSessionLive(store, root, snapshot(2,2000,1,'running'));
  saveSessionLive(store, root, snapshot(2,6500,2,'completed'));
  saveSessionLive(store, root, snapshot(3,10000,1,'running','turn-two'));
  saveSessionLive(store, root, snapshot(3,12000,2,'completed','turn-two'));
  saveSessionLive(store, root, snapshot(3,11000,1,'running','turn-two'));
  expect(readSessionRunTimings(store, root, [id]).get(id)).toEqual({ firstStartedAt:1000,lastObservedAt:12000,durationMs:7500,runCount:2 });
  const file = store.file; store.close(); store = await SqliteStateStore.open(file);
  expect(readSessionRunTimings(store, root, [id]).get(id)?.durationMs).toBe(7500);
});

it('does not invent past duration, count another home/device, or add time after the last observation', () => {
  saveSessionLive(store, root, snapshot(1,6000,1,'completed'));
  expect(readSessionRunTimings(store, root, [id]).has(id)).toBe(false);
  saveSessionLive(store, join(root,'another-home'), snapshot(2,1000,1,'running'));
  saveSessionLive(store, root, { ...snapshot(3,1000,1,'running'), deviceId:'another-device' });
  expect(readSessionRunTimings(store, root, [id]).has(id)).toBe(false);
  saveSessionLive(store, root, snapshot(4,15000,1,'running','active-turn'));
  saveSessionLive(store, root, snapshot(4,16000,2,'disconnected','active-turn'));
  expect(readSessionRunTimings(store, root, [id]).get(id)).toEqual({ firstStartedAt:15000,lastObservedAt:16000,durationMs:1000,runCount:1 });
});
