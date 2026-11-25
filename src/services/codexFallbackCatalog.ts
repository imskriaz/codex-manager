import * as vscode from 'vscode';
import { DEFAULT_CODEX_FALLBACK_MODEL_IDS, parseCodexFallbackModelIds } from '../domain/codexModelFallback';
import { getCodexManagerConfiguration } from '../infrastructure/config/extensionSettings';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';

export function readCodexFallbackCatalog(): string {
  return parseCodexFallbackModelIds(getCodexManagerConfiguration().get<string>('codexFallbackModelIds', DEFAULT_CODEX_FALLBACK_MODEL_IDS)).join('\n');
}

export function saveCodexFallbackCatalog(value: string, expected: string): Promise<string> {
  const ids = parseCodexFallbackModelIds(value).join('\n');
  return runCrossWindowExclusive('settings:codex-fallback-models', 'Fallback models', async () => {
    if (getCodexManagerConfiguration().get<string>('codexFallbackModelIds', DEFAULT_CODEX_FALLBACK_MODEL_IDS) !== expected) throw new Error('Fallback models changed on this host. Reopen Settings and apply your edits again.');
    await getCodexManagerConfiguration().update('codexFallbackModelIds', ids, vscode.ConfigurationTarget.Global);
    if (readCodexFallbackCatalog() !== ids) throw new Error('Fallback model changes could not be confirmed. Reopen Settings before retrying.');
    return ids;
  });
}

export function rememberDiscoveredCodexModels(ids: string[]): Promise<void> {
  return runCrossWindowExclusive('settings:codex-fallback-models', 'Fallback models', async () => {
    const current = readCodexFallbackCatalog();
    const merged = parseCodexFallbackModelIds([current, ...ids].join('\n')).join('\n');
    if (merged !== current) await getCodexManagerConfiguration().update('codexFallbackModelIds', merged, vscode.ConfigurationTarget.Global);
  });
}
