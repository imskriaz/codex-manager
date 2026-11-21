const storageKey = 'codexManager.browserOfferDismissedUntil';
let dismissedUntil = 0;

export function isBrowserOfferDismissed(): boolean {
  try {
    const saved = Number(window.localStorage.getItem(storageKey));
    if (Number.isFinite(saved)) dismissedUntil = Math.max(dismissedUntil, saved);
  } catch { /* Keep the dismissal for this page when browser storage is unavailable. */ }
  return dismissedUntil > Date.now();
}

export function dismissBrowserOffer(): void {
  dismissedUntil = Date.now() + 24 * 60 * 60 * 1000;
  try {
    window.localStorage.setItem(storageKey, String(dismissedUntil));
  } catch { /* Keep the dismissal for this page when browser storage is unavailable. */ }
}
