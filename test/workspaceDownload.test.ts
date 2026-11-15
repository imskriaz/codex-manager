import { expect, it, vi } from 'vitest';
import { downloadWorkspaceFile } from '../webview-src/dashboard/workspaceDownload';

it('assembles original bytes once, including an empty file', async () => {
  const request = vi.fn().mockResolvedValueOnce({ workspaceFileDownload: { path: 'a.vsix', revision: 'v', offset: 0, size: 3, data: '/wAB' } });
  const save = vi.fn();
  await downloadWorkspaceFile('a.vsix', request, save);
  expect(Buffer.from(await (save.mock.calls[0]![0] as Blob).arrayBuffer())).toEqual(Buffer.from([255, 0, 1]));
  expect(save.mock.calls[0]![1]).toBe('a.vsix');
  request.mockResolvedValueOnce({ workspaceFileDownload: { revision: 'v', offset: 0, size: 0, data: '' } });
  await downloadWorkspaceFile('empty', request, save);
  expect((save.mock.calls[1]![0] as Blob).size).toBe(0);
});

it.each([undefined, { offset: 1, size: 1, data: 'YQ==' }, { offset: 0, size: 2, data: '' }])('never saves a missing or partial download: %j', async result => {
  const save = vi.fn();
  await expect(downloadWorkspaceFile('file', vi.fn().mockResolvedValue({ workspaceFileDownload: result }), save)).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
});

it('does not replay or save after disconnect or changed-file rejection', async () => {
  const request = vi.fn().mockResolvedValueOnce({ workspaceFileDownload: { revision: 'v', offset: 0, size: 4, data: 'YQ==' } }).mockRejectedValueOnce(new Error('File changed or disconnected'));
  const save = vi.fn();
  await expect(downloadWorkspaceFile('file', request, save)).rejects.toThrow('changed or disconnected');
  expect(request).toHaveBeenCalledTimes(2);
  expect(save).not.toHaveBeenCalled();
});
