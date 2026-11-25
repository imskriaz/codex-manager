/** Paths sent to a connected browser are always relative to its selected folder. */
export function localFolderPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part)))
    throw new Error('Choose a relative path inside the connected folder.');
  return value;
}

export type LocalFolderCommand = {
  id: string;
  expiresAt?: number;
  operation: 'list' | 'read' | 'write';
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
};
