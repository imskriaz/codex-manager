import { expect, it } from 'vitest';
import { codexSandboxMode, codexSessionAccessPolicy, isCodexSessionAccess, parseCodexSessionAccess, recordedCodexSandboxPolicy } from '../src/domain/codexSessionAccess';

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
