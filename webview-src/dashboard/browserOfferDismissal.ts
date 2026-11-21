const storageKey = 'codexManager.browserOfferDismissedUntil';
const daysStorageKey = 'codexManager.browserOfferDismissalDays';
let dismissedUntil = 0;

export function loadBrowserOfferDismissalDays(): number {
  try {
    const days = Number(window.localStorage.getItem(daysStorageKey));
    if (Number.isInteger(days) && days >= 1 && days <= 30) { return days; }
  } catch { /* Use the one-day default when browser storage is unavailable. */ }
  return 1;
}

export function saveBrowserOfferDismissalDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw new RangeError('Choose a whole number of days from 1 to 30.');
  }
  window.localStorage.setItem(daysStorageKey, String(days));
}

export function isBrowserOfferDismissed(): boolean {
  try {
    const saved = Number(window.localStorage.getItem(storageKey));
    if (Number.isFinite(saved)) dismissedUntil = Math.max(dismissedUntil, saved);
  } catch { /* Keep the dismissal for this page when browser storage is unavailable. */ }
  return dismissedUntil > Date.now();
}

export function dismissBrowserOffer(): void {
  dismissedUntil = Date.now() + loadBrowserOfferDismissalDays() * 24 * 60 * 60 * 1000;
  try {
    window.localStorage.setItem(storageKey, String(dismissedUntil));
  } catch { /* Keep the dismissal for this page when browser storage is unavailable. */ }
}
