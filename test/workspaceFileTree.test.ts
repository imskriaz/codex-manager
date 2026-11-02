import { promises as fs } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listWorkspaceFiles } from '../src/services/workspaceTools';

const root = process.cwd();
const entry = (name: string, type: 'file' | 'directory' | 'link' = 'file') => ({ name,
  isFile: () => type === 'file', isDirectory: () => type === 'directory', isSymbolicLink: () => type === 'link' });
const folders = vscode.workspace.workspaceFolders;
beforeEach(() => Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: vscode.Uri.file(root) }] }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: folders }); });
function mockTree(read: (directory: string) => Promise<ReturnType<typeof entry>[]>) {
  return vi.spyOn(fs, 'readdir').mockImplementation(((directory: Parameters<typeof fs.readdir>[0]) => read(String(directory))) as typeof fs.readdir);
}

it('lists siblings concurrently, preserves sorted tree order, and excludes dependencies and links', async () => {
  let active = 0, peak = 0;
  const read = mockTree(async directory => {
    if (directory === root) return [entry('z.txt'), ...Array.from({ length: 12 }, (_, index) => entry(`dir${String(index).padStart(2, '0')}`, 'directory')), entry('node_modules', 'directory'), entry('.git', 'directory'), entry('outside', 'link')];
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return [entry('proof.txt')];
  });
  const result = await listWorkspaceFiles(root);
  expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(8);
  expect(result.warning).toBeUndefined(); expect(result.files).toHaveLength(25);
  expect(result.files.slice(0, 3)).toEqual([
    { path: 'dir00', name: 'dir00', type: 'directory', depth: 0 },
    { path: 'dir00/proof.txt', name: 'proof.txt', type: 'file', depth: 1 },
    { path: 'dir01', name: 'dir01', type: 'directory', depth: 0 }
  ]);
  expect(result.files.at(-1)?.path).toBe('z.txt'); expect(read).toHaveBeenCalledTimes(13);
});

it.each(['EACCES', 'ENOENT', 'EBUSY'])('keeps readable siblings when a nested folder fails with %s and retries it on refresh', async code => {
  let failing = true;
  mockTree(async directory => {
    if (directory === root) return [entry('busy', 'directory'), entry('readable', 'directory'), entry('root.txt')];
    if (directory === join(root, 'busy') && failing) throw Object.assign(new Error(code), { code });
    return [entry('proof.txt')];
  });
  const result = await listWorkspaceFiles(root);
  expect(result.warning).toContain('refresh to retry');
  expect(result.warning).toContain(code);
  expect(result.files.map(file => file.path)).toContain('root.txt');
  expect(result.files.map(file => file.path)).toContain('readable/proof.txt');
  failing = false;
  const refreshed = await listWorkspaceFiles(root);
  expect(refreshed.warning).toBeUndefined(); expect(refreshed.files.map(file => file.path)).toContain('busy/proof.txt');
});

it('returns the readable tree within its deadline and safely ignores a late failed read', async () => {
  vi.useFakeTimers();
  let fail!: (error: Error) => void;
  mockTree(async directory => directory === root ? [entry('stalled', 'directory'), entry('root.txt')] : new Promise((_, reject) => { fail = reject; }));
  const pending = listWorkspaceFiles(root);
  await vi.advanceTimersByTimeAsync(5_001);
  const result = await pending;
  expect(result.warning).toContain('Some folders'); expect(result.files.map(file => file.path)).toContain('root.txt');
  fail(new Error('Drive disconnected')); await vi.advanceTimersByTimeAsync(1);
  expect(result.files).toHaveLength(2);
});

it('reports an unavailable root as a failure and allows a subsequent retry', async () => {
  const read = mockTree(async () => { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }); });
  await expect(listWorkspaceFiles(root)).rejects.toThrow('Access denied');
  read.mockResolvedValue([] as never);
  await expect(listWorkspaceFiles(root)).resolves.toEqual({ files: [] });
});

it('bounds stalled root reads without claiming another application is writing', async () => {
  vi.useFakeTimers(); mockTree(() => new Promise(() => undefined));
  const pending = expect(listWorkspaceFiles(root)).rejects.toThrow('Check access or reconnect the drive');
  await vi.advanceTimersByTimeAsync(5_001); await pending;
});

it('caps the tree explicitly and retains root files before descending into large folders', async () => {
  mockTree(async directory => directory === root ? [entry('large', 'directory'), entry('root.txt')] : Array.from({ length: 5_100 }, (_, index) => entry(`file-${index}`)));
  const result = await listWorkspaceFiles(root);
  expect(result.files).toHaveLength(5_000); expect(result.warning).toContain('5,000');
  expect(result.files.map(file => file.path)).toContain('root.txt');
});
