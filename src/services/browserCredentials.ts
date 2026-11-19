import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto';
import type { Page } from 'playwright-core';
import { browserUrl, type WorkspaceBrowserRequest } from '../domain/workspaceBrowser';
import { getSqliteStateStore } from '../storage/sqliteState';

type Login = { id: string; name: string; origin: string; username: string; password: string; usernameSelector: string; passwordSelector: string };
type Envelope = { version: 1; salt: string; iv: string; tag: string; data: string };
type Unlocked = { key: Buffer; raw: string; expires: number };
const namespace = 'browser-credentials';
const unlocked = new Map<string, Unlocked>();
// Retain redactions after locking: captured page diagnostics can outlive the vault.
const secrets = new Set<string>();
const lifetime = 15 * 60_000;
const expiry = setInterval(() => { for (const [project, value] of unlocked) if (value.expires < Date.now()) lock(project); }, 30_000);
expiry.unref();

function lock(project: string): void { unlocked.get(project)?.key.fill(0); unlocked.delete(project); }
function storage() {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Credential storage is unavailable. Nothing was changed.');
  return store;
}
function decrypt(raw: string, key: Buffer, project: string): Login[] {
  const value = JSON.parse(raw) as Envelope;
  if (value.version !== 1) throw new Error('Unsupported vault version.');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  cipher.setAAD(Buffer.from(JSON.stringify(['codex-manager-browser-v1', project])));
  cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  const rows = JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8')) as Login[];
  if (!Array.isArray(rows) || rows.length > 32) throw new Error('Invalid vault.');
  return rows;
}
function encrypt(rows: Login[], key: Buffer, salt: string, project: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['codex-manager-browser-v1', project])));
  const data = Buffer.concat([cipher.update(JSON.stringify(rows), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, salt, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}
function opened(project: string): { vault: Unlocked; rows: Login[] } {
  const vault = unlocked.get(project);
  if (!vault || vault.expires < Date.now()) { lock(project); throw new Error('Unlock this project credential vault first.'); }
  if (storage().get<string>(namespace, project) !== vault.raw) { lock(project); throw new Error('The vault changed in another host. Unlock it again.'); }
  vault.expires = Date.now() + lifetime;
  return { vault, rows: decrypt(vault.raw, vault.key, project) };
}
function commit(project: string, vault: Unlocked, rows: Login[]): void {
  const store = storage(), raw = encrypt(rows, vault.key, (JSON.parse(vault.raw) as Envelope).salt, project);
  store.transaction(() => {
    if (store.get<string>(namespace, project) !== vault.raw) throw new Error('The vault changed in another host. Unlock it again; nothing was overwritten.');
    store.set(namespace, project, raw);
  });
  vault.raw = raw;
}
function field(params: Record<string, unknown>, key: string, max: number, fallback?: string): string {
  const value = params[key] ?? fallback;
  if (typeof value !== 'string' || !value.length || value.length > max) throw new Error(`Enter a valid ${key} (up to ${max} characters).`);
  return value;
}

export async function browserCredentials(project: string, request: WorkspaceBrowserRequest): Promise<unknown> {
  const params = request.params ?? {}, action = params['action'] ?? 'list', store = storage();
  if (request.openedBy === 'ai' && (typeof action !== 'string' || !['list', 'fill', 'lock'].includes(action))) throw new Error('Manage vault passwords and saved logins in the dashboard credential manager. Automation can list or fill unlocked logins.');
  if (action !== 'list' && request.confirmed !== true) throw new Error('Credential changes require confirmed=true.');
  if (action === 'lock') { lock(project); return { locked: true, exists: !!store.get(namespace, project), entries: [] }; }
  if (action === 'unlock') {
    const password = field(params, 'masterPassword', 1024);
    const existing = store.get<string>(namespace, project);
    if (!existing && password.length < 12) throw new Error('Use at least 12 characters for a new vault master password.');
    let key: Buffer | undefined;
    try {
      const salt = existing ? (JSON.parse(existing) as Envelope).salt : randomBytes(16).toString('base64');
      key = await new Promise<Buffer>((resolve, reject) => scrypt(password, Buffer.from(salt, 'base64'), 32, (error, key) => error ? reject(error) : resolve(key)));
      const raw = existing ?? encrypt([], key, salt, project);
      const rows = decrypt(raw, key, project);
      store.transaction(() => {
        if (store.get<string>(namespace, project) !== existing) throw new Error('Vault changed.');
        if (!existing) store.set(namespace, project, raw);
      });
      lock(project); unlocked.set(project, { key, raw, expires: Date.now() + lifetime });
      for (const row of rows) secrets.add(row.password);
    } catch { key?.fill(0); throw new Error('Could not unlock the vault. Check the master password or reconnect; existing data was preserved.'); }
  }
  if (action === 'list' && (!unlocked.has(project) || unlocked.get(project)!.expires < Date.now())) {
    lock(project); return { locked: true, exists: !!store.get(namespace, project), entries: [] };
  }
  const { vault, rows } = opened(project);
  if (action === 'save') {
    const existing = params['id'] === undefined ? undefined : rows.find(row => row.id === params['id']);
    if (params['id'] !== undefined && !existing) throw new Error('This login no longer exists. Refresh the vault.');
    if (!existing && rows.length >= 32) throw new Error('This project vault holds 32 logins. Delete one first.');
    const login: Login = {
      id: existing?.id ?? randomUUID(), name: field(params, 'name', 128), origin: new URL(browserUrl(field(params, 'origin', 2000))).origin,
      username: field(params, 'username', 1024), password: field({ ...params, password: params['password'] || existing?.password }, 'password', 4096),
      usernameSelector: field(params, 'usernameSelector', 2000, 'input[autocomplete="username"],input[type="email"]'),
      passwordSelector: field(params, 'passwordSelector', 2000, 'input[type="password"]')
    };
    const next = existing ? rows.map(row => row.id === existing.id ? login : row) : [...rows, login];
    secrets.add(login.password); commit(project, vault, next);
    return { locked: false, exists: true, entries: next.map(({ password: _password, ...row }) => row), message: existing ? 'Login updated.' : 'Login saved.' };
  }
  if (action === 'delete') {
    if (!rows.some(row => row.id === params['id'])) throw new Error('This login no longer exists. Refresh the vault.');
    const next = rows.filter(row => row.id !== params['id']); commit(project, vault, next);
    return { locked: false, exists: true, entries: next.map(({ password: _password, ...row }) => row), message: 'Login deleted.' };
  }
  if (action !== 'list' && action !== 'unlock') throw new Error('Choose list, unlock, lock, save, delete, or fill.');
  return { locked: false, exists: true, entries: rows.map(({ password: _password, ...row }) => row) };
}

export async function fillBrowserCredential(project: string, page: Page, request: WorkspaceBrowserRequest): Promise<unknown> {
  if (request.confirmed !== true) throw new Error('Credential fill requires confirmed=true.');
  const login = opened(project).rows.find(row => row.id === request.params?.['id']);
  if (!login) throw new Error('Choose a saved login from this project vault.');
  const origin = login.origin;
  if (new URL(page.url()).origin !== origin) throw new Error('Login origin does not match this page. Nothing was filled.');
  // Resolve and check both fields before inserting a secret; never fill a visible text field with a password.
  try {
    await page.evaluate(({ login, origin }) => {
      if (location.origin !== origin) throw new Error('Origin changed.');
      const username = document.querySelectorAll(login.usernameSelector), password = document.querySelectorAll(login.passwordSelector);
      if (username.length !== 1 || password.length !== 1 || username[0] === password[0]) throw new Error('Ambiguous login fields.');
      if (!(username[0] instanceof HTMLInputElement) || !(password[0] instanceof HTMLInputElement) || password[0].type !== 'password') throw new Error('Invalid login fields.');
      for (const field of [username[0], password[0]]) if (field.disabled || field.readOnly || !field.getClientRects().length) throw new Error('Login field unavailable.');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(username[0], login.username); set.call(password[0], login.password);
      for (const field of [username[0], password[0]]) { field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); }
    }, { login, origin });
  } catch { throw new Error('Login fields could not be filled. Inspect the page before retrying; the site may have received input.'); }
  return { filled: true, message: 'Login filled. Submit the form when ready.' };
}

export function redactBrowserCredentials<T>(value: T): T {
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) {
      for (const encoded of new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')])) {
        if (encoded.length >= 8 || value === encoded) value = (value as string).split(encoded).join('[redacted]') as T;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactBrowserCredentials) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, redactBrowserCredentials(value)])) as T;
  return value;
}
