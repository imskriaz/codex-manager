import { afterEach, expect, it, vi } from 'vitest';
import { loadTaskBoardColumns, saveTaskBoardColumns, loadTaskBoardView, saveTaskBoardView } from '../webview-src/dashboard/preferences';

afterEach(() => vi.unstubAllGlobals());
it('shows Idea by default and restores valid column choices without duplicates', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) } });
  expect(loadTaskBoardColumns()).toEqual(['idea', 'planned', 'running', 'completed']);
  expect(saveTaskBoardColumns(['idea', 'completed'])).toBe(true);
  expect(loadTaskBoardColumns()).toEqual(['idea', 'completed']);
  expect(saveTaskBoardColumns(['planned', 'running', 'completed'])).toBe(true);
  expect(loadTaskBoardColumns()).toEqual(['planned', 'running', 'completed']);
  values.set('codexManager.taskBoardColumns.v1', '["idea","idea"]');
  expect(loadTaskBoardColumns()).toEqual(['idea']);
  for (const value of ['[]', 'null', '{}', '["unknown"]', '{broken']) {
    values.set('codexManager.taskBoardColumns.v1', value);
    expect(loadTaskBoardColumns()).toEqual(['idea', 'planned', 'running', 'completed']);
  }
});
it('keeps useful defaults when storage is unavailable and reports unsaved preferences', () => {
  vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('offline storage'); }, setItem: () => { throw new Error('storage full'); } } });
  expect(loadTaskBoardColumns()).toEqual(['idea', 'planned', 'running', 'completed']);
  expect(saveTaskBoardColumns(['completed'])).toBe(false);
  expect(loadTaskBoardView()).toBe('board');
  expect(saveTaskBoardView('list')).toBe(false);
});

it('restores each display choice and defaults safely for missing or stale values', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) } });
  expect(loadTaskBoardView()).toBe('board');
  for (const view of ['list', 'gantt', 'calendar', 'board'] as const) {
    expect(saveTaskBoardView(view)).toBe(true);
    expect(loadTaskBoardView()).toBe(view);
  }
  for (const value of ['', 'unknown', '{}', 'null']) {
    values.set('codexManager.taskBoardView.v1', value);
    expect(loadTaskBoardView()).toBe('board');
  }
});
