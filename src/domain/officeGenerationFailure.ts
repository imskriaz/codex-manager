export class OfficeCapacityError extends Error {
  constructor(message = 'All assistants are busy.', public readonly retryAfterMs = 5_000) { super(message); }
}
export class OfficeModelSelectionError extends Error {}
export class OfficeActionError extends Error {}
export class OfficeResponseError extends Error {
  readonly retryAfterMs = 5_000;
}

/** Only explicit rate limits and temporary availability rejections belong in the queue. */
export function officeGenerationFailure(status: number, code: unknown, retryAfter: string | null, sideEffects: boolean): Error {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? '') - Date.now();
  const retryMs = Number.isFinite(delay) ? Math.max(5_000, delay) : 30_000;
  if (status===401||status===403||code==='authentication_required') return new OfficeActionError('Assistant access is unavailable. Contact your workspace administrator. Saved work was preserved.');
  if (status === 429 || status === 503) {
    const message = status === 429 ? 'The assistant is rate limited.' : code === 'host_restarting' ? 'The workspace service is restarting.' : 'All assistants are busy.';
    if (!sideEffects) return new OfficeCapacityError(message, retryMs);
    return new OfficeActionError(message + ' Saved work was preserved. Review it before retrying.');
  }
  if (status === 400 || status === 404) return new OfficeModelSelectionError('Choose another available model to continue. Your message is saved.');
  if (status === 504) return new OfficeResponseError('The assistant response timed out. Saved work was preserved.');
  if (code === 'invalid_tool_call' || code === 'incomplete_tool_call') return new OfficeResponseError('The assistant returned an incomplete or invalid action. That action was not run. Saved work was preserved.');
  if (status === 402) return new OfficeActionError('The assistant allowance is unavailable or exhausted. Check Usage before retrying. Your message is saved.');
  return new OfficeResponseError('The assistant response was interrupted. Saved work was preserved.');
}
