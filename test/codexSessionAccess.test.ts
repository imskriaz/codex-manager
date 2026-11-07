import { expect, it } from 'vitest';
import { codexSandboxMode, codexSessionAccessPolicy, isCodexSessionAccess, matchesCodexSessionAccess, parseCodexSessionAccess, recordedCodexSandboxPolicy } from '../src/domain/codexSessionAccess';

it('requires the selected Full profile as well as its effective sandbox policy', () => {
  const expected = parseCodexSessionAccess({ permissions: ':danger-full-access' })!;
  expect(expected).toMatchObject({ mode: 'danger-full-access', profile: ':danger-full-access' });
  const sandbox = { sandboxPolicy: { type: 'dangerFullAccess' } };
  expect(matchesCodexSessionAccess(parseCodexSessionAccess(sandbox), expected)).toBe(false);
  expect(matchesCodexSessionAccess(parseCodexSessionAccess({ ...sandbox, activePermissionProfile: { id: ':workspace' } }), expected)).toBe(false);
  expect(matchesCodexSessionAccess(parseCodexSessionAccess({ ...sandbox, activePermissionProfile: { id: ':danger-full-access' } }), expected)).toBe(true);
  expect(matchesCodexSessionAccess(parseCodexSessionAccess({ sandboxPolicy: { type: 'readOnly' }, activePermissionProfile: { id: ':danger-full-access' } }), expected)).toBe(false);
  for (const permissions of [null, 1, {}, '', 'x'.repeat(257)]) expect(parseCodexSessionAccess({ permissions })).toBeUndefined();
});

it.each([['readOnly','read-only'],['workspaceWrite','workspace-write'],['dangerFullAccess','danger-full-access']])('reads both native and app-server access spelling %s', (wire, mode) => {
  expect(codexSandboxMode(wire)).toBe(mode); expect(codexSandboxMode(mode)).toBe(mode);
  expect(parseCodexSessionAccess({ sandboxPolicy: { type: wire } })?.mode).toBe(mode);
  expect(parseCodexSessionAccess({ sandbox_policy: { type: mode } })?.mode).toBe(mode);
});
it('reads named and disabled profiles without presenting an unknown profile as workspace access', () => {
  expect(parseCodexSessionAccess({ permission_profile: { type: 'disabled' } })?.mode).toBe('danger-full-access');
  expect(parseCodexSessionAccess({ active_permission_profile: { id: ':workspace' } })?.mode).toBe('workspace-write');
  expect(parseCodexSessionAccess({ activePermissionProfile: { id: 'restricted-docs' } })?.profile).toBe('restricted-docs');
  expect(parseCodexSessionAccess({ activePermissionProfile: { id: 'restricted-docs' } })?.mode).toBeUndefined();
  expect(parseCodexSessionAccess({ sandbox_policy: { type: 'external-sandbox' } })?.mode).toBeUndefined();
  expect(parseCodexSessionAccess(null)).toBeUndefined(); expect(parseCodexSessionAccess({})).toBeUndefined();
});
it('does not broaden network or recorded folder access', () => {
  expect(codexSessionAccessPolicy('workspace-write','D:/work')).toMatchObject({ writableRoots: ['D:/work'], networkAccess: false });
  expect(codexSessionAccessPolicy('read-only','D:/work',true)).toMatchObject({ type: 'readOnly', networkAccess: true });
  expect(recordedCodexSandboxPolicy(JSON.stringify({ type: 'workspace-write', writable_roots: ['D:/work','D:/shared'], network_access: false, read_only_access: { type: 'restricted', readable_roots: ['D:/docs'], include_platform_defaults: true } }))).toEqual({ type: 'workspaceWrite', writableRoots: ['D:/work','D:/shared'], networkAccess: false, readOnlyAccess: { type: 'restricted', readableRoots: ['D:/docs'], includePlatformDefaults: true } });
  expect(recordedCodexSandboxPolicy('broken')).toBeUndefined();
});
it('bounds peer access updates and rejects malformed or future permissions', () => {
  const access = { mode: 'read-only', updatedAt: Date.now() };
  expect(isCodexSessionAccess(access)).toBe(true);
  for (const patch of [{ mode: 'root' },{ profile: 'x'.repeat(257) },{ networkAccess: 'yes' },{ updatedAt: Date.now()+600000 },{ unknown: true }]) expect(isCodexSessionAccess({ ...access, ...patch })).toBe(false);
});

it('reads and validates approval policies independently of sandbox permissions', () => {
  for (const key of ['approvalPolicy', 'approval_policy', 'approval_mode']) {
    expect(parseCodexSessionAccess({ [key]: 'never' })).toMatchObject({ approvalPolicy: 'never' });
  }
  expect(parseCodexSessionAccess({ approvalPolicy: 'always-allow-everything' })).toBeUndefined();
  expect(isCodexSessionAccess({ mode: 'read-only', approvalPolicy: 'never', updatedAt: Date.now() })).toBe(true);
  expect(isCodexSessionAccess({ approvalPolicy: true, updatedAt: Date.now() })).toBe(false);
});

it('reads modern database permission profiles and preserves effective policy over profile provenance', () => {
  expect(parseCodexSessionAccess({ sandbox_policy: '{"type":"disabled"}' })?.mode).toBe('danger-full-access');
  const managed = { type: 'managed', file_system: { type: 'restricted', entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }, { path: { type: 'path', path: 'D:/work' }, access: 'write' }, { path: { type: 'path', path: 'D:/work/private' }, access: 'none' }] }, network: 'restricted' };
  expect(parseCodexSessionAccess({ sandbox_policy: JSON.stringify(managed) })).toMatchObject({ mode: 'workspace-write', networkAccess: false });
  expect(recordedCodexSandboxPolicy(managed)).toBeUndefined();
  expect(recordedCodexSandboxPolicy('{"type":"disabled"}')).toEqual({ type: 'dangerFullAccess' });
  expect(parseCodexSessionAccess({ permissionProfile: { ...managed, file_system: { type: 'restricted', entries: [{ access: 'read' }] }, network: 'enabled' } })).toMatchObject({ mode: 'read-only', networkAccess: true });
  expect(parseCodexSessionAccess({ sandboxPolicy: { type: 'readOnly' }, activePermissionProfile: { id: ':danger-full-access' } })?.mode).toBe('read-only');
  expect(parseCodexSessionAccess({ sandbox_policy: 'broken' })).toBeUndefined();
});
