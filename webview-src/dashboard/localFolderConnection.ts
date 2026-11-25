import { localFolderPath, type LocalFolderCommand, type LocalFolderResult } from '../../src/domain/localFolder';
import type { DashboardCliProject, DashboardNotice } from '../../src/domain/dashboard/types';
import { request } from './teamSettingsRequest';

export type LocalDirectory = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};
const endpoint = '/api/workspace/local-folder';
type Connection = { handle: LocalDirectory; client: string; stopped: boolean; owner: string };
const connections = new Map<string, Connection>();
const newProjects = new WeakMap<LocalDirectory, { owner: string; id: string }>();
let owner: string | undefined;
let clientOwner: string | undefined, tabClient: string | undefined;
let feedback: (notice: DashboardNotice) => void = () => {};
const limit = 10 * 1024 * 1024;

export function supportsLocalFolders(): boolean {
  return typeof window !== 'undefined' && typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function' && window.isSecureContext && document.documentElement.dataset['dashboardHost'] === 'browser';
}
export async function chooseLocalFolder(): Promise<LocalDirectory> {
  if (!supportsLocalFolders()) throw new Error('Local folders need Chrome or Edge over HTTPS or localhost. You can still create a project without a local folder.');
  return (window as unknown as { showDirectoryPicker(options: { mode: 'readwrite' }): Promise<LocalDirectory> }).showDirectoryPicker({ mode: 'readwrite' });
}
async function revision(file: File): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
}
function encode(bytes: Uint8Array): string {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(value);
}
async function parent(root: LocalDirectory, path: string, create = false) {
  const parts = localFolderPath(path).split('/'), name = parts.pop()!;
  let directory: FileSystemDirectoryHandle = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name };
}

/** Only the chosen directory handle can resolve paths; no server path reaches the OS. */
export async function performLocalFolderCommand(root: LocalDirectory, command: LocalFolderCommand): Promise<LocalFolderResult> {
  const checkDeadline = () => { if (command.expiresAt !== undefined && Date.now() >= command.expiresAt) throw new Error('This folder request expired. Inspect the file before retrying.'); };
  checkDeadline();
  if (command.operation === 'list') {
    const files: NonNullable<LocalFolderResult['files']> = [], pending = [{ directory: root, prefix: '', depth: 0 }];
    const deadline = Date.now() + 5000;
    while (pending.length) {
      const { directory, prefix, depth } = pending.pop()!;
      for await (const entry of directory.values()) {
        if (files.length >= 2000 || Date.now() >= deadline) return { files, warning: 'Showing part of this folder. Open a smaller folder to see more.' };
        if (/^(?:\.git|node_modules|\.workspace-(?:sessions|history|trash))$/i.test(entry.name)) continue;
        const path = prefix + entry.name;
        files.push({ path, name: entry.name, type: entry.kind === 'directory' ? 'directory' : 'file', depth });
        if (entry.kind === 'directory' && depth < 8) pending.push({ directory: entry as LocalDirectory, prefix: path + '/', depth: depth + 1 });
      }
    }
    return { files };
  }
  if (command.operation !== 'read' && command.operation !== 'write') throw new Error('This local folder action is unavailable.');
  const { directory, name } = await parent(root, command.path!, command.operation === 'write');
  let handle: FileSystemFileHandle | undefined;
  try { handle = await directory.getFileHandle(name); } catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError' || command.operation !== 'write') throw error; }
  const existing = handle ? await handle.getFile() : undefined;
  if (existing && existing.size > limit) throw new Error('Keep connected-folder files under 10 MB.');
  if (command.operation === 'read') {
    if (command.offset !== undefined && (!Number.isSafeInteger(command.offset) || command.offset < 0 || command.offset > existing!.size)) throw new Error('The file download offset is invalid.');
    const stamp = await revision(existing!);
    if (command.revision && command.revision !== stamp) throw new Error('This file changed during download. Start the download again.');
    const blob = command.offset === undefined ? existing! : existing!.slice(command.offset, command.offset + 262144);
    return { data: encode(new Uint8Array(await blob.arrayBuffer())), revision: stamp, size: existing!.size };
  }
  if (typeof command.data !== 'string' || command.data.length > Math.ceil(limit / 3) * 4) throw new Error('Keep connected-folder files under 10 MB.');
  if (existing ? !command.revision || await revision(existing) !== command.revision : !!command.revision)
    throw new Error('This file exists or changed. Read its latest revision before saving.');
  const bytes = Uint8Array.from(atob(command.data), character => character.charCodeAt(0));
  if (bytes.length > limit) throw new Error('Keep connected-folder files under 10 MB.');
  checkDeadline();
  handle ??= await directory.getFileHandle(name, { create: true });
  // Recheck after opening: another program may have changed the file while permission was checked.
  if (existing && await revision(await handle.getFile()) !== command.revision) throw new Error('This file changed while saving. Read it again before retrying.');
  if (!existing && (await handle.getFile()).size !== 0) throw new Error('A file appeared while saving. Read it before retrying.');
  checkDeadline();
  const writable = await handle.createWritable();
  try { await writable.write(bytes); await writable.close(); }
  catch (error) { await writable.abort().catch(() => {}); throw error; }
  const saved = await handle.getFile();
  return { revision: await revision(saved), size: saved.size };
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('codex-manager-local-folders', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('folders', { keyPath: 'key' });
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(new Error('Local folder permission could not be remembered.'));
  });
}
async function remember(project: string, handle: LocalDirectory): Promise<void> {
  const savedOwner = owner;
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('folders', 'readwrite');
    transaction.objectStore('folders').put({ key: JSON.stringify([savedOwner, project]), owner: savedOwner, project, handle });
    transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(new Error('Local folder permission could not be remembered.'));
  }); } finally { db.close(); }
}
async function serve(project: string, connection: Connection) {
  while (!connection.stopped) {
    try {
      const { commands } = await request<{ commands: LocalFolderCommand[] }>(endpoint, 'POST', { operation: 'poll', project, client: connection.client });
      for (const command of commands) {
        if (connection.stopped || owner !== connection.owner) return;
        let result: LocalFolderResult | undefined, error: string | undefined;
        try { result = await performLocalFolderCommand(connection.handle, command); }
        catch (failure) { error = failure instanceof Error ? failure.message : 'The local folder action failed.'; }
        await request(endpoint, 'POST', { operation: 'result', project, client: connection.client, id: command.id, result, error });
      }
      // Idle connections leave HTTP slots free for user actions.
      if (!commands.length) await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      if (!connection.stopped) feedback({ level: 'warning', message: error instanceof Error ? error.message : 'Local folder disconnected. Reconnect it before continuing.' });
      connection.stopped = true;
      if (connections.get(project) === connection) connections.delete(project);
    }
  }
}
export async function connectLocalFolder(handle: LocalDirectory, name: string, project?: string): Promise<DashboardCliProject> {
  if (!owner) throw new Error('Sign in to User Workspace before connecting a folder.');
  const sourceOwner = owner;
  if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Folder access was not granted. Choose the folder again to connect it.');
  if (owner !== sourceOwner) throw new Error('The signed-in user changed. Sign in again before connecting a folder.');
  const previous = project ? connections.get(project) : undefined;
  if (previous && project) {
    previous.stopped = true;
    await request(endpoint, 'POST', { operation: 'disconnect', project, client: previous.client });
    connections.delete(project);
  }
  if (clientOwner !== sourceOwner || !tabClient) {
    clientOwner = sourceOwner;
    try {
      const key = `codexManager.localFolderClient.${sourceOwner}`;
      tabClient = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, tabClient);
    } catch { tabClient = crypto.randomUUID(); }
  }
  const client = tabClient;
  if (!project && newProjects.get(handle)?.owner !== sourceOwner) newProjects.set(handle, { owner: sourceOwner, id: crypto.randomUUID() });
  const value = await request<{ project: DashboardCliProject }>(endpoint, 'POST', { operation: 'connect', client, creationId: newProjects.get(handle)?.id, name, folderName: handle.name, project });
  if (owner !== sourceOwner) throw new Error('The signed-in user changed before the folder connected. Sign in again before retrying.');
  const connection = { handle, client, stopped: false, owner: sourceOwner };
  connections.set(value.project.path, connection);
  void serve(value.project.path, connection);
  void remember(value.project.path, handle).catch(() => { if (owner === sourceOwner) feedback({ level: 'warning', message: 'Folder connected for this visit. Its permission could not be remembered; choose it again after reloading.' }); });
  return value.project;
}
export async function forgetLocalFolder(project: string): Promise<void> {
  const savedOwner = owner, connection = connections.get(project);
  if (connection) {
    connection.stopped = true; connections.delete(project);
    void request(endpoint, 'POST', { operation: 'disconnect', project, client: connection.client }).catch(() => {});
  }
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('folders', 'readwrite');
    transaction.objectStore('folders').delete(JSON.stringify([savedOwner, project]));
    transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(new Error('Saved local folder permission could not be removed.'));
  }); } finally { db.close(); }
}
export function bindLocalFolderConnections(nextOwner: string | undefined, onFeedback: (notice: DashboardNotice) => void): () => void {
  owner = nextOwner; feedback = onFeedback;
  let active = true;
  if (nextOwner) void (async () => {
    const db = await database();
    const records = await new Promise<Array<{ owner: string; project: string; handle: LocalDirectory }>>((resolve, reject) => {
      const reading = db.transaction('folders').objectStore('folders').getAll();
      reading.onsuccess = () => resolve(reading.result as Array<{ owner: string; project: string; handle: LocalDirectory }>);
      reading.onerror = () => reject(new Error('Saved local folders could not be loaded.'));
    }).finally(() => db.close());
    for (const record of records) {
      if (!active || owner !== nextOwner) return;
      if (record.owner !== nextOwner || connections.has(record.project)) continue;
      if (await record.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        onFeedback({ level: 'warning', message: `Reconnect ${record.handle.name} from the project's settings to allow local folder access.` }); continue;
      }
      if (!active || owner !== nextOwner) return;
      try { await connectLocalFolder(record.handle, '', record.project); }
      catch (error) { onFeedback({ level: 'warning', message: error instanceof Error ? error.message : 'A saved local folder could not reconnect.' }); }
    }
  })().catch(() => { if (active) onFeedback({ level: 'warning', message: 'Saved local folders are unavailable. Choose a folder again to reconnect.' }); });
  return () => {
    active = false; owner = undefined;
    for (const [project, connection] of connections) {
      connection.stopped = true;
      void request(endpoint, 'POST', { operation: 'disconnect', project, client: connection.client }).catch(() => {});
    }
    connections.clear();
  };
}
