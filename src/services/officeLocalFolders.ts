import { randomUUID } from 'node:crypto';
import type { DashboardCliProject } from '../domain/dashboard/types';
import { localFolderPath, type LocalFolderCommand, type LocalFolderResult } from '../domain/localFolder';
import { createWorkspaceProject, readWorkspaceProjects, renameWorkspaceProject, validateProjectName } from './workspaceProjects';
import { getSqliteStateStore } from '../storage/sqliteState';
import type { OfficeUser } from './officeUsers';

export async function createOfficeLocalProject(user: OfficeUser, client: string, name: unknown, folderName: unknown): Promise<DashboardCliProject> {
  validateProjectName(name);
  if (!/^[a-f0-9-]{36}$/i.test(client) || typeof folderName !== 'string' || !folderName || folderName.length > 255) throw new Error('Choose a local folder first.');
  const namespace = `office-projects:${user.id}`;
  const project = await createWorkspaceProject(`Local-${client}`, user.workspacePath, namespace);
  const value = { ...renameWorkspaceProject(project.path, name, namespace), localFolder: { name: folderName } };
  const store = getSqliteStateStore();
  if (!store) throw new Error('Project storage is unavailable. The local folder was not connected.');
  store.transaction(() => {
    store.set(namespace, process.platform === 'win32' ? value.path.toLowerCase() : value.path, value);
    store.set(`office-local-folders:${user.id}`, value.path, value);
  });
  return value;
}

type Pending = { command: LocalFolderCommand; delivered: boolean; resolve: (value: LocalFolderResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Connection = { owner: string; project: string; client: string; seen: number; pending: Map<string, Pending> };
export function officeLocalProject(owner: string, project: string): DashboardCliProject | undefined {
  return readWorkspaceProjects(`office-projects:${owner}`).find(value => value.path === project && value.localFolder)
    ?? getSqliteStateStore()?.get<DashboardCliProject>(`office-local-folders:${owner}`, project);
}

/** A connection grants access only to one saved project owned by the signed-in user. */
export class OfficeLocalFolderConnections {
  private connections = new Map<string, Connection>();
  private key(owner: string, project: string) { return JSON.stringify([owner, project]); }
  connect(owner: string, project: string, client: string): void {
    if (!/^[a-f0-9-]{36}$/i.test(client)) throw new Error('Choose the folder again to connect.');
    for (const connection of this.connections.values()) if (Date.now() - connection.seen >= 30_000) this.disconnect(connection.owner, connection.project, connection.client);
    const key = this.key(owner, project), previous = this.connections.get(key);
    if (previous && previous.client !== client && Date.now() - previous.seen < 30_000)
      throw new Error('This project is connected in another browser tab. Close that connection before reconnecting.');
    if (previous?.client === client) { previous.seen = Date.now(); return; }
    if (previous) this.disconnect(owner, project, previous.client);
    if (this.connections.size >= 200) throw new Error('Too many connected folders. Close another local connection and retry.');
    this.connections.set(key, { owner, project, client, seen: Date.now(), pending: new Map() });
  }
  disconnect(owner: string, project: string, client: string): void {
    const key = this.key(owner, project), connection = this.connections.get(key);
    if (connection?.client !== client) return;
    this.connections.delete(key);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The local folder disconnected. Check the folder before retrying; changes were not replayed.'));
    }
    connection.pending.clear();
  }
  disconnectProject(owner: string, project: string): void {
    const connection = this.connections.get(this.key(owner, project));
    if (connection) this.disconnect(owner, project, connection.client);
  }
  private connection(owner: string, project: string, client?: string): Connection {
    const value = this.connections.get(this.key(owner, project));
    if (!value || client && value.client !== client || Date.now() - value.seen >= 30_000)
      throw new Error('Local folder is offline. Open the workspace in the browser that connected it and reconnect the folder.');
    return value;
  }
  poll(owner: string, project: string, client: string): LocalFolderCommand[] {
    const connection = this.connection(owner, project, client);
    connection.seen = Date.now();
    return [...connection.pending.values()].filter(value => !value.delivered).map(value => { value.delivered = true; return value.command; });
  }
  complete(owner: string, project: string, client: string, id: string, result?: LocalFolderResult, error?: string): void {
    const connection = this.connection(owner, project, client), pending = connection.pending.get(id);
    if (!pending?.delivered) return;
    connection.pending.delete(id); clearTimeout(pending.timer);
    if (error) pending.reject(new Error(error.slice(0,600)));
    else {
      try {
        if (!result || typeof result !== 'object') throw new Error('Invalid result.');
        if (result.warning !== undefined && (typeof result.warning !== 'string' || result.warning.length > 600)) throw new Error('Invalid warning.');
        if (pending.command.operation === 'list') {
          if (!Array.isArray(result.files) || result.files.length > 2000) throw new Error('Invalid listing.');
          for (const file of result.files) {
            localFolderPath(file.path);
            if (typeof file.name !== 'string' || file.name.length > 255 || !['file','directory'].includes(file.type) || !Number.isInteger(file.depth) || file.depth < 0 || file.depth > 8) throw new Error('Invalid entry.');
          }
        } else {
          if (typeof result.revision !== 'string' || !/^[a-f0-9]{64}$/.test(result.revision) || !Number.isSafeInteger(result.size) || result.size! < 0 || result.size! > 10 * 1048576) throw new Error('Invalid file.');
          const size = pending.command.offset === undefined ? result.size : Math.min(262144, result.size! - pending.command.offset);
          if (pending.command.operation === 'read' && (typeof result.data !== 'string' || result.data.length > 13981016 || result.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data) || Buffer.byteLength(result.data, 'base64') !== size)) throw new Error('Invalid content.');
        }
        pending.resolve(result);
      } catch { pending.reject(new Error('The local folder returned an invalid result. Inspect the folder before retrying.')); }
    }
  }
  request(owner: string, project: string, input: Omit<LocalFolderCommand, 'id'>): Promise<LocalFolderResult> {
    if (input.operation !== 'list') localFolderPath(input.path);
    if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) throw new Error('Choose a valid download offset.');
    const connection = this.connection(owner, project);
    if (connection.pending.size >= 16) throw new Error('The local folder is busy. Wait for the current action to finish.');
    return new Promise((resolve, reject) => {
      const command = { ...input, id: randomUUID(), expiresAt: Date.now() + 12_000 };
      const timer = setTimeout(() => {
        connection.pending.delete(command.id);
        reject(new Error('The local folder did not confirm completion. Check the folder before retrying; changes were not replayed.'));
      }, 12_000);
      connection.pending.set(command.id, { command, delivered: false, resolve, reject, timer });
    });
  }
  close(): void {
    for (const connection of this.connections.values()) this.disconnect(connection.owner, connection.project, connection.client);
  }
}
export const officeLocalFolders = new OfficeLocalFolderConnections();
