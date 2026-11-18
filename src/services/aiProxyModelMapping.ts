import type * as vscode from 'vscode';
import { CLAUDE_PROXY_MODELS, type ClaudeProxyMapping } from '../domain/dashboard/apiProxy';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';

const KEY = 'aiProxy.claudeModelMapping';
const roles = Object.keys(CLAUDE_PROXY_MODELS) as Array<keyof ClaudeProxyMapping>;

function validate(value: unknown): ClaudeProxyMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a Codex model for each Claude model.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== roles.length || roles.some(role => typeof record[role] !== 'string' || !record[role] || (record[role] as string).length > 256)) {
    throw new Error('Choose a Codex model for each Claude model.');
  }
  return Object.fromEntries(roles.map(role => [role, record[role]])) as ClaudeProxyMapping;
}

export function readClaudeProxyMapping(context: vscode.ExtensionContext): ClaudeProxyMapping | undefined {
  const saved = context.globalState?.get<unknown>(KEY);
  return saved === undefined ? undefined : validate(saved);
}

export async function saveClaudeProxyMapping(context: vscode.ExtensionContext, value: unknown, expected: unknown, available: string[]): Promise<ClaudeProxyMapping> {
  const next = validate(value);
  if (roles.some(role => !available.includes(next[role]))) throw new Error('A selected Codex model is unavailable. Refresh models and choose again.');
  return runCrossWindowExclusive('state:claude-proxy-model-mapping', 'Claude model mapping', async () => {
    const current = readClaudeProxyMapping(context);
    const previous = expected === undefined ? undefined : validate(expected);
    if (roles.some(role => current?.[role] !== previous?.[role])) throw new Error('Claude model mapping changed in another window. Refresh before saving.');
    await context.globalState.update(KEY, next);
    return next;
  }, { waitMs: 500 });
}
