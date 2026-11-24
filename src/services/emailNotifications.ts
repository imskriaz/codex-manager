import { createHash, randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import { getSqliteStateStore } from '../storage/sqliteState';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';
import { waitWithin } from '../utils/concurrency';
import { getOfficeUser } from './officeUsers';

const CONFIG_KEY = 'codexManager.smtp.v1';
export type EmailEvent = 'ready' | 'needsAnswer' | 'failed';
export interface EmailPreferences {
  revision: string; enabled: boolean; address: string; ready: boolean; needsAnswer: boolean; failed: boolean; includeResult: boolean;
}
export interface SmtpConfig {
  revision: string; enabled: boolean; host: string; port: number; security: 'starttls' | 'tls'; user: string; password: string; from: string; baseUrl: string;
}
export type PublicSmtpConfig = Omit<SmtpConfig, 'password'> & { hasPassword: boolean };
export interface EmailNotice { id: string; owner?: string; sessionKey?: string; event: EmailEvent; title: string; message: string; url?: string; result?: string }
type Delivery = { at: number; state: 'sending' | 'accepted' | 'failed'; error?: string };
const defaults: SmtpConfig = { revision: '', enabled: false, host: '', port: 587, security: 'starttls', user: '', password: '', from: '', baseUrl: '' };
export const defaultEmailPreferences: EmailPreferences = { revision: '', enabled: false, address: '', ready: true, needsAnswer: true, failed: true, includeResult: false };

function store() { const value = getSqliteStateStore(); if (!value) throw new Error('Email notification storage is unavailable. Retry when the host is ready.'); return value; }
function namespace(owner: string) { return owner === 'master' ? 'master-email-notifications' : `office-preferences:${owner}`; }
function email(value: unknown, optional = false): string {
  if (optional && value === '') return '';
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(value)) throw new Error('Enter one valid email address.');
  return value;
}
function form(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Send a valid email settings form.'); return value as Record<string, unknown>; }
function text(value: unknown, max: number): string { if (typeof value !== 'string' || value.length > max || /[\r\n\0]/.test(value)) throw new Error('Enter valid SMTP settings without line breaks.'); return value.trim(); }

export function readEmailPreferences(owner: string): EmailPreferences {
  return store().get<EmailPreferences>(namespace(owner), 'email') ?? { ...defaultEmailPreferences };
}
export function readEmailWatches(owner: string): string[] { return store().get<string[]>(namespace(owner), 'email-watches') ?? []; }
export function saveEmailWatch(owner: string, input: unknown, address = readEmailPreferences(owner).address): string[] {
  const body = form(input), key = body['sessionKey'];
  if (typeof key !== 'string' || !/^(?:local|[a-zA-Z0-9_-]{1,128}):[a-f0-9-]{36}$/.test(key) || typeof body['enabled'] !== 'boolean') throw new Error('Choose a valid conversation for email notifications.');
  if (body['enabled'] && !address) throw new Error('Add your email address in Settings before enabling session emails.');
  return store().transaction(() => {
    const values = readEmailWatches(owner).filter(value => value !== key);
    if (body['enabled']) { if (values.length >= 100) throw new Error('You can watch up to 100 conversations. Turn off another session email first.'); values.push(key); }
    store().set(namespace(owner), 'email-watches', values); return values;
  });
}
export function saveEmailPreferences(owner: string, input: unknown): EmailPreferences {
  const body = form(input);
  for (const key of ['enabled', 'ready', 'needsAnswer', 'failed', 'includeResult']) if (typeof body[key] !== 'boolean') throw new Error('Choose which email notifications to receive.');
  const address = email(body['address'], body['enabled'] === false);
  return store().transaction(() => {
    if (body['revision'] !== readEmailPreferences(owner).revision) throw new Error('Email preferences changed in another window. Refresh and review before saving.');
    const value: EmailPreferences = { revision: randomUUID(), enabled: body['enabled'] as boolean, address, ready: body['ready'] as boolean, needsAnswer: body['needsAnswer'] as boolean, failed: body['failed'] as boolean, includeResult: body['includeResult'] as boolean };
    store().set(namespace(owner), 'email', value); return value;
  });
}

export class EmailNotificationService {
  private sends: Promise<void> = Promise.resolve();
  private queued = 0;
  constructor(private readonly secrets: vscode.SecretStorage, private readonly ownerAllowed: (owner: string) => Promise<boolean> = () => Promise.resolve(true)) {}

  async preferences(owner: string): Promise<EmailPreferences> {
    const prefs = readEmailPreferences(owner);
    return owner === 'master' ? prefs : { ...prefs, address: (await getOfficeUser(owner))?.username ?? '' };
  }

  private async config(): Promise<SmtpConfig> {
    const saved = await this.secrets.get(CONFIG_KEY);
    return saved ? { ...defaults, ...JSON.parse(saved) as SmtpConfig } : { ...defaults };
  }
  async publicConfig(): Promise<PublicSmtpConfig> {
    const { password, ...value } = await this.config(); return { ...value, hasPassword: !!password };
  }
  async saveConfig(input: unknown): Promise<PublicSmtpConfig> {
    const body = form(input);
    await runCrossWindowExclusive('state:smtp-settings', 'Save SMTP settings', async () => {
      const previous = await this.config();
      if (body['revision'] !== previous.revision) throw new Error('SMTP settings changed in another window. Refresh and review before saving.');
      if (typeof body['enabled'] !== 'boolean' || !['tls', 'starttls'].includes(String(body['security']))) throw new Error('Choose SMTP availability and connection security.');
      const host = text(body['host'], 253), user = text(body['user'], 320), baseUrl = text(body['baseUrl'], 2048);
      if (host && !/^[a-z0-9._:-]+$/i.test(host) || body['enabled'] && !host) throw new Error('Enter a valid SMTP host name.');
      const port = body['port'];
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter an SMTP port from 1 to 65535.');
      if (baseUrl) { const url = new URL(baseUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the dashboard origin, for example https://dashboard.example.'); }
      const password = body['clearPassword'] === true ? '' : body['password'] === '' || body['password'] === undefined ? previous.password : body['password'];
      if (typeof password !== 'string' || password.length > 4096 || /[\r\n\0]/.test(password)) throw new Error('Enter a valid SMTP password.');
      if (body['enabled'] && user && !password) throw new Error('Enter the SMTP password or app password.');
      const value: SmtpConfig = { revision: randomUUID(), enabled: body['enabled'], host, port, security: body['security'] as SmtpConfig['security'], user, password, from: email(body['from'], body['enabled'] === false), baseUrl: baseUrl.replace(/\/$/, '') };
      await this.secrets.store(CONFIG_KEY, JSON.stringify(value));
    }, { waitMs: 2000 });
    return this.publicConfig();
  }
  hasMasterSubscription(): boolean { const prefs = readEmailPreferences('master'); return prefs.enabled && (prefs.ready || prefs.needsAnswer || prefs.failed) || readEmailWatches('master').length > 0; }
  status(owner: string): Delivery | undefined { return store().get<Delivery>(namespace(owner), 'email-status'); }

  private async send(address: string, notice: EmailNotice, includeResult: boolean): Promise<void> {
    const config = await this.config();
    if (!config.enabled) throw new Error('Email delivery is disabled. Ask the administrator to configure SMTP.');
    const module = await import('nodemailer');
    const transport = module.createTransport({ host: config.host, port: config.port, secure: config.security === 'tls', requireTLS: config.security === 'starttls', ...(config.user ? { auth: { user: config.user, pass: config.password } } : {}), connectionTimeout: 4000, greetingTimeout: 4000, socketTimeout: 8000, dnsTimeout: 4000, disableFileAccess: true, disableUrlAccess: true });
    const url = config.baseUrl && notice.url?.startsWith('/workspace/') ? new URL(notice.url, config.baseUrl).href : '';
    const body = [notice.message, includeResult && notice.result ? notice.result.slice(0, 6000) : '', url ? `Open conversation: ${url}` : 'Open your workspace to view the conversation.'].filter(Boolean).join('\n\n');
    try {
      const result = await waitWithin(transport.sendMail({ from: config.from, to: email(address), subject: `[Codex Manager] ${notice.title.replace(/[\r\n]/g, ' ').slice(0, 160)}`, text: body }), 10000, 'SMTP delivery timed out. Delivery could not be confirmed; check your inbox before retrying.');
      if (!result.accepted?.length || result.rejected?.length) throw new Error('The SMTP server rejected the recipient. Check the address and SMTP permissions.');
    } catch (error) {
      // SMTP errors can contain credentials echoed by a server; keep them out of UI and logs.
      const code = (error as { code?: string }).code;
      throw new Error(code === 'EAUTH' ? 'SMTP authentication failed. Check the username and app password.' : code === 'ETIMEDOUT' || error instanceof Error && error.message.startsWith('SMTP delivery timed out') ? 'SMTP delivery timed out. Delivery could not be confirmed; check your inbox before retrying.' : 'Email delivery failed. Check SMTP host, TLS, credentials and recipient permissions.');
    } finally { transport.close(); }
  }
  async test(owner: string): Promise<void> {
    const prefs = await this.preferences(owner);
    await this.send(email(prefs.address), { id: randomUUID(), event: 'ready', title: 'Test email', message: 'Email notifications are connected. Your selected session updates will be sent here.' }, false);
  }
  notify(notice: EmailNotice): void {
    if (this.queued >= 100) { console.warn('[codexManager] Email notification queue is full'); return; }
    this.queued++;
    this.sends = this.sends.catch(() => undefined).then(async () => {
      if (!(await this.config()).enabled) return;
      const owner = notice.owner ?? 'master';
      if (!await this.ownerAllowed(owner)) return;
      const prefs = await this.preferences(owner);
      const watching = !!notice.sessionKey && readEmailWatches(owner).includes(notice.sessionKey);
      if ((!prefs.enabled || !prefs[notice.event]) && !(watching && notice.event === 'ready')) return;
      const id = createHash('sha256').update(notice.id).digest('hex');
      const claimed = store().transaction(() => {
        const deliveries = store().get<Record<string, Delivery>>(namespace(owner), 'email-deliveries') ?? {};
        if ((deliveries[id]?.at ?? 0) > Date.now() - 86400000) return false;
        const recent = Object.fromEntries(Object.entries(deliveries).filter(([, value]) => value.at > Date.now() - 86400000).slice(-127));
        store().set(namespace(owner), 'email-deliveries', { ...recent, [id]: { at: Date.now(), state: 'sending' } }); return true;
      });
      if (!claimed) return;
      let status: Delivery;
      try { await this.send(prefs.address, notice, prefs.includeResult); status = { at: Date.now(), state: 'accepted' }; }
      catch (error) { status = { at: Date.now(), state: 'failed', error: error instanceof Error ? error.message : 'Email delivery failed.' }; }
      store().transaction(() => {
        store().set(namespace(owner), 'email-deliveries', { ...store().get<Record<string, Delivery>>(namespace(owner), 'email-deliveries'), [id]: status });
        store().set(namespace(owner), 'email-status', status);
      });
    }).catch(error => console.warn('[codexManager] Email notification could not be recorded', error instanceof Error ? error.message : 'Storage unavailable')).finally(() => { this.queued--; });
  }
  flush(): Promise<void> { return this.sends; }
}
