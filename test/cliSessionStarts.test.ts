import { expect, it, vi } from 'vitest';
import { readCliSessionStarts, writeCliSessionStarts } from '../webview-src/dashboard/cliSessionStarts';
import { cliComposerDraftKey } from '../webview-src/dashboard/cliSessionComposerState';

const start = (requestId: string) => ({ requestId, key: cliComposerDraftKey('pc', undefined, 'D:/project'), draft: { text: `Prompt ${requestId}`, attachments: [], autoApprove: true }, projectPath: 'D:/project' });
it('preserves concurrent prompts and access choices through a tab reload without replaying them', () => {
  let saved = '';
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  writeCliSessionStarts(storage, [start('one'), start('two')]);
  expect(readCliSessionStarts(storage)).toEqual([start('one'), start('two')]);
  writeCliSessionStarts(storage, [start('two')]);
  expect(readCliSessionStarts(storage)).toEqual([start('two')]);
});
it.each(['null', '{}', '[null]', '[{"key":"broken"}]', JSON.stringify([start('same'), start('same')]), JSON.stringify(Array.from({ length: 21 }, (_, index) => start(String(index))))])('preserves unreadable, duplicate, or oversized recovery records', saved => {
  const storage = { getItem: () => saved, setItem: vi.fn() };
  expect(() => readCliSessionStarts(storage)).toThrow();
  expect(storage.setItem).not.toHaveBeenCalled();
});
it('surfaces unavailable and full storage to the initiating UI', () => {
  expect(() => readCliSessionStarts({ getItem() { throw new Error('Storage unavailable'); } })).toThrow('Storage unavailable');
  expect(() => writeCliSessionStarts({ setItem() { throw new Error('Storage full'); } }, [start('one')])).toThrow('Storage full');
  expect(readCliSessionStarts({ getItem: () => null })).toEqual([]);
});
