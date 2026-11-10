import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { hydrateSessionImages } from '../src/services/codexSessionImages';
import { MAX_CHAT_ATTACHMENT_BYTES } from '../src/domain/chatAttachments';
import { removeTestDirectory } from './testFilesystem';
import { combineCliLiveMessages } from '../src/domain/codexSessionLive';
import { reserveCodexSessionLive } from '../src/services/codexSessionLive';
import { subscribeDashboardRealtime } from '../src/services/dashboardRealtime';

let root: string;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=', 'base64');
beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), 'manager-images-')); });
afterEach(async () => { await removeTestDirectory(root); });
it('hydrates native paths and escaped file URLs into portable raster data', async () => {
  const file = path.join(root, 'image # test.png'); await fs.writeFile(file, png);
  for (const src of [file, pathToFileURL(file).href]) {
    const result = await hydrateSessionImages([{ id: 'image', kind: 'image', text: 'image.png', images: [{ src, alt: 'Viewed image' }] }]);
    expect(result[0]?.images).toEqual([{ src: `data:image/png;base64,${png.toString('base64')}`, alt: 'Viewed image' }]);
  }
});
it('removes unreadable, non-image and oversized local sources instead of returning broken file URLs', async () => {
  const file = path.join(root, 'fake.png'), large = path.join(root, 'large.png');
  await fs.writeFile(file, 'not an image'); await fs.writeFile(large, png); await fs.truncate(large, MAX_CHAT_ATTACHMENT_BYTES + 1);
  for (const src of [path.join(root, 'missing.png'), file, large, root, 'file://invalid/%ZZ']) {
    expect((await hydrateSessionImages([{ id: src, text: 'Viewed image', images: [{ src }] }]))[0]?.images).toEqual([]);
  }
});
it('preserves valid remote and inline previews and never replaces a hydrated image with a live local path', () => {
  const history = [{ id: 'image', kind: 'image' as const, turnId: 'turn', text: 'image.png', images: [{ src: 'data:image/png;base64,AA==' }] }];
  const live = { sessionId: 'session', streamId: 'stream', sequence: 1, updatedAt: 1, status: 'running' as const, turnId: 'turn', messages: [{ ...history[0]!, images: [{ src: path.join(root, 'image.png') }] }] };
  expect(combineCliLiveMessages(history, live)[0]?.images).toEqual(history[0]?.images);
});
it('publishes a hydrated live image with a newer revision without waiting for turn completion', async () => {
  const file = path.join(root, 'live.png'); await fs.writeFile(file, png);
  const sessionId = '01a04882-d037-7a42-ad24-9afb61901177';
  const hydrated = new Promise<void>(resolve => {
    const stop = subscribeDashboardRealtime(message => {
      if (message.type === 'dashboard:codex-session-live' && message.state.sessionId === sessionId && message.state.messages[0]?.images?.[0]?.src.startsWith('data:')) { stop(); resolve(); }
    });
  });
  const stream = reserveCodexSessionLive();
  try {
    stream.attach(sessionId, { onNotification: () => () => undefined } as never, () => [{ id: 'live', kind: 'image', text: 'live.png', images: [{ src: file }] }]);
    await hydrated;
  } finally { stream.finish('completed'); stream.dispose(); }
});
