export const DEFAULT_WORKSPACE_FILE_LIMIT_MB = 100;
export const MAX_WORKSPACE_FILE_LIMIT_MB = 1024;
export function normalizeWorkspaceFileLimitMb(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(MAX_WORKSPACE_FILE_LIMIT_MB, Math.round(value))) : DEFAULT_WORKSPACE_FILE_LIMIT_MB;
}
export function workspaceFileLimitBytes(value: unknown = DEFAULT_WORKSPACE_FILE_LIMIT_MB): number {
  return normalizeWorkspaceFileLimitMb(value) * 1024 * 1024;
}
export const MAX_WORKSPACE_FILE_BYTES = workspaceFileLimitBytes();
export const LOCAL_FILE_CHUNK_BYTES = 4 * 1024 * 1024;
export const DEFAULT_LOCAL_FILE_CHUNK_BYTES = 256 * 1024;
export function maxLocalFileWireBytes(value: unknown = DEFAULT_WORKSPACE_FILE_LIMIT_MB): number {
  return Math.ceil(workspaceFileLimitBytes(value) / 3) * 4 + 1024 * 1024;
}
export const MAX_LOCAL_FILE_WIRE_BYTES = maxLocalFileWireBytes();
