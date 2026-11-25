import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../webview-src/dashboard/teamSettingsRequest', () => ({ request: vi.fn() }));
import { request } from '../webview-src/dashboard/teamSettingsRequest';
import { bindLocalFolderConnections, ensureLocalFolderConnection, selectLocalFolderProject, forgetLocalFolder, chooseLocalFolder, performLocalFolderCommand, type LocalDirectory } from '../webview-src/dashboard/localFolderConnection';

function directory(name = 'Project') {
  const entries = new Map<string, any>();
  const handle = {
    name, kind: 'directory', queryPermission: async () => 'granted',
    async *values() { yield* entries.values(); },
    getDirectoryHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!entries.has(name) && options?.create) entries.set(name, directory(name).handle);
      const value = entries.get(name);
      if (!value || value.kind !== 'directory') throw new DOMException('Missing directory', 'NotFoundError');
      return value;
    }),
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!entries.has(name) && options?.create) add(name, '');
      const value = entries.get(name);
      if (!value || value.kind !== 'file') throw new DOMException('Missing file', 'NotFoundError');
      return value;
    })
  } as unknown as LocalDirectory;
  function add(name: string, text: string) {
    let content = new TextEncoder().encode(text);
    const abort = vi.fn(async () => {}), close = vi.fn(async () => {});
    const entry = { name, kind: 'file', getFile: async () => new File([content], name), createWritable: vi.fn(async () => ({ write: async (bytes: Uint8Array) => { content = bytes; }, close, abort })) };
    entries.set(name, entry); return entry;
  }
  return { handle, entries, add };
}
afterEach(() => vi.unstubAllGlobals());
it('keeps passive permission checks silent and requires access only when sending',async()=>{
  const root=directory('Outlook'),permission=vi.spyOn(root.handle,'queryPermission').mockResolvedValue('prompt');
  const records=new Map([['["alex","/outlook"]',{owner:'alex',project:'/outlook',handle:root.handle}]]);
  const get=vi.fn((key:string)=>{const reading={result:records.get(key),onsuccess:undefined as (()=>void)|undefined};queueMicrotask(()=>reading.onsuccess?.());return reading;});
  const opening=vi.fn(()=>{const db={result:{transaction:()=>{const transaction={objectStore:()=>({get,put:()=>queueMicrotask(()=>transaction.oncomplete?.()),delete:(key:string)=>{records.delete(key);queueMicrotask(()=>transaction.oncomplete?.());}}),oncomplete:undefined as (()=>void)|undefined};return transaction;},close:vi.fn()},onsuccess:undefined as (()=>void)|undefined};queueMicrotask(()=>db.onsuccess?.());return db;});
  vi.stubGlobal('indexedDB',{open:opening});const notice=vi.fn(),unbind=bindLocalFolderConnections('alex',notice);
  try {
    await Promise.resolve();expect(opening).not.toHaveBeenCalled();expect(notice).not.toHaveBeenCalled();
    selectLocalFolderProject('/other');await vi.waitFor(()=>expect(get).toHaveBeenCalledWith('["alex","/other"]'));expect(permission).not.toHaveBeenCalled();
    selectLocalFolderProject('/outlook');await vi.waitFor(()=>expect(permission).toHaveBeenCalledOnce());expect(notice).not.toHaveBeenCalled();
    await expect(ensureLocalFolderConnection('/outlook')).rejects.toThrow('Folder access is needed');expect(notice).not.toHaveBeenCalled();
    await forgetLocalFolder('/outlook');await expect(ensureLocalFolderConnection('/outlook')).rejects.toThrow('draft has been kept');expect(notice).not.toHaveBeenCalled();expect(permission).toHaveBeenCalledTimes(2);
    records.set('["alex","/outlook"]',{owner:'alex',project:'/outlook',handle:root.handle});permission.mockResolvedValue('granted');vi.stubGlobal('window',{dispatchEvent:vi.fn()});
    vi.mocked(request).mockImplementation(async(_url,_method,body)=>{
      const operation=(body as {operation:string}).operation;
      if(operation==='poll')return new Promise(()=>{});
      return operation==='connect'?{project:{id:'outlook',path:'/outlook',label:'Outlook',localFolder:{name:'Outlook'}}}:{};
    });
    await Promise.all([ensureLocalFolderConnection('/outlook'),ensureLocalFolderConnection('/outlook')]);
    expect(vi.mocked(request).mock.calls.filter(([, ,body])=>(body as {operation:string}).operation==='connect')).toHaveLength(1);
    await ensureLocalFolderConnection('/outlook');expect(notice).not.toHaveBeenCalled();
  } finally {unbind();}
});

it('reads and revision-checks saves directly through the selected folder', async () => {
  const root = directory(); root.add('report.txt', 'Before');
  const read = await performLocalFolderCommand(root.handle, { id: 'read', operation: 'read', path: 'report.txt' });
  expect(atob(read.data!)).toBe('Before'); expect(read.revision).toMatch(/^[a-f0-9]{64}$/);
  const saved = await performLocalFolderCommand(root.handle, { id: 'write', operation: 'write', path: 'report.txt', revision: read.revision, data: btoa('After') });
  expect(saved.revision).not.toBe(read.revision);
  expect(atob((await performLocalFolderCommand(root.handle, { id: 'r2', operation: 'read', path: 'report.txt' })).data!)).toBe('After');
});
it('preserves existing files when the revision is absent, stale or changes during save', async () => {
  const root = directory(), entry = root.add('report.txt', 'Original');
  await expect(performLocalFolderCommand(root.handle, { id: 'write', operation: 'write', path: 'report.txt', data: btoa('Changed') })).rejects.toThrow('exists or changed');
  await expect(performLocalFolderCommand(root.handle, { id: 'write', operation: 'write', path: 'report.txt', revision: 'old', data: btoa('Changed') })).rejects.toThrow('exists or changed');
  expect(entry.createWritable).not.toHaveBeenCalled();
});
it('creates nested files without importing the folder or altering other entries', async () => {
  const root = directory(); root.add('keep.txt', 'Keep');
  await performLocalFolderCommand(root.handle, { id: 'write', operation: 'write', path: 'output/report.txt', data: btoa('Report') });
  expect(atob((await performLocalFolderCommand(root.handle, { id: 'read', operation: 'read', path: 'output/report.txt' })).data!)).toBe('Report');
  const listed = await performLocalFolderCommand(root.handle, { id: 'list', operation: 'list' });
  expect(listed.files?.map(file => file.path)).toEqual(['keep.txt', 'output', 'output/report.txt']);
  expect(root.entries.get('keep.txt').createWritable).not.toHaveBeenCalled();
});
it.each(['../secret', '/secret', 'C:/secret', 'nested/../../secret', 'nested\\secret', './secret', 'nested//secret'])('rejects escaping or ambiguous paths: %s', async path => {
  const root = directory();
  await expect(performLocalFolderCommand(root.handle, { id: 'read', operation: 'read', path })).rejects.toThrow('relative path');
  expect(root.handle.getDirectoryHandle).not.toHaveBeenCalled(); expect(root.handle.getFileHandle).not.toHaveBeenCalled();
});
it('never starts expired writes and surfaces permission failures', async () => {
  const root = directory();
  await expect(performLocalFolderCommand(root.handle, { id: 'write', operation: 'write', path: 'new.txt', data: btoa('New'), expiresAt: Date.now() - 1 })).rejects.toThrow('expired');
  expect(root.entries.size).toBe(0);
  vi.mocked(root.handle.getFileHandle).mockRejectedValue(new DOMException('Permission revoked', 'NotAllowedError'));
  await expect(performLocalFolderCommand(root.handle, { id: 'read', operation: 'read', path: 'new.txt' })).rejects.toThrow('Permission revoked');
});
it('uses the directory permission picker and reports an unsupported browser', async () => {
  const root = directory(), picker = vi.fn(async () => root.handle);
  vi.stubGlobal('document', { documentElement: { dataset: { dashboardHost: 'browser' } } });
  vi.stubGlobal('window', { showDirectoryPicker: picker, isSecureContext: true });
  expect(await chooseLocalFolder()).toBe(root.handle); expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' });
  vi.stubGlobal('window', { isSecureContext: true });
  await expect(chooseLocalFolder()).rejects.toThrow('Chrome or Edge');
});
it('downloads bounded chunks and rejects revisions that change between chunks', async () => {
  const root = directory(); root.add('report.txt', 'Before');
  const first = await performLocalFolderCommand(root.handle, { id: 'download', operation: 'read', path: 'report.txt', offset: 2 });
  expect(first.size).toBe(6); expect(atob(first.data!)).toBe('fore');
  await expect(performLocalFolderCommand(root.handle, { id: 'stale', operation: 'read', path: 'report.txt', offset: 2, revision: 'old' })).rejects.toThrow('changed during download');
});
