import { beforeEach, expect, it, vi } from 'vitest';
const values = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../src/storage/sqliteState', () => ({ getSqliteStateStore: () => ({ get: (ns: string, key: string) => values.get(`${ns}:${key}`), set: (ns: string, key: string, value: unknown) => values.set(`${ns}:${key}`, value), transaction: (work: () => void) => work() }) }));
import { browserCredentials, fillBrowserCredential, redactBrowserCredentials } from '../src/services/browserCredentials';
import type { WorkspaceBrowserRequest } from '../src/domain/workspaceBrowser';
const masterPassword = 'fixture-master-password', password = 'fixture-login-secret!';
const call = (project: string, params: Record<string, unknown>, extra?: Partial<WorkspaceBrowserRequest>) => browserCredentials(project, { operation: 'credentials', confirmed: true, params, ...extra }) as Promise<any>;
beforeEach(async () => { for (const project of ['one', 'two']) await call(project, { action: 'lock' }); values.clear(); });
const saved = async () => {
  await call('one', { action: 'unlock', masterPassword });
  return call('one', { action: 'save', name: 'Fixture', origin: 'https://example.test/login', username: 'user@example.test', password });
};
it('encrypts saved logins and never returns passwords in metadata', async () => {
  const result = await saved(), raw = String(values.get('browser-credentials:one'));
  expect(result.entries[0]).toMatchObject({ origin: 'https://example.test', username: 'user@example.test' });
  for (const text of [password, masterPassword, 'user@example.test']) expect(raw).not.toContain(text);
  expect(result.entries[0]).not.toHaveProperty('password');
  await call('one', { action: 'lock' });
  expect(await call('one', { action: 'list' })).toMatchObject({ locked: true, entries: [] });
  expect((await call('one', { action: 'unlock', masterPassword })).entries).toHaveLength(1);
});
it('preserves the vault after a wrong password, tampered ciphertext or concurrent change', async () => {
  await saved(); await call('one', { action: 'lock' });
  const raw = values.get('browser-credentials:one');
  await expect(call('one', { action: 'unlock', masterPassword: 'wrong' })).rejects.toThrow('preserved');
  expect(values.get('browser-credentials:one')).toBe(raw);
  const envelope = JSON.parse(String(raw)); envelope.tag = Buffer.alloc(16).toString('base64');
  values.set('browser-credentials:one', JSON.stringify(envelope));
  await expect(call('one', { action: 'unlock', masterPassword })).rejects.toThrow('preserved');
  values.set('browser-credentials:one', raw); await call('one', { action: 'unlock', masterPassword });
  values.set('browser-credentials:one', 'changed');
  await expect(call('one', { action: 'list' })).rejects.toThrow('another host');
});

it('edits one login while preserving an omitted password without returning it', async () => {
  const result = await saved(), id = result.entries[0].id;
  const edited = await call('one', { action: 'save', id, name: 'Edited', origin: 'https://example.test', username: 'changed', password: '' });
  expect(edited.entries).toHaveLength(1);
  expect(edited.entries[0]).toMatchObject({ id, name: 'Edited', username: 'changed' });
  expect(edited.entries[0]).not.toHaveProperty('password');
  await expect(call('one', { action: 'save', id: 'missing' })).rejects.toThrow('no longer');
  await expect(call('one', { action: 'save', id, name: 'AI edit' }, { openedBy: 'ai' })).rejects.toThrow('dashboard');
  const page = { url: () => 'https://example.test', evaluate: vi.fn(async () => undefined) } as any;
  await fillBrowserCredential('one', page, { operation: 'credentials', confirmed: true, params: { id } });
  expect(page.evaluate.mock.calls[0][1].login.password).toBe(password);
});
it('requires user vault management, confirmation and project ownership', async () => {
  await expect(call('one', { action: 'unlock', masterPassword }, { confirmed: false })).rejects.toThrow('confirmed');
  await expect(call('one', { action: 'unlock', masterPassword }, { openedBy: 'ai' })).rejects.toThrow('dashboard');
  await expect(call('one', { action: 'unlock', masterPassword: 'short' })).rejects.toThrow('12 characters');
  await saved();
  expect(await call('two', { action: 'list' })).toMatchObject({ locked: true, exists: false });
  values.set('browser-credentials:two', values.get('browser-credentials:one'));
  await expect(call('two', { action:'unlock', masterPassword })).rejects.toThrow('preserved');
});
it('checks the exact origin before filling and redacts later diagnostics even after locking', async () => {
  const result = await saved(), id = result.entries[0].id;
  const page = { url: () => 'https://other.test/login', evaluate: vi.fn(async () => undefined) } as any;
  const request: WorkspaceBrowserRequest = { operation: 'credentials', confirmed: true, params: { action: 'fill', id } };
  await expect(fillBrowserCredential('one', page, request)).rejects.toThrow('origin'); expect(page.evaluate).not.toHaveBeenCalled();
  page.url = () => 'https://example.test/login';
  expect(await fillBrowserCredential('one', page, request)).toMatchObject({ filled: true });
  await call('one', { action: 'lock' });
  expect(redactBrowserCredentials({ logs: [`value=${password}`, encodeURIComponent(password), Buffer.from(password).toString('base64')] })).toEqual({ logs: ['value=[redacted]', '[redacted]', '[redacted]'] });
  await expect(fillBrowserCredential('one', page, request)).rejects.toThrow('Unlock');
});
it('expires unlocks and deletes only the selected entry', async () => {
  const result = await saved();
  expect((await call('one', { action: 'delete', id: result.entries[0].id })).entries).toEqual([]);
  await expect(call('one', { action: 'delete', id: 'missing' })).rejects.toThrow('no longer');
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
  try { expect((await call('one', { action: 'list' })).locked).toBe(true); } finally { now.mockRestore(); }
});
