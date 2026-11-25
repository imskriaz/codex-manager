import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ value: undefined as string | undefined, update: vi.fn() }));
vi.mock('../src/infrastructure/config/extensionSettings', () => ({ getCodexManagerConfiguration: () => ({ get: (_key: string, fallback: string) => state.value ?? fallback, update: state.update }) }));
vi.mock('../src/utils/crossWindowOperations', () => ({ runCrossWindowExclusive: (_key: string, _title: string, task: () => unknown) => task() }));
import { readCodexFallbackCatalog, rememberDiscoveredCodexModels, saveCodexFallbackCatalog } from '../src/services/codexFallbackCatalog';
beforeEach(() => { state.value = 'custom-model\ngpt-6.2-sol'; state.update.mockReset().mockImplementation(async (_key, value) => { state.value = value; }); });
it('adds live model IDs without losing user entries and avoids redundant writes', async () => {
  await rememberDiscoveredCodexModels(['gpt-6.2-sol', 'new-model']);
  expect(readCodexFallbackCatalog()).toBe('custom-model\ngpt-6.2-sol\nnew-model');
  await rememberDiscoveredCodexModels(['new-model']);
  expect(state.update).toHaveBeenCalledOnce();
});
it('rejects stale edits, invalid IDs and unconfirmed writes', async () => {
  await expect(saveCodexFallbackCatalog('edited-model', 'old-model')).rejects.toThrow('changed');
  expect(() => saveCodexFallbackCatalog('bad$model', state.value!)).toThrow('valid');
  state.update.mockResolvedValue(undefined);
  await expect(saveCodexFallbackCatalog('edited-model', state.value!)).rejects.toThrow('could not be confirmed');
});
it('saves edited and empty lists', async () => {
  await expect(saveCodexFallbackCatalog('edited-model, edited-model', state.value!)).resolves.toBe('edited-model');
  await expect(saveCodexFallbackCatalog('', 'edited-model')).resolves.toBe('');
});
it('allows a malformed setting to be corrected without losing conflict protection', async () => {
  state.value = 'bad$model';
  await expect(saveCodexFallbackCatalog('fixed-model', 'bad$model')).resolves.toBe('fixed-model');
});
