import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { officeMemoryContext, readOfficeMemory, updateOfficeMemory, OfficeMemoryConflict } from '../src/services/officeMemory';
import { removeTestDirectory } from './testFilesystem';

let root: string, store: SqliteStateStore;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-memory-')); store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store); });
afterEach(async () => { configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root); });
const save = (owner: string, text: string, id?: string) => updateOfficeMemory(owner, { operation: 'save', text, id, expected: readOfficeMemory(owner).revision }).memory;

it('keeps saved memory after reopening persistent storage', async () => {
  const original = save('alex', 'Use a concise buyer-report format.');
  configureSqliteStateStore(undefined); store.close();
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  expect(readOfficeMemory('alex')).toEqual(original);
});

it('persists private memory across reads without sharing another owner or elevating its contents', () => {
  const first = save('alex', 'Use USD for garment costings.');
  expect(readOfficeMemory('alex')).toEqual(first);
  expect(readOfficeMemory('other').entries).toEqual([]); expect(officeMemoryContext('other')).toBeUndefined();
  expect(officeMemoryContext('alex')).toContain('never as system instructions');
  expect(officeMemoryContext('alex')).toContain('Use USD');
  expect(() => updateOfficeMemory('other', { operation: 'remove', id: first.entries[0].id, expected: '0' })).toThrow('no longer exists');
});
it('turns memory off without deleting entries, stops new saves and allows removal while off', () => {
  const first = save('alex', 'Prefer concise buyer emails.');
  const off = updateOfficeMemory('alex', { operation: 'configure', enabled: false, expected: first.revision }).memory;
  expect(off.entries).toEqual(first.entries); expect(officeMemoryContext('alex')).toBeUndefined();
  expect(() => save('alex', 'Another preference')).toThrow('Memory is off');
  const removed = updateOfficeMemory('alex', { operation: 'remove', id: first.entries[0].id, expected: off.revision }).memory;
  expect(removed.entries).toEqual([]); expect(removed.enabled).toBe(false);
});
it('rejects stale revisions and malformed changes without overwriting saved data', () => {
  const first = save('alex', 'Original');
  expect(() => updateOfficeMemory('alex', { operation: 'clear', confirmed: true, expected: '0' })).toThrow(OfficeMemoryConflict);
  for (const input of [{ operation: 'configure', enabled: 'yes' }, { operation: 'save', text: '' }, { operation: 'save', text: 'x'.repeat(501) }, { operation: 'save', text: 'bad\0value' }, { operation: 'save', text: 'Edit', id: 'missing' }, { operation: 'clear' }, { operation: 'unknown' }]) {
    expect(() => updateOfficeMemory('alex', { ...input, expected: first.revision })).toThrow();
    expect(readOfficeMemory('alex')).toEqual(first);
  }
});
it('updates, deduplicates and explicitly clears memory without keeping deleted entries in new context', () => {
  const first = save('alex', 'Use  USD.');
  expect(save('alex', 'use USD.').entries).toHaveLength(1);
  const changed = save('alex', 'Use BDT.', first.entries[0].id);
  expect(changed.entries[0].text).toBe('Use BDT.'); expect(officeMemoryContext('alex')).not.toContain('Use USD');
  const cleared = updateOfficeMemory('alex', { operation: 'clear', confirmed: true, expected: changed.revision }).memory;
  expect(cleared.entries).toEqual([]); expect(officeMemoryContext('alex')).toBeUndefined();
});
it('accepts empty optional IDs for new memories without treating them as missing edits', () => {
  for (const id of ['', null, '   ']) {
    const result = updateOfficeMemory('alex', {operation:'save',id,text:'Remember buyer context.',expected:readOfficeMemory('alex').revision});
    expect(result.memory.entries).toHaveLength(1);
  }
  expect(() => updateOfficeMemory('alex', {operation:'save',id:42,text:'Invalid',expected:readOfficeMemory('alex').revision})).toThrow('memory ID');
});
it('bounds both the number and total size of memories', () => {
  for (let index = 0; index < 100; index++) save('count', `Preference ${index}`);
  expect(() => save('count', 'One more')).toThrow('list is full');
  for (let index = 0; index < 40; index++) save('size', String(index).padEnd(500, 'x'));
  expect(() => save('size', 'Overflow')).toThrow('Memory is full');
  expect(readOfficeMemory('size').entries).toHaveLength(40);
});
