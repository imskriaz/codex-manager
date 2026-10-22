export const MAX_ACCOUNT_TAGS = 10;
export const MAX_ACCOUNT_TAG_LENGTH = 24;

export type AccountTagUpdate = { accountId: string; tags: string[]; updatedAt: number; enabled?: boolean };
export type AccountTagResult = { successCount: number; failedCount: number; errors: string[]; accounts: AccountTagUpdate[] };

export function isAccountTagUpdate(value: unknown): value is AccountTagUpdate {
  if (!value || typeof value !== 'object') return false;
  const update = value as AccountTagUpdate;
  if (typeof update.accountId !== 'string' || !update.accountId || update.accountId.length > 256 || !Number.isSafeInteger(update.updatedAt) || update.updatedAt < 0 || update.enabled !== undefined && typeof update.enabled !== 'boolean' || !Array.isArray(update.tags) || update.tags.length > MAX_ACCOUNT_TAGS) return false;
  try { normalizeAccountTags(update.tags); return true; } catch { return false; }
}

export function isAccountTagResult(value: unknown): value is AccountTagResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as AccountTagResult;
  return Array.isArray(result.accounts) && result.accounts.length <= 1000 && result.accounts.every(isAccountTagUpdate) && new Set(result.accounts.map(account => account.accountId)).size === result.accounts.length &&
    result.successCount === result.accounts.length && Number.isSafeInteger(result.failedCount) && result.failedCount >= 0 && result.failedCount + result.successCount <= 1000 &&
    Array.isArray(result.errors) && result.errors.length <= 20 && result.errors.every(error => typeof error === 'string' && error.length <= 300);
}

export function normalizeAccountTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Enter tags as a list of text labels.');
  const entries: unknown[] = value, labels = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new Error('Enter tags as a list of text labels.');
    const tag = entry.trim();
    if (tag) labels.set(tag.toLowerCase(), tag);
  }
  const tags = [...labels.values()];
  if (tags.length > MAX_ACCOUNT_TAGS) throw new Error(`Use at most ${MAX_ACCOUNT_TAGS} tags.`);
  if (tags.some(tag => tag.length > MAX_ACCOUNT_TAG_LENGTH || /[\r\n\u0000-\u001f\u007f]/.test(tag))) throw new Error(`Each tag must be a single line of at most ${MAX_ACCOUNT_TAG_LENGTH} characters.`);
  return tags;
}
