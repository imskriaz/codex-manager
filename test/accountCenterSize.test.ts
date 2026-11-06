import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_CENTER_SIZE_KEY, loadAccountCenterSize } from '../webview-src/dashboard/preferences';

afterEach(() => vi.unstubAllGlobals());

describe('remembered account center size', () => {
  it('restores only valid dimensions, leaving screen clamping to the panel', () => {
    const getItem = vi.fn(() => JSON.stringify({ width: 740, height: 900 }));
    vi.stubGlobal('window', { localStorage: { getItem } });
    expect(loadAccountCenterSize()).toEqual({ width: 740, height: 900 });
    expect(getItem).toHaveBeenCalledWith(ACCOUNT_CENTER_SIZE_KEY);
    for (const raw of ['null', '[]', '1', '{}', '{', '{"width":-1,"height":500}', '{"width":400,"height":"500"}', '{"width":1e30,"height":500}']) {
      getItem.mockReturnValue(raw);
      expect(loadAccountCenterSize()).toBeUndefined();
    }
  });
  it('opens at the compact default when browser storage is unavailable', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('Storage unavailable'); } } });
    expect(loadAccountCenterSize()).toBeUndefined();
  });
});
