/** Paths sent to a connected browser are always relative to its selected folder. */
export function localFolderPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part)))
    throw new Error('Choose a relative path inside the connected folder.');
  return value;
}

export type LocalFolderCommand = {
  id: string;
  expiresAt?: number;
  operation: 'list' | 'read' | 'write' | 'inspect' | 'create_folder' | 'copy_file' | 'move_file' | 'delete';
  destination?: string;
  permission?: LocalFolderPermission;
  path?: string;
  data?: string;
  revision?: string;
  offset?: number;
};
export type LocalFolderResult = {
  files?: Array<{ path: string; name: string; type: 'file' | 'directory'; depth: number }>;
  warning?: string;
  data?: string;
  revision?: string;
  size?: number;
  message?: string;
  kind?: 'file' | 'folder';
  entries?: Array<{ path: string; kind: string }>;
};

export type LocalFolderPermission = 'read-only' | 'write' | 'full';
export function localFolderPermission(value: unknown): LocalFolderPermission {
  if (value === undefined) return 'write';
  if (value !== 'read-only' && value !== 'write' && value !== 'full') throw new Error('Choose Read only, Write or Full permission.');
  return value;
}
export function assertLocalFolderPermission(permission: LocalFolderPermission, operation: LocalFolderCommand['operation']): void {
  if (!['list','read','write','inspect','create_folder','copy_file','move_file','delete'].includes(operation)) throw new Error('Choose a supported folder action.');
  if (['list','read','inspect'].includes(operation)) return;
  if (permission === 'read-only') throw new Error('This folder is read only. Select Write or Full in message settings to change files.');
  if (['move_file','delete'].includes(operation) && permission !== 'full') throw new Error('This action requires Full permission. Select Full in message settings to move, rename or delete.');
}
