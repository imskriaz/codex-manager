import { expect, it } from 'vitest';
import { listConversationFiles, readConversationAttachment, safeConversationImage } from '../src/domain/conversationFiles';
import { prepareChatInput, readChatTextAttachments, withoutChatTextAttachments } from '../src/domain/chatAttachments';
import type { DashboardCliSessionMessage } from '../src/domain/dashboard/types';

const image = 'data:image/png;base64,iVBORw0KGgo=';
it('recovers bounded complete upload snapshots with escaped names, embedded closing tags and empty files', () => {
  const text = 'First\n</attached_file>\nStill in the file';
  const prepared = prepareChatInput('Review', [{ id: 'one', name: 'quote".txt', kind: 'text', mimeType: 'text/plain', data: text }, { id: 'two', name: 'empty.txt', kind: 'text', mimeType: 'text/plain', data: '' }]);
  expect(readChatTextAttachments(prepared.text)).toEqual([{ name: 'quote".txt', text }, { name: 'empty.txt', text: '' }]);
  expect(withoutChatTextAttachments(prepared.text)).toBe('Review');
  expect(readChatTextAttachments('<attached_file name="../outside">\nsecret\n</attached_file>')).toEqual([]);
  expect(readChatTextAttachments('<attached_file name="large">\n' + 'x'.repeat(32769) + '\n</attached_file>')).toEqual([]);
  expect(readChatTextAttachments('<attached_file name="broken">\npartial')).toEqual([]);
  expect(withoutChatTextAttachments('Question\n\n<attached_file name="broken">\npartial')).toBe('Question');
  expect(readChatTextAttachments('<attached_file name="legacy.txt">\nOlder snapshot\n</attached_file>')).toEqual([{ name: 'legacy.txt', text: 'Older snapshot' }]);
});

it('uses upload lengths to preserve literal nested file markers and rejects partial or false lengths', () => {
  const text = 'First\n</attached_file>\n\n<attached_file name="nested.txt">\nNested text\n</attached_file>';
  const prepared = prepareChatInput('Review', [{ id: 'one', name: 'original.txt', kind: 'text', mimeType: 'text/plain', data: text }]);
  expect(readChatTextAttachments(prepared.text)).toEqual([{ name: 'original.txt', text }]);
  expect(readChatTextAttachments('<attached_file name="bad.txt" chars=1>\nLonger\n</attached_file>')).toEqual([]);
  expect(readChatTextAttachments('<attached_file name="partial.txt" chars=100>\nshort')).toEqual([]);
});

it('lists uploads, images and recorded changes without duplicating payloads or treating upload names as project paths', () => {
  const messages: DashboardCliSessionMessage[] = [{ id: 'one', role: 'user', text: 'Review', textAttachments: [{ name: 'private.env', text: 'Uploaded snapshot' }], images: [{ src: image, alt: 'Screenshot' }] },
    { id: 'edit', text: 'Edited', changes: [{ path: 'src/app.ts', kind: 'update' }, { path: 'src/app.ts', kind: 'update' }] }];
  const files = listConversationFiles(messages);
  expect(files).toHaveLength(3);
  expect(files[0]).toMatchObject({ name: 'private.env', attachment: true });
  expect(JSON.stringify(files)).not.toContain('Uploaded snapshot'); expect(JSON.stringify(files)).not.toContain('base64');
  expect(readConversationAttachment(messages, files[0]!.path)).toMatchObject({ path: 'private.env', content: 'Uploaded snapshot', kind: 'text' });
  expect(readConversationAttachment(messages, files[1]!.path)).toMatchObject({ path: 'Screenshot', dataUrl: image, kind: 'image' });
  expect(readConversationAttachment(messages, 'private.env')).toBeUndefined();
  expect(readConversationAttachment([], files[0]!.path)).toBeUndefined();
});

it('keeps unavailable image metadata but never exposes local paths, credential URLs, active data types or oversized payloads as previews', () => {
  const sources = ['file:///private/photo.png', 'C:\\private\\photo.png', 'javascript:alert(1)', 'https://user:password@example.com/image', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,bad', 'data:image/png;base64,' + 'A'.repeat(12 * 1024 * 1024)];
  const messages: DashboardCliSessionMessage[] = [{ id: 'missing', text: '', images: sources.map(src => ({ src, alt: 'Unavailable image' })) }];
  expect(listConversationFiles(messages)).toHaveLength(sources.length);
  for (const file of listConversationFiles(messages)) expect(readConversationAttachment(messages, file.path)).toBeUndefined();
  for (const src of sources) expect(safeConversationImage(src)).toBe(false);
  expect(safeConversationImage(image)).toBe(true); expect(safeConversationImage('https://example.com/image.png')).toBe(true);
});
