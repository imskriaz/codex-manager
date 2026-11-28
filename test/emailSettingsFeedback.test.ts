import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../webview-src/dashboard/teamSettingsRequest', () => ({ request: mocks.request }));
import { requestEmailPreferences, requestEmailSmtp } from '../webview-src/dashboard/emailSettings';

const preferences = { revision: 'saved', enabled: false, address: '', ready: true, needsAnswer: true, failed: true, includeResult: false };
const state = { preferences, watches: [], available: false };
const config = { revision: 'saved', enabled: false, host: '', port: 587, security: 'starttls', user: '', from: '', baseUrl: '', hasPassword: false };
beforeEach(() => { mocks.request.mockReset(); });

it.each([null, {}, { ...state, preferences: null }, { ...state, watches: null }, { ...state, watches: [42] }, { ...state, preferences: { ...preferences, enabled: 'false' } }])('rejects incomplete email preferences before updating the UI', async value => {
  mocks.request.mockResolvedValue(value);
  await expect(requestEmailPreferences()).rejects.toThrow('incomplete email settings');
  expect(mocks.request).toHaveBeenCalledOnce();
});

it.each([null, {}, { config: null }, { config: { ...config, port: 0 } }, { config: { ...config, security: 'unknown' } }])('rejects incomplete SMTP settings before replacing the form', async value => {
  mocks.request.mockResolvedValue(value);
  await expect(requestEmailSmtp()).rejects.toThrow('incomplete SMTP settings');
});

it('preserves valid reads and requires confirmation for preference and SMTP saves', async () => {
  mocks.request.mockResolvedValue(state);
  await expect(requestEmailPreferences()).resolves.toEqual(state);
  await expect(requestEmailPreferences('PUT', preferences)).rejects.toThrow('incomplete email settings');
  mocks.request.mockResolvedValue({ ...state, message: 'Saved.' });
  await expect(requestEmailPreferences('POST', { sessionKey: 'session', enabled: true })).resolves.toMatchObject({ message: 'Saved.' });
  mocks.request.mockResolvedValue({ config });
  await expect(requestEmailSmtp()).resolves.toEqual({ config });
  await expect(requestEmailSmtp('PUT', config)).rejects.toThrow('incomplete SMTP settings');
  mocks.request.mockResolvedValue({ config, message: 'Saved.' });
  await expect(requestEmailSmtp('PUT', config)).resolves.toMatchObject({ message: 'Saved.' });
});

it('preserves host failures without replaying the write', async () => {
  mocks.request.mockRejectedValue(new Error('Storage unavailable.'));
  await expect(requestEmailPreferences('PUT', preferences)).rejects.toThrow('Storage unavailable.');
  expect(mocks.request).toHaveBeenCalledOnce();
});
