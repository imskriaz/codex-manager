import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as vscode from 'vscode';
import { configureCrossWindowOperationCoordinator } from '../src/utils/crossWindowOperations';
import { copyDashboardApiToken, createDashboardApiToken, listDashboardApiTokens, readDashboardApiToken, revokeDashboardApiToken, DASHBOARD_API_TOKEN_SECRET_KEY } from '../src/services/dashboardApiToken';
import { authorizeApiMessage, scopeApiResults } from '../src/services/dashboardApiScope';
import { DASHBOARD_API_ACTIONS } from '../src/domain/dashboard/apiActions';
import type { DashboardClientMessage, DashboardHostMessage } from '../src/domain/dashboard/types';
import { readCodexCliSessionSummary } from '../src/services/codexSessionResume';
import { removeTestDirectory } from './testFilesystem';

vi.mock('../src/services/codexSessionResume', () => ({ readCodexCliSessionSummary: vi.fn(async (id: string) => ({ id, projectPath: id === 'outside' ? '/other' : process.cwd(), status: 'idle' })) }));
let root: string;
const secrets = new Map<string, string>();
const context = { secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); } } } as unknown as vscode.ExtensionContext;
const message = (action: string, payload = {}): DashboardClientMessage => ({ type: 'dashboard:action', action, payload, requestId: 'test' } as DashboardClientMessage);
beforeEach(async () => { secrets.clear(); root = await mkdtemp(join(tmpdir(), 'manager-api-')); await configureCrossWindowOperationCoordinator(root); });
afterEach(async () => { vi.restoreAllMocks(); await removeTestDirectory(root); });

it('keeps copyable values only in secret storage, preserves scope and permissions, and revokes individually', async () => {
  const a = await createDashboardApiToken(context, { name: 'Build', projectPath: process.cwd(), permissions: ['getProjectBoard'] });
  const b = await createDashboardApiToken(context, { name: 'Owner', permissions: ['*'] });
  const raw = secrets.get(DASHBOARD_API_TOKEN_SECRET_KEY)!;
  expect(raw).toContain(a.token); expect(raw).toContain(b.token);
  expect(await copyDashboardApiToken(context, a.record.id)).toBe(a.token);
  expect(JSON.stringify(await listDashboardApiTokens(context))).not.toContain(a.token);
  expect(await listDashboardApiTokens(context)).toEqual([a.record, b.record]);
  expect(await readDashboardApiToken(context, a.token)).toEqual(a.record);
  expect(await readDashboardApiToken(context, a.token.slice(0,-1) + (a.token.endsWith('0') ? '1' : '0'))).toBeUndefined();
  await revokeDashboardApiToken(context, a.record.id);
  await expect(copyDashboardApiToken(context, a.record.id)).rejects.toThrow(/revoked/);
  expect(await readDashboardApiToken(context, a.token)).toBeUndefined();
  expect(await readDashboardApiToken(context, b.token)).toEqual(b.record);
});

it('denies ungranted actions, other projects and sessions, remote targets, and global settings for a project token', async () => {
  const { record } = await createDashboardApiToken(context, { name: 'Project', projectPath: process.cwd(), permissions: ['*'] });
  await expect(authorizeApiMessage(record, message('getProjectBoard'))).resolves.toMatchObject({ payload: { projectPath: process.cwd() } });
  await expect(authorizeApiMessage(record, message('getProjectBoard', { projectPath: root }))).rejects.toThrow(/another project/);
  await expect(authorizeApiMessage(record, message('getCodexCliSessionMessages', { sessionId: 'outside' }))).rejects.toThrow(/outside/);
  await expect(authorizeApiMessage(record, message('getProjectBoard', { targetDeviceId: 'peer' }))).rejects.toThrow(/outside/);
  await expect(authorizeApiMessage(record, message('remove'))).rejects.toThrow(/outside/);
  await expect(authorizeApiMessage(record, message('clearUsageHistory'))).rejects.toThrow(/outside/);
  await expect(authorizeApiMessage(record, message('resumeCodexSessions'))).rejects.toThrow(/Bulk recovery/);
  await expect(authorizeApiMessage(record, { type: 'dashboard:setting', key: 'apiAccessEnabled', value: false })).rejects.toThrow(/global settings/);
  await expect(authorizeApiMessage({ ...record, permissions: ['getProjectBoard'] }, message('saveProjectTask'))).rejects.toThrow(/permit/);
  await expect(createDashboardApiToken(context, { name: 'Invalid', projectPath: root, permissions: ['remove'] })).rejects.toThrow(/within that project/);
});

it('permits only granted local project coordination and preserves mailbox results', async () => {
  const { record } = await createDashboardApiToken(context, { name: 'Coordination', projectPath: process.cwd(), permissions: ['coordinateCodexSessions'] });
  await expect(authorizeApiMessage(record, message('coordinateCodexSessions', { sessionId: 'own', coordinationRequest: { operation: 'read' } }))).resolves.toMatchObject({ payload: { projectPath: process.cwd() } });
  await expect(authorizeApiMessage(record, message('coordinateCodexSessions', { sessionId: 'outside', coordinationRequest: { operation: 'read' } }))).rejects.toThrow('outside');
  await expect(authorizeApiMessage(record, message('coordinateCodexSessions', { projectPath: root, coordinationRequest: { operation: 'list' } }))).rejects.toThrow('another project');
  await expect(authorizeApiMessage(record, message('coordinateCodexSessions', { targetDeviceId: 'peer', coordinationRequest: { operation: 'list' } }))).rejects.toThrow('outside');
  await expect(authorizeApiMessage({ ...record, permissions: ['state'] }, message('coordinateCodexSessions'))).rejects.toThrow('does not permit');
  const payload = { sessionCoordination: { messages: [{ id: 'message', fromSessionId: 'one', toSessionId: 'two', text: 'Hello', createdAt: 1 }] } };
  expect(scopeApiResults(record, [{ type: 'dashboard:action-result', action: 'coordinateCodexSessions', requestId: 'r', status: 'completed', payload }])[0]).toMatchObject({ payload });
});

it('requires explicit stop/start permissions for coordination controls on remote API tokens', async () => {
  const { record } = await createDashboardApiToken(context, { name: 'Mail', permissions: ['coordinateCodexSessions'] });
  const command = (operation: string, start = false) => message('coordinateCodexSessions', { sessionId: 'own', coordinationRequest: { operation, start } });
  await expect(authorizeApiMessage(record, command('stop'))).rejects.toThrow('cancelCodexCliSessionTurn');
  await expect(authorizeApiMessage(record, command('handover', true))).rejects.toThrow('cancelCodexCliSessionTurn');
  await expect(authorizeApiMessage(record, command('resume'))).rejects.toThrow('sendCodexCliSessionMessage');
  const stops = { ...record, permissions: [...record.permissions, 'cancelCodexCliSessionTurn'] };
  await expect(authorizeApiMessage(stops, command('stop'))).resolves.toBeDefined();
  await expect(authorizeApiMessage(stops, command('handover', true))).rejects.toThrow('sendCodexCliSessionMessage');
});

it('filters global refreshed state and secret-bearing fields from scoped mutation results', () => {
  const token = { id: 'a', name: 'Scoped', projectPath: process.cwd(), permissions: ['*'], createdAt: 1 };
  const messages: DashboardHostMessage[] = [{ type: 'dashboard:action-result', action: 'renameCodexCliSession', requestId: 'r', status: 'completed', payload: {
    cliSessions: [{ id: 'own', title: 'Own', status: 'idle', projectPath: process.cwd() }, { id: 'other', title: 'Other', status: 'idle', projectPath: root }],
    authJson: 'secret', apiToken: 'secret', apiTokens: [], cliSessionMessages: [],
    cliComposerConfig: { projects: [{ path: process.cwd(), label: 'Own' }, { path: root, label: 'Other' }], models: [] } as never
  } }, { type: 'dashboard:notice', level: 'info', message: 'Global notice' }];
  const result = scopeApiResults(token, messages);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ payload: { cliSessions: [{ id: 'own' }], cliComposerConfig: { projects: [{ label: 'Own' }] } } });
  const payload = (result[0] as Extract<DashboardHostMessage, { type: 'dashboard:action-result' }>).payload!;
  expect(payload).not.toHaveProperty('authJson'); expect(payload).not.toHaveProperty('apiTokens'); expect(payload).not.toHaveProperty('apiToken');
});

it('pins project-scoped surface requests to local execution and strips foreign view content', async () => {
  const { record } = await createDashboardApiToken(context, { name: 'Panel', projectPath: process.cwd(), permissions: ['workspacePanel'] });
  await expect(authorizeApiMessage(record, message('workspacePanel', { panelLocalOnly: false, panelRequest: { operation: 'list' } }))).resolves.toMatchObject({ payload: { panelLocalOnly: true, projectPath: process.cwd() } });
  await expect(authorizeApiMessage(record, message('workspacePanel', { targetDeviceId: 'peer', panelRequest: { operation: 'list' } }))).rejects.toThrow(/outside/);
  const result = scopeApiResults(record, [{ type: 'dashboard:action-result', action: 'workspacePanel', requestId: 'panel', status: 'completed', payload: { workspacePanel: {
    surfaces: [{ projectPath: root } as never], content: { text: 'private view' }
  } } }]);
  expect(result[0]).toMatchObject({ payload: { workspacePanel: { surfaces: [] } } });
  expect(JSON.stringify(result)).not.toContain('private view');
});

it('requires state permission for appended snapshots even when an operation token allows every project', () => {
  const token = { id: 'a', name: 'Rename only', permissions: ['renameCodexCliSession'], createdAt: 1 };
  const messages: DashboardHostMessage[] = [
    { type: 'dashboard:action-result', action: 'renameCodexCliSession', requestId: 'r', status: 'completed', payload: { notice: { level: 'info', message: 'Renamed.' } } },
    { type: 'dashboard:snapshot', state: { accounts: [{ id: 'private-account' }] } as never }
  ];
  expect(scopeApiResults(token, messages)).toEqual([messages[0]]);
  expect(scopeApiResults({ ...token, permissions: [...token.permissions, 'state'] }, messages)).toEqual(messages);
  expect(scopeApiResults({ ...token, permissions: ['*'] }, messages)).toEqual(messages);
  expect(scopeApiResults({ ...token, projectPath: process.cwd(), permissions: ['*'] }, messages)).toEqual([messages[0]]);
});

it('preserves corrupt storage and enforces the token cap', async () => {
  secrets.set(DASHBOARD_API_TOKEN_SECRET_KEY, '[{"id":"broken"}]');
  await expect(createDashboardApiToken(context, { name: 'New' })).rejects.toThrow(/preserved/);
  expect(secrets.get(DASHBOARD_API_TOKEN_SECRET_KEY)).toBe('[{"id":"broken"}]');
  secrets.clear(); const first = await createDashboardApiToken(context, { name: 'First' });
  const stored = JSON.parse(secrets.get(DASHBOARD_API_TOKEN_SECRET_KEY)!) as Array<Record<string, unknown>>;
  secrets.set(DASHBOARD_API_TOKEN_SECRET_KEY, JSON.stringify(Array.from({ length: 32 }, (_, index) => ({ ...stored[0], id: String(index) }))));
  await expect(createDashboardApiToken(context, { name: 'Overflow' })).rejects.toThrow(/32/);
  expect(await readDashboardApiToken(context, first.token)).toBeDefined();
});

it('keeps the runtime explorer in sync with externally available dashboard actions', async () => {
  const source = await readFile(join(process.cwd(), 'src/domain/dashboard/types.ts'), 'utf8');
  const declaration = source.split('export type DashboardActionName =')[1]!.split(';')[0]!;
  const names = [...declaration.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  expect([...new Set(DASHBOARD_API_ACTIONS)].sort()).toEqual(names.filter(name => name !== 'sessionArtifact').sort());
  await expect(createDashboardApiToken(context, { name: 'Artifact publisher', permissions: ['sessionArtifact'] }))
    .rejects.toThrow('Choose valid API permissions.');
});

it('enforces multiple project scopes on actions, settings and refreshed results', async () => {
  const { record, token } = await createDashboardApiToken(context, { name: 'Two projects', projectPaths: [process.cwd(), root], permissions: ['state', 'getProjectBoard'] });
  expect((await readDashboardApiToken(context, token))?.projectPaths).toEqual([process.cwd(), root]);
  await expect(authorizeApiMessage(record, message('getProjectBoard'))).rejects.toThrow(/Choose a projectPath/);
  await expect(authorizeApiMessage(record, message('getProjectBoard', { projectPath: process.cwd() }))).resolves.toMatchObject({ payload: { projectPath: process.cwd() } });
  await expect(authorizeApiMessage(record, message('getProjectBoard', { projectPath: '/not-granted' }))).rejects.toThrow(/another project/);
  await expect(authorizeApiMessage({ ...record, permissions: ['*'] }, { type: 'dashboard:setting', key: 'apiAccessEnabled', value: false })).rejects.toThrow(/global settings/);
  const result = scopeApiResults(record, [{ type: 'dashboard:action-result', requestId: 'list', action: 'listCodexCliSessions', status: 'completed', payload: { cliSessions: [process.cwd(), root, '/not-granted'].map((projectPath, index) => ({ id: String(index), title: 'Task', status: 'idle', projectPath })) } }]);
  expect((result[0] as Extract<DashboardHostMessage, { type: 'dashboard:action-result' }>).payload?.cliSessions).toHaveLength(2);
  await expect(createDashboardApiToken(context, { name: 'Invalid', projectPaths: [], permissions: ['state'] })).rejects.toThrow(/project folders/);
});

it('returns a confirmed public list with creation and rejects the same request without retaining token text', async () => {
  const created=await createDashboardApiToken(context,{name:'Build',requestId:'one-request',permissions:['state']});
  expect(created.tokens).toEqual([created.record]);
  expect(JSON.stringify(created.tokens)).not.toContain('requestIdHash');
  expect(JSON.stringify(created.tokens)).not.toContain(created.token);
  expect(secrets.get(DASHBOARD_API_TOKEN_SECRET_KEY)).not.toContain('one-request');
  await expect(createDashboardApiToken(context,{name:'Build',requestId:'one-request',permissions:['state']})).rejects.toThrow(/already created/);
  expect(await listDashboardApiTokens(context)).toEqual([created.record]);
  expect(await revokeDashboardApiToken(context,created.record.id)).toEqual([]);
});
it('preserves saved credentials and allows explicit recovery after a failed token write', async () => {
  const previous=await createDashboardApiToken(context,{name:'Previous'});
  const write=vi.spyOn(context.secrets,'store').mockRejectedValueOnce(new Error('disk full'));
  await expect(createDashboardApiToken(context,{name:'New',requestId:'retry'})).rejects.toThrow(/disk full/);
  expect(await readDashboardApiToken(context,previous.token)).toEqual(previous.record);
  expect((await listDashboardApiTokens(context)).length).toBe(1);
  const confirmed=await createDashboardApiToken(context,{name:'New',requestId:'retry'});
  expect(confirmed.tokens.length).toBe(2);write.mockRestore();
});

it('does not expose request hashes in authentication results', async () => {
  const created=await createDashboardApiToken(context,{name:'Proof',requestId:'hidden-proof'});
  expect(await readDashboardApiToken(context,created.token)).toEqual(created.record);
});

it('keeps timed out session verification unavailable without removing its ownership fence', async () => {
  const { record } = await createDashboardApiToken(context, { name: 'Project', projectPath: process.cwd(), permissions: ['getCodexCliSessionMessages'] });
  vi.useFakeTimers();
  try {
    vi.mocked(readCodexCliSessionSummary).mockImplementationOnce(() => new Promise(() => {}));
    const result = authorizeApiMessage(record, message('getCodexCliSessionMessages', { sessionId: 'slow' })).catch(error => error);
    await vi.advanceTimersByTimeAsync(5001);
    const error = await result;
    expect(error).toBeInstanceOf(Error); expect(error.constructor.name).not.toBe('ApiPermissionError'); expect(error.message).toContain('ownership could not be verified');
  } finally { vi.useRealTimers(); }
});

it('authorizes every explicitly granted host operation without an implicit state or project permission', async () => {
  const base = { id: 'matrix', name: 'Host', createdAt: 1 };
  for (const action of DASHBOARD_API_ACTIONS) {
    await expect(authorizeApiMessage({ ...base, permissions: [action] }, message(action))).resolves.toEqual(message(action));
    await expect(authorizeApiMessage({ ...base, permissions: [] }, message(action))).rejects.toThrow(/does not permit/);
  }
});

it('scopes browser and native terminal access to the granted projects and filters unrelated shells', async () => {
  const { record } = await createDashboardApiToken(context, { name: 'Tools', projectPath: root, permissions: ['workspaceBrowser', 'workspaceTerminal', 'listWorkspaceTerminals', 'createWorkspaceTerminal'] });
  for (const action of ['workspaceBrowser', 'workspaceTerminal', 'listWorkspaceTerminals', 'createWorkspaceTerminal'] as const) {
    await expect(authorizeApiMessage(record, message(action, { projectPath: root }))).resolves.toMatchObject({ payload: { projectPath: root } });
    await expect(authorizeApiMessage(record, message(action, { projectPath: process.cwd() }))).rejects.toThrow('another project');
  }
  const messages = scopeApiResults(record, [{ type: 'dashboard:action-result', requestId: 'tools', action: 'listWorkspaceTerminals', status: 'completed', payload: { workspaceTerminals: [ { id: 'allowed', name: 'Allowed', cwd: root, isActive: true, state: 'idle' }, { id: 'secret', name: 'Other project', cwd: process.cwd(), isActive: false, state: 'idle' } ] } }]);
  expect(messages[0]).toMatchObject({ payload: { workspaceTerminals: [{ id: 'allowed' }] } });
});

it('edits metadata without rotating a key and refuses stale edits or missing keys', async () => {
  const created = await createDashboardApiToken(context, { name: 'Before', permissions: ['state'] });
  const updated = await createDashboardApiToken(context, { id: created.record.id, expected: created.record, name: 'After', projectPath: root, permissions: ['getProjectBoard'] });
  expect(updated.record).toMatchObject({ id: created.record.id, name: 'After', createdAt: created.record.createdAt, projectPath: root, permissions: ['getProjectBoard'] });
  expect(await readDashboardApiToken(context, created.token)).toEqual(updated.record);
  expect(await copyDashboardApiToken(context, created.record.id)).toBe(created.token);
  await expect(createDashboardApiToken(context, { id: created.record.id, expected: created.record, name: 'Stale' })).rejects.toThrow(/another window/);
  await expect(createDashboardApiToken(context, { id: 'missing', expected: created.record, name: 'Gone' })).rejects.toThrow(/revoked/);
  await expect(createDashboardApiToken(context, { id: created.record.id, expected: updated.record, name: 'Invalid', projectPaths: [root], permissions: ['settings'] })).rejects.toThrow(/within that project/);
  const saved = secrets.get(DASHBOARD_API_TOKEN_SECRET_KEY);
  vi.spyOn(context.secrets, 'store').mockRejectedValueOnce(new Error('disk full'));
  await expect(createDashboardApiToken(context, { id: created.record.id, expected: updated.record, name: 'Unsaved' })).rejects.toThrow(/disk full/);
  expect(secrets.get(DASHBOARD_API_TOKEN_SECRET_KEY)).toBe(saved);
});
it('authenticates legacy hashed keys and explains why their values cannot be copied', async () => {
  const created = await createDashboardApiToken(context, { name: 'Legacy' });
  const records = JSON.parse(secrets.get(DASHBOARD_API_TOKEN_SECRET_KEY)!);
  delete records[0].value;
  secrets.set(DASHBOARD_API_TOKEN_SECRET_KEY, JSON.stringify(records));
  expect(await readDashboardApiToken(context, created.token)).toEqual(created.record);
  await expect(copyDashboardApiToken(context, created.record.id)).rejects.toThrow(/older key.*cannot be copied/);
});
