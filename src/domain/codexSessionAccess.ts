import type { DashboardCliSandboxMode } from './dashboard/types';

export type CodexSessionAccess = { mode?: DashboardCliSandboxMode; profile?: string; networkAccess?: boolean; updatedAt: number };
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export function codexSandboxMode(value: unknown): DashboardCliSandboxMode | undefined {
  if (value === 'readOnly' || value === 'read-only') return 'read-only';
  if (value === 'workspaceWrite' || value === 'workspace-write') return 'workspace-write';
  if (value === 'dangerFullAccess' || value === 'danger-full-access') return 'danger-full-access';
  return undefined;
}
export function parseCodexSessionAccess(value: unknown, updatedAt = Date.now()): CodexSessionAccess | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  let stored = raw['sandboxPolicy'] ?? raw['sandbox_policy'] ?? raw['sandbox'];
  if (typeof stored === 'string' && stored.length <= 64_000) { try { stored = JSON.parse(stored); } catch { stored = undefined; } }
  const policy = object(stored);
  const profile = object(raw['activePermissionProfile'] ?? raw['active_permission_profile']);
  const permissions = object(raw['permissionProfile'] ?? raw['permission_profile']) ?? (['disabled','managed'].includes(String(policy?.['type'])) ? policy : undefined);
  const id = profile?.['id'];
  const profileId = typeof id === 'string' && id.length <= 256 && id.trim() ? id : undefined;
  let mode = codexSandboxMode(policy?.['type'] ?? raw['sandbox_mode']);
  if (!mode && permissions?.['type'] === 'disabled') mode = 'danger-full-access';
  const files = object(permissions?.['file_system'] ?? permissions?.['fileSystem']);
  const entries = files?.['entries'];
  if (!mode && permissions?.['type'] === 'managed' && files?.['type'] === 'restricted' && Array.isArray(entries) && entries.every(entry => ['read','write','none'].includes(String(object(entry)?.['access'])))) {
    mode = entries.some(entry => object(entry)?.['access'] === 'write') ? 'workspace-write' : 'read-only';
  }
  if (!mode) mode = profileId === ':danger-full-access' ? 'danger-full-access' : profileId === ':workspace' ? 'workspace-write' : profileId === ':read-only' ? 'read-only' : undefined;
  if (!policy && !profileId && !permissions && !mode) return undefined;
  const network = policy?.['networkAccess'] ?? policy?.['network_access'] ?? (permissions?.['network'] === 'enabled' ? true : permissions?.['network'] === 'restricted' ? false : undefined);
  return { ...(mode ? { mode } : {}), ...(profileId ? { profile: profileId } : {}), ...(typeof network === 'boolean' ? { networkAccess: network } : {}), updatedAt: Number.isSafeInteger(updatedAt) && updatedAt > 0 ? updatedAt : Date.now() };
}
export function isCodexSessionAccess(value: unknown): value is CodexSessionAccess {
  const raw = object(value);
  return !!raw && Object.keys(raw).every(key => ['mode','profile','networkAccess','updatedAt'].includes(key))
    && Number.isSafeInteger(raw['updatedAt']) && (raw['updatedAt'] as number) > 0 && (raw['updatedAt'] as number) <= Date.now() + 5 * 60_000
    && (raw['mode'] === undefined || codexSandboxMode(raw['mode']) === raw['mode'])
    && (raw['profile'] === undefined || typeof raw['profile'] === 'string' && raw['profile'].length > 0 && raw['profile'].length <= 256)
    && (raw['networkAccess'] === undefined || typeof raw['networkAccess'] === 'boolean');
}
export function codexSessionAccessPolicy(mode: DashboardCliSandboxMode, cwd: string, networkAccess = false): Record<string, unknown> {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') return { type: 'readOnly', networkAccess };
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

/** Convert recorded policies without inventing broader read, write, or network grants. */
export function recordedCodexSandboxPolicy(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return undefined; } }
  const raw = object(value);
  if (!raw || JSON.stringify(raw).length > 64_000) return undefined;
  if (raw['type'] === 'disabled') return { type: 'dangerFullAccess' };
  const mode = codexSandboxMode(raw['type']);
  if (!mode && !['externalSandbox','external-sandbox'].includes(String(raw['type']))) return undefined;
  const keys: Record<string, string> = { network_access: 'networkAccess', writable_roots: 'writableRoots', read_only_access: 'readOnlyAccess', exclude_tmpdir_env_var: 'excludeTmpdirEnvVar', exclude_slash_tmp: 'excludeSlashTmp', include_platform_defaults: 'includePlatformDefaults', readable_roots: 'readableRoots' };
  const convert = (value: unknown): unknown => Array.isArray(value) ? value.map(convert) : object(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [keys[key] ?? key, key === "type" && item === "full-access" ? "fullAccess" : convert(item)])) : value;
  const policy = convert(raw) as Record<string, unknown>;
  policy['type'] = mode === 'danger-full-access' ? 'dangerFullAccess' : mode === 'workspace-write' ? 'workspaceWrite' : mode === 'read-only' ? 'readOnly' : 'externalSandbox';
  return policy;
}
