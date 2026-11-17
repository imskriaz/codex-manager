import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';
import { DASHBOARD_API_ACTIONS, PROJECT_API_ACTIONS, apiTokenProjects, type DashboardApiToken } from '../domain/dashboard/apiActions';
export type { DashboardApiToken } from '../domain/dashboard/apiActions';

export const DASHBOARD_API_TOKEN_SECRET_KEY = 'codexManager.webDashboard.apiTokens.v2';
type StoredToken = DashboardApiToken & { hash: string; requestIdHash?: string; value?: string };
const publicTokens = (records: StoredToken[]): DashboardApiToken[] => records.map(({ hash: _hash, requestIdHash: _request, value: _value, ...record }) => record);
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
async function read(context: vscode.ExtensionContext): Promise<StoredToken[]> {
  const raw = await context.secrets.get(DASHBOARD_API_TOKEN_SECRET_KEY);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 32 || value.some((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
    const row = entry as Record<string, unknown>;
    if (row['value'] !== undefined && (typeof row['value'] !== 'string' || !/^cm_[a-f0-9]{64}$/.test(row['value']) || hash(row['value']) !== row['hash'])) return true;
    if (row['projectPaths'] !== undefined && (!Array.isArray(row['projectPaths']) || row['projectPaths'].length < 1 || row['projectPaths'].length > 32 || row['projectPaths'].some(item => typeof item !== 'string' || !item.trim()))) return true;
    return row['requestIdHash'] !== undefined && (typeof row['requestIdHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['requestIdHash'])) || typeof row['id'] !== 'string' || typeof row['name'] !== 'string' || row['name'].length > 80 || !Number.isFinite(row['createdAt']) || (row['projectPath'] !== undefined && typeof row['projectPath'] !== 'string') || typeof row['hash'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['hash']) || !Array.isArray(row['permissions']) || row['permissions'].some((permission: unknown) => typeof permission !== 'string');
  })) throw new Error('API token storage could not be read. Existing tokens were preserved.');
  return value as StoredToken[];
}
export async function listDashboardApiTokens(context: vscode.ExtensionContext): Promise<DashboardApiToken[]> {
  return runCrossWindowExclusive('state:dashboard-api-tokens', 'API token list', async () => publicTokens(await read(context)), { waitMs:500 });
}
export async function createDashboardApiToken(context: vscode.ExtensionContext, input: { name?: string; projectPath?: string; projectPaths?: string[]; permissions?: string[]; requestId?: string; id?: string; expected?: DashboardApiToken } = {}): Promise<{ token: string; record: DashboardApiToken; tokens: DashboardApiToken[] }> {
  if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 256)) throw new Error('Use a valid token request identifier.');
  const name = typeof input.name === 'string' ? input.name.trim() : undefined;
  if (!name || name.length > 80) throw new Error('Name the token using at most 80 characters.');
  if (input.permissions !== undefined && !Array.isArray(input.permissions)) throw new Error('Choose valid API permissions.');
  const permissions = [...new Set(input.permissions ?? ['state', 'getProjectBoard', 'getProjectTaskDetails'])];
  if (!permissions.length || permissions.some(permission => !['*', 'state', 'settings', 'aiProxy', ...DASHBOARD_API_ACTIONS].includes(permission))) throw new Error('Choose valid API permissions.');
  if (input.projectPaths !== undefined && (!Array.isArray(input.projectPaths) || !input.projectPaths.length || input.projectPaths.length > 32 || input.projectPaths.some(item => typeof item !== 'string' || !item.trim()))) throw new Error('Choose between 1 and 32 project folders.');
  const projects = [...new Set(apiTokenProjects(input))];
  if (projects.length && permissions.some(permission => permission !== '*' && permission !== 'state' && !PROJECT_API_ACTIONS.has(permission as import('../domain/dashboard/types').DashboardActionName))) throw new Error('Project tokens can only grant operations within that project.');
  return runCrossWindowExclusive('state:dashboard-api-tokens', 'API token creation', async () => {
    const records = await read(context);
    if (input.id) {
      const previous = records.find(record => record.id === input.id);
      if (!previous) throw new Error('This API key was revoked. Refresh the list.');
      if (JSON.stringify(publicTokens([previous])[0]) !== JSON.stringify(input.expected)) throw new Error('This API key changed in another window. Refresh before editing.');
      const record: DashboardApiToken = { id: previous.id, name, ...(projects.length > 1 ? { projectPaths: projects } : projects.length ? { projectPath: projects[0] } : {}), permissions, createdAt: previous.createdAt };
      const next = records.map(item => item.id === input.id ? { ...record, hash: previous.hash, value: previous.value, requestIdHash: previous.requestIdHash } : item);
      await context.secrets.store(DASHBOARD_API_TOKEN_SECRET_KEY, JSON.stringify(next));
      return { token: '', record, tokens: publicTokens(next) };
    }
    if (input.requestId && records.some(record => record.requestIdHash === hash(input.requestId!))) throw new Error('This request already created a token. Refresh the token list and revoke it if its one-time value was not received.');
    if (records.length >= 32) throw new Error('You already have 32 API tokens. Revoke an unused token first.');
    const token = `cm_${crypto.randomBytes(32).toString('hex')}`;
    const record: DashboardApiToken = { id: crypto.randomUUID(), name, ...(projects.length > 1 ? { projectPaths: projects } : projects.length ? { projectPath: projects[0] } : {}), permissions, createdAt: Date.now() };
    const next = [...records, { ...record, hash: hash(token), value: token, ...(input.requestId ? {requestIdHash:hash(input.requestId)} : {}) }];
    await context.secrets.store(DASHBOARD_API_TOKEN_SECRET_KEY, JSON.stringify(next));
    return { token, record, tokens:publicTokens(next) };
  }, { waitMs: 500 });
}
export async function revokeDashboardApiToken(context: vscode.ExtensionContext, id: string | undefined): Promise<DashboardApiToken[]> {
  if (!id) throw new Error('Choose a token to revoke.');
  return runCrossWindowExclusive('state:dashboard-api-tokens', 'API token revocation', async () => {
    const next = (await read(context)).filter(record => record.id !== id);
    await context.secrets.store(DASHBOARD_API_TOKEN_SECRET_KEY, JSON.stringify(next));
    return publicTokens(next);
  }, { waitMs: 500 });
}
export async function readDashboardApiToken(context: vscode.ExtensionContext, candidate: string | undefined): Promise<DashboardApiToken | undefined> {
  if (!candidate || !/^cm_[a-f0-9]{64}$/.test(candidate)) return undefined;
  const candidateHash = Buffer.from(hash(candidate), 'hex');
  const record = (await read(context)).find(token => crypto.timingSafeEqual(Buffer.from(token.hash, 'hex'), candidateHash));
  if (!record) return undefined;
  return publicTokens([record])[0];
}
export async function copyDashboardApiToken(context: vscode.ExtensionContext, id: string | undefined): Promise<string> {
  return runCrossWindowExclusive('state:dashboard-api-tokens', 'API key copy', async () => {
    const record = (await read(context)).find(item => item.id === id);
    if (!record) throw new Error('This API key was revoked. Refresh the list.');
    if (!record.value) throw new Error('This older key has only a saved hash and cannot be copied. Create a replacement key, update your tools, then revoke the old key.');
    return record.value;
  }, { waitMs: 500 });
}
export async function isDashboardApiToken(context: vscode.ExtensionContext, candidate: string | undefined): Promise<boolean> {
  return !!await readDashboardApiToken(context, candidate);
}
export function hasApiPermission(token: DashboardApiToken, action: string): boolean {
  return token.permissions.includes('*') || token.permissions.includes(action);
}
