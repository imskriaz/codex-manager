import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as vscode from 'vscode';
import { configureCrossWindowOperationCoordinator } from '../src/utils/crossWindowOperations';
import { createDashboardApiToken, listDashboardApiTokens, readDashboardApiToken, revokeDashboardApiToken, DASHBOARD_API_TOKEN_SECRET_KEY } from '../src/services/dashboardApiToken';
import { authorizeApiMessage, scopeApiResults } from '../src/services/dashboardApiScope';
import { DASHBOARD_API_ACTIONS } from '../src/domain/dashboard/apiActions';
import type { DashboardClientMessage, DashboardHostMessage } from '../src/domain/dashboard/types';
import { removeTestDirectory } from './testFilesystem';

vi.mock('../src/services/codexSessionResume', () => ({ readCodexCliSessionSummary: vi.fn(async (id: string) => ({ id, projectPath: id === 'outside' ? '/other' : process.cwd(), status: 'idle' })) }));
let root: string;
const secrets = new Map<string, string>();
const context = { secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); } } } as unknown as vscode.ExtensionContext;
const message = (action: string, payload = {}): DashboardClientMessage => ({ type: 'dashboard:action', action, payload, requestId: 'test' } as DashboardClientMessage);
beforeEach(async () => { secrets.clear(); root = await mkdtemp(join(tmpdir(), 'manager-api-')); await configureCrossWindowOperationCoordinator(root); });
afterEach(async () => { vi.restoreAllMocks(); await removeTestDirectory(root); });

it('stores only hashes for multiple named tokens, preserves scope and permissions, and revokes individually', async () => {
  const a = await createDashboardApiToken(context, { name: 'Build', projectPath: process.cwd(), permissions: ['getProjectBoard'] });
  const b = await createDashboardApiToken(context, { name: 'Owner', permissions: ['*'] });
  const raw = secrets.get(DASHBOARD_API_TOKEN_SECRET_KEY)!;
  expect(raw).not.toContain(a.token); expect(raw).not.toContain(b.token);
  expect(await listDashboardApiTokens(context)).toEqual([a.record, b.record]);
  expect(await readDashboardApiToken(context, a.token)).toEqual(a.record);
  expect(await readDashboardApiToken(context, a.token.slice(0,-1) + (a.token.endsWith('0') ? '1' : '0'))).toBeUndefined();
  await revokeDashboardApiToken(context, a.record.id);
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
  await expect(authorizeApiMessage(record, message('resumeCodexSessions'))).rejects.toThrow(/Bulk recovery/);
  await expect(authorizeApiMessage(record, { type: 'dashboard:setting', key: 'apiAccessEnabled', value: false })).rejects.toThrow(/global settings/);
  await expect(authorizeApiMessage({ ...record, permissions: ['getProjectBoard'] }, message('saveProjectTask'))).rejects.toThrow(/permit/);
  await expect(createDashboardApiToken(context, { name: 'Invalid', projectPath: root, permissions: ['remove'] })).rejects.toThrow(/within that project/);
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

it('keeps the runtime explorer and HTTP validation catalogue in sync with every dashboard action', async () => {
  const source = await readFile(join(process.cwd(), 'src/domain/dashboard/types.ts'), 'utf8');
  const declaration = source.split('export type DashboardActionName =')[1]!.split(';')[0]!;
  const names = [...declaration.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  expect([...new Set(DASHBOARD_API_ACTIONS)].sort()).toEqual(names.sort());
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
