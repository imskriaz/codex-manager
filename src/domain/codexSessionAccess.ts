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
  const policy = object(raw['sandboxPolicy'] ?? raw['sandbox_policy'] ?? raw['sandbox']);
  const profile = object(raw['activePermissionProfile'] ?? raw['active_permission_profile']);
  const permissions = object(raw['permission_profile']);
  const id = profile?.['id'];
  const profileId = typeof id === 'string' && id.length <= 256 && id.trim() ? id : undefined;
  let mode = codexSandboxMode(policy?.['type'] ?? raw['sandbox_mode']);
  if (permissions?.['type'] === 'disabled' || profileId === ':danger-full-access') mode = 'danger-full-access';
  else if (profileId === ':workspace') mode = 'workspace-write';
  else if (profileId === ':read-only') mode = 'read-only';
  if (!policy && !profile && !permissions && !mode) return undefined;
  const network = policy?.['networkAccess'] ?? policy?.['network_access'];
  return { ...(mode ? { mode } : {}), ...(profileId ? { profile: profileId } : {}), ...(typeof network === 'boolean' ? { networkAccess: network } : {}), updatedAt: Math.max(1, Math.trunc(updatedAt)) };
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
  const mode = codexSandboxMode(raw['type']);
  if (!mode && !['externalSandbox','external-sandbox'].includes(String(raw['type']))) return undefined;
  const keys: Record<string, string> = { network_access: 'networkAccess', writable_roots: 'writableRoots', read_only_access: 'readOnlyAccess', exclude_tmpdir_env_var: 'excludeTmpdirEnvVar', exclude_slash_tmp: 'excludeSlashTmp', include_platform_defaults: 'includePlatformDefaults', readable_roots: 'readableRoots' };
  const convert = (value: unknown): unknown => Array.isArray(value) ? value.map(convert) : object(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [keys[key] ?? key, key === "type" && item === "full-access" ? "fullAccess" : convert(item)])) : value;
  const policy = convert(raw) as Record<string, unknown>;
  policy['type'] = mode === 'danger-full-access' ? 'dangerFullAccess' : mode === 'workspace-write' ? 'workspaceWrite' : mode === 'read-only' ? 'readOnly' : 'externalSandbox';
  return policy;
}
