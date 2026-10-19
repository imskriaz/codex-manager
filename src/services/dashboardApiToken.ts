import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';
import { DASHBOARD_API_ACTIONS, PROJECT_API_ACTIONS, type DashboardApiToken } from '../domain/dashboard/apiActions';
export type { DashboardApiToken } from '../domain/dashboard/apiActions';

export const DASHBOARD_API_TOKEN_SECRET_KEY = 'codexManager.webDashboard.apiTokens.v2';
type StoredToken = DashboardApiToken & { hash: string };
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
async function read(context: vscode.ExtensionContext): Promise<StoredToken[]> {
  const raw = await context.secrets.get(DASHBOARD_API_TOKEN_SECRET_KEY);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 32 || value.some((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
    const row = entry as Record<string, unknown>;
    return typeof row['id'] !== 'string' || typeof row['name'] !== 'string' || row['name'].length > 80 || !Number.isFinite(row['createdAt']) || (row['projectPath'] !== undefined && typeof row['projectPath'] !== 'string') || typeof row['hash'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['hash']) || !Array.isArray(row['permissions']) || row['permissions'].some((permission: unknown) => typeof permission !== 'string');
  })) throw new Error('API token storage could not be read. Existing tokens were preserved.');
  return value as StoredToken[];
}
export async function listDashboardApiTokens(context: vscode.ExtensionContext): Promise<DashboardApiToken[]> {
  return (await read(context)).map(({ hash: _hash, ...token }) => token);
}
export async function createDashboardApiToken(context: vscode.ExtensionContext, input: { name?: string; projectPath?: string; permissions?: string[] } = {}): Promise<{ token: string; record: DashboardApiToken }> {
  const name = typeof input.name === 'string' ? input.name.trim() : undefined;
  if (!name || name.length > 80) throw new Error('Name the token using at most 80 characters.');
  if (input.permissions !== undefined && !Array.isArray(input.permissions)) throw new Error('Choose valid API permissions.');
  const permissions = [...new Set(input.permissions ?? ['state', 'getProjectBoard', 'getProjectTaskDetails'])];
  if (!permissions.length || permissions.some(permission => !['*', 'state', 'settings', ...DASHBOARD_API_ACTIONS].includes(permission))) throw new Error('Choose valid API permissions.');
  if (input.projectPath && permissions.some(permission => permission !== '*' && permission !== 'state' && !PROJECT_API_ACTIONS.has(permission as import('../domain/dashboard/types').DashboardActionName))) throw new Error('Project tokens can only grant operations within that project.');
  return runCrossWindowExclusive('state:dashboard-api-tokens', 'API token creation', async () => {
    const records = await read(context);
    if (records.length >= 32) throw new Error('You already have 32 API tokens. Revoke an unused token first.');
    const token = `cm_${crypto.randomBytes(32).toString('hex')}`;
    const record: DashboardApiToken = { id: crypto.randomUUID(), name, projectPath: input.projectPath, permissions, createdAt: Date.now() };
    await context.secrets.store(DASHBOARD_API_TOKEN_SECRET_KEY, JSON.stringify([...records, { ...record, hash: hash(token) }]));
    return { token, record };
  }, { waitMs: 500 });
}
export async function revokeDashboardApiToken(context: vscode.ExtensionContext, id: string | undefined): Promise<void> {
  if (!id) throw new Error('Choose a token to revoke.');
  await runCrossWindowExclusive('state:dashboard-api-tokens', 'API token revocation', async () => {
    await context.secrets.store(DASHBOARD_API_TOKEN_SECRET_KEY, JSON.stringify((await read(context)).filter(record => record.id !== id)));
  }, { waitMs: 500 });
}
export async function readDashboardApiToken(context: vscode.ExtensionContext, candidate: string | undefined): Promise<DashboardApiToken | undefined> {
  if (!candidate || !/^cm_[a-f0-9]{64}$/.test(candidate)) return undefined;
  const candidateHash = Buffer.from(hash(candidate), 'hex');
  const record = (await read(context)).find(token => crypto.timingSafeEqual(Buffer.from(token.hash, 'hex'), candidateHash));
  if (!record) return undefined;
  const { hash: _hash, ...token } = record;
  return token;
}
export async function isDashboardApiToken(context: vscode.ExtensionContext, candidate: string | undefined): Promise<boolean> {
  return !!await readDashboardApiToken(context, candidate);
}
export function hasApiPermission(token: DashboardApiToken, action: string): boolean {
  return token.permissions.includes('*') || token.permissions.includes(action);
}
