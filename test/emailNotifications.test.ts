import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { configureCrossWindowOperationCoordinator } from '../src/utils/crossWindowOperations';
import { removeTestDirectory } from './testFilesystem';
import { EmailNotificationService, defaultEmailPreferences, readEmailPreferences, saveEmailPreferences, saveEmailWatch } from '../src/services/emailNotifications';
import * as concurrency from '../src/utils/concurrency';
import * as officeUsers from '../src/services/officeUsers';

const { sendMail, close, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn(), close = vi.fn(); return { sendMail, close, createTransport: vi.fn(() => ({ sendMail, close })) };
});
vi.mock('nodemailer', () => ({ createTransport }));
let root: string, database: SqliteStateStore, secrets: Map<string, string>, service: EmailNotificationService;
const smtp = { revision: '', enabled: true, host: 'smtp.example.test', port: 587, security: 'starttls', user: 'sender', password: 'test-secret', from: 'sender@example.test', baseUrl: 'https://dashboard.example.test' };
const ready = { id: 'turn-1', event: 'ready' as const, title: 'Result ready', message: 'Your work is ready.', result: 'Private result', url: '/workspace/12345678-1234-1234-1234-123456789abc' };
function preferences(owner = 'master', changes = {}) { return saveEmailPreferences(owner, { ...defaultEmailPreferences, ...readEmailPreferences(owner), enabled: true, address: `${owner}@example.test`, ...changes }); }
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'manager-email-'));
  await configureCrossWindowOperationCoordinator(root);
  database = await SqliteStateStore.open(path.join(root, 'state.sqlite')); configureSqliteStateStore(database);
  secrets = new Map();
  vi.spyOn(officeUsers, 'getOfficeUser').mockResolvedValue({ id: 'alex', username: 'alex@example.test', enabled: true } as officeUsers.OfficeUser);
  service = new EmailNotificationService({ get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); } } as never);
  sendMail.mockReset().mockResolvedValue({ accepted: ['recipient@example.test'], rejected: [] }); close.mockClear(); createTransport.mockClear();
});
afterEach(async () => { await service.flush(); configureSqliteStateStore(undefined); database.close(); vi.restoreAllMocks(); await removeTestDirectory(root); });

it('keeps SMTP passwords secret, preserves blanks, checks conflicts and validates secure settings', async () => {
  const saved = await service.saveConfig(smtp);
  expect(saved).not.toHaveProperty('password'); expect(saved.hasPassword).toBe(true);
  await expect(service.saveConfig(smtp)).rejects.toThrow('changed in another window');
  await service.saveConfig({ ...saved, password: '' });
  preferences(); await service.test('master');
  expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, secure: false, auth: { user: 'sender', pass: 'test-secret' }, disableFileAccess: true, disableUrlAccess: true }));
  expect(sendMail.mock.calls[0][0].text).not.toContain('test-secret');
  const current = await service.publicConfig();
  await expect(service.saveConfig({ ...current, from: 'a@example.test\r\nBcc: victim@example.test' })).rejects.toThrow('valid email');
  await expect(service.saveConfig({ ...current, port: 70000 })).rejects.toThrow('port');
  await expect(service.saveConfig({ ...current, baseUrl: 'https://user:password@example.test' })).rejects.toThrow('dashboard origin');
});
it('isolates recipients and defaults to link-only emails with persistent duplicate prevention', async () => {
  await service.saveConfig(smtp); preferences('master'); preferences('alex');
  service.notify(ready); service.notify(ready); service.notify({ ...ready, owner: 'alex' }); await service.flush();
  expect(sendMail).toHaveBeenCalledTimes(2);
  expect(sendMail.mock.calls.map(call => call[0].to)).toEqual(['master@example.test', 'alex@example.test']);
  expect(sendMail.mock.calls[0][0].text).not.toContain('Private result');
  expect(sendMail.mock.calls[0][0].text).toContain('https://dashboard.example.test/workspace/');
  const restarted = new EmailNotificationService({ get: async key => secrets.get(key) } as never);
  restarted.notify(ready); await restarted.flush(); expect(sendMail).toHaveBeenCalledTimes(2);
});
it('honors event choices, explicit excerpts, disabled users and single-session ready watches', async () => {
  await service.saveConfig(smtp); preferences('master', { enabled: false, includeResult: true });
  const key = 'local:12345678-1234-1234-1234-123456789abc'; saveEmailWatch('master', { sessionKey: key, enabled: true });
  service.notify({ ...ready, sessionKey: key }); service.notify({ ...ready, id: 'other', sessionKey: 'local:other' });
  service.notify({ ...ready, id: 'failed', sessionKey: key, event: 'failed' }); await service.flush();
  expect(sendMail).toHaveBeenCalledOnce(); expect(sendMail.mock.calls[0][0].text).toContain('Private result');
  preferences('master', { enabled: true, ready: false, failed: true, needsAnswer: true });
  service.notify({ ...ready, id: 'f2', event: 'failed' }); service.notify({ ...ready, id: 'q2', event: 'needsAnswer' }); await service.flush();
  expect(sendMail).toHaveBeenCalledTimes(3);
  preferences('alex');
  const disabled = new EmailNotificationService({ get: async key => secrets.get(key) } as never, async () => false);
  disabled.notify({ ...ready, owner: 'alex' }); await disabled.flush(); expect(sendMail).toHaveBeenCalledTimes(3);
});
it('sends tests and session notices to the current account email instead of the saved recipient', async () => {
  await service.saveConfig(smtp); preferences('alex', { address: 'legacy@example.test' });
  vi.mocked(officeUsers.getOfficeUser).mockResolvedValue({ id: 'alex', username: 'current@example.test', enabled: true } as officeUsers.OfficeUser);
  await service.test('alex');
  service.notify({ ...ready, owner: 'alex' }); await service.flush();
  expect(sendMail.mock.calls.map(call => call[0].to)).toEqual(['current@example.test', 'current@example.test']);
  vi.mocked(officeUsers.getOfficeUser).mockResolvedValue(undefined);
  await expect(service.test('alex')).rejects.toThrow('valid email address');
  expect(sendMail).toHaveBeenCalledTimes(2);
});
it('records rejected or unconfirmed deliveries without automatic replay or raw server secrets', async () => {
  await service.saveConfig(smtp); preferences();
  sendMail.mockRejectedValueOnce(Object.assign(new Error('password test-secret echoed'), { code: 'EAUTH' }));
  service.notify(ready); await service.flush();
  expect(service.status('master')).toMatchObject({ state: 'failed', error: 'SMTP authentication failed. Check the username and app password.' });
  service.notify(ready); await service.flush(); expect(sendMail).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  vi.spyOn(concurrency, 'waitWithin').mockRejectedValueOnce(new Error('SMTP delivery timed out.'));
  service.notify({ ...ready, id: 'timeout' }); await service.flush();
  expect(service.status('master')).toMatchObject({ state: 'failed', error: expect.stringContaining('could not be confirmed') });
  expect(service.status('master')?.error).not.toContain('test-secret');
});
it('rejects stale preferences and header injection without changing another owner', () => {
  const first = preferences('alex');
  expect(() => saveEmailPreferences('alex', { ...first, revision: '', address: 'new@example.test' })).toThrow('changed');
  expect(() => preferences('alex', { address: 'a@example.test\r\nBcc:b@example.test' })).toThrow('valid email');
  expect(readEmailPreferences('master').enabled).toBe(false);
  expect(() => saveEmailWatch('master', { sessionKey: 'local:12345678-1234-1234-1234-123456789abc', enabled: true })).toThrow('email address');
});
