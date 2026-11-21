import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let values: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-21T00:00:00Z'));
  values = new Map();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  } });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('notification and app install offer dismissal', () => {
  it('persists across page reloads and expires at exactly 24 hours', async () => {
    let offer = await import('../webview-src/dashboard/browserOfferDismissal');
    expect(offer.isBrowserOfferDismissed()).toBe(false);
    offer.dismissBrowserOffer();
    vi.resetModules();
    offer = await import('../webview-src/dashboard/browserOfferDismissal');
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);
    expect(offer.isBrowserOfferDismissed()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(offer.isBrowserOfferDismissed()).toBe(false);
  });

  it.each(['invalid', 'Infinity', '-1'])('ignores an invalid or expired timestamp: %s', async value => {
    values.set('codexManager.browserOfferDismissedUntil', value);
    const offer = await import('../webview-src/dashboard/browserOfferDismissal');
    expect(offer.isBrowserOfferDismissed()).toBe(false);
  });

  it('still dismisses for the current page if browser storage is blocked', async () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage blocked'); } });
    const offer = await import('../webview-src/dashboard/browserOfferDismissal');
    expect(offer.isBrowserOfferDismissed()).toBe(false);
    expect(() => offer.dismissBrowserOffer()).not.toThrow();
    expect(offer.isBrowserOfferDismissed()).toBe(true);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(offer.isBrowserOfferDismissed()).toBe(false);
  });
});
