import { normalizeCliComposerDraft, type CliComposerDraft } from './cliSessionComposerState';

export type SavedCliSessionStart = { requestId: string; key: string; draft: CliComposerDraft; projectPath?: string };
const STORAGE_KEY = 'codexManager.sessionStarts.v1';

export function readCliSessionStarts(storage: Pick<Storage, 'getItem'>): SavedCliSessionStart[] {
  const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
  if (!Array.isArray(saved) || saved.length > 20) throw new Error('Saved session starts could not be read. Copy your prompts before closing this tab.');
  const ids = new Set<string>();
  return (saved as unknown[]).map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Saved session starts could not be read. The original records were kept for recovery.');
    const item = raw as Record<string, unknown>;
    const draft = normalizeCliComposerDraft(item['draft']);
    const keyText = item['key'], requestId = item['requestId'], projectPath = item['projectPath'];
    const key: unknown = typeof keyText === 'string' ? JSON.parse(keyText) : undefined;
    if (!draft || !draft.text.trim() && !draft.attachments.length || typeof keyText !== 'string' || !Array.isArray(key) || typeof key[0] !== 'string' || key[1] !== 'new' || typeof key[2] !== 'string' || typeof requestId !== 'string' || !requestId.trim() || requestId.length > 256 || ids.has(requestId) || (projectPath !== undefined && typeof projectPath !== 'string')) throw new Error('Saved session starts could not be read. The original records were kept for recovery.');
    ids.add(requestId);
    return { requestId, key: keyText, draft, projectPath };
  });
}

export function writeCliSessionStarts(storage: Pick<Storage, 'setItem'>, starts: SavedCliSessionStart[]): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(starts.map(item => ({ ...item, draft: normalizeCliComposerDraft(item.draft) }))));
}
