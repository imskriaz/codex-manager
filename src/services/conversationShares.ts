import { createHash, randomBytes } from "node:crypto";
import type { SecretStorage } from "vscode";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import type { DashboardCliSessionMessage } from '../domain/dashboard/types';
import { validMessage } from '../domain/codexSessionLive';
import { safeConversationImage } from '../domain/conversationFiles';

const STORAGE_KEY = "codexManager.conversationShares.v1";
const TTL = 30 * 24 * 60 * 60 * 1000;
type SharedMessage = Pick<DashboardCliSessionMessage, 'text'> & Partial<DashboardCliSessionMessage>;
type Share = { fingerprint: string; sessionKey: string; title: string; messages: SharedMessage[]; includeActivities?: boolean; nativeSession?: boolean; sourceHome?: string; expiresAt: number };
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");
const messageFields = ['id','turnId','kind','role','text','title','subtitle','status','command','cwd','output','exitCode','durationMs','arguments','result','debug','changes','images','textAttachments','timestamp'];
function sharedMessage(value: unknown, index: number, activities: boolean): SharedMessage | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  if (!activities) return (item['role'] === 'user' || item['role'] === 'assistant') && (!item['kind'] || item['kind'] === 'message') && typeof item['text'] === 'string' ? { role: item['role'], text: item['text'] } : undefined;
  const result = { id: `shared-${index}`, ...Object.fromEntries(messageFields.filter(key => item[key] !== undefined).map(key => [key, item[key]])) };
  if (!validMessage(result, 12 * 1024 * 1024)) return;
  const message = result as DashboardCliSessionMessage;
  return { ...message, ...(message.images ? { images: message.images.filter(image => safeConversationImage(image.src)) } : {}) };
}

export function publicShareMessages(messages: readonly unknown[]): SharedMessage[] {
  return messages.slice(-2000).flatMap((message,index) => { const item=sharedMessage(message,index,true); return item ? [item] : []; });
}

/** Explicitly published snapshots never grant dashboard or account access. */
export class ConversationShares {
  private writes: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(private readonly secrets: Pick<SecretStorage, "get" | "store">) {}

  private async read(allowFull = false): Promise<Share[]> {
    const raw = await this.secrets.get(STORAGE_KEY);
    if (!raw) return [];
    if (Buffer.byteLength(raw) > (allowFull ? 8 : 2) * 1024 * 1024) throw new Error("Shared conversation storage is full. Revoke a link and retry.");
    const records: unknown = JSON.parse(raw);
    if (!Array.isArray(records)) throw new Error("Shared conversation storage could not be read. Restore storage before retrying.");
    return (records as Share[]).filter(record => record && typeof record === "object" && typeof record.fingerprint === "string" &&
      typeof record.sessionKey === "string" && typeof record.title === "string" &&
      Array.isArray(record.messages) && record.messages.every((message, index) => Boolean(sharedMessage(message, index, record.includeActivities === true))) &&
      typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) && record.expiresAt > Date.now());
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= 16) return Promise.reject(new Error("Share requests are busy. Retry shortly."));
    this.pending++;
    const result = this.writes.catch(() => undefined)
      .then(() => runCrossWindowExclusive("state:conversation-shares", "Shared conversation update", work, { waitMs: 500 }))
      .finally(() => { this.pending--; });
    this.writes = result;
    return result;
  }

  create(input: unknown, sourceHome?: string): Promise<{ token: string; expiresAt: number }> {
    return this.mutate(async () => {
      const value = input as Partial<Share> | undefined;
      if (!value || typeof value.sessionKey !== 'string' || !value.sessionKey || value.sessionKey.length > 256 || typeof value.title !== 'string' || value.title.length > 512 || value.includeActivities !== undefined && typeof value.includeActivities !== 'boolean') throw new Error('Choose a conversation with messages before sharing.');
      let target: unknown;
      try { target=JSON.parse(value.sessionKey); } catch { /* Snapshot-only links retain their published content. */ }
      const nativeSession=Boolean(sourceHome && value.includeActivities && Array.isArray(target) && target[0] === 'local' && typeof target[1] === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(target[1]));
      const messages=value.messages ?? [];
      if (!Array.isArray(messages) || !nativeSession && !messages.length || messages.length>2000 || messages.some((message,index)=>!sharedMessage(message,index,value.includeActivities===true))) throw new Error('Choose a conversation with messages before sharing.');
      const token = randomBytes(32).toString("hex");
      const expiresAt = Date.now() + TTL;
      const share: Share = { fingerprint: fingerprint(token), sessionKey: value.sessionKey, title: value.title,
        messages: messages.map((message, index) => sharedMessage(message, index, value.includeActivities === true)!), ...(value.includeActivities ? { includeActivities: true } : {}), ...(sourceHome ? { sourceHome } : {}), ...(nativeSession ? { nativeSession:true } : {}), expiresAt };
      if (Buffer.byteLength(JSON.stringify(share)) > 256 * 1024) throw new Error("This conversation is too large to share. Share a shorter conversation.");
      const records = (await this.read()).filter(record => record.sessionKey !== share.sessionKey);
      if (records.length >= 32) throw new Error("Shared link storage is full. Revoke a link before creating another.");
      records.push(share);
      const raw = JSON.stringify(records);
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("Shared conversation storage is full. Revoke a link and retry.");
      await this.secrets.store(STORAGE_KEY, raw);
      return { token, expiresAt };
    });
  }

  revoke(sessionKey: unknown): Promise<void> {
    return this.mutate(async () => {
      if (typeof sessionKey !== "string" || !sessionKey || sessionKey.length > 256) throw new Error("Choose a conversation before revoking its link.");
      await this.secrets.store(STORAGE_KEY, JSON.stringify((await this.read(true)).filter(record => record.sessionKey !== sessionKey)));
    });
  }

  async get(token: string): Promise<Share | undefined> {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    await this.writes.catch(() => undefined);
    return (await this.read()).find(record => record.fingerprint === fingerprint(token));
  }

  async refresh(token: string, messages: readonly unknown[]): Promise<Share | undefined> {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    return this.mutate(async () => {
      const records = await this.read();
      const index = records.findIndex((record) => record.fingerprint === fingerprint(token));
      if (index < 0) return undefined;
      const current = records[index]!;
      const nextMessages = messages.slice(-2000).flatMap((message, index) => { const next = sharedMessage(message, index, current.includeActivities === true); return next ? [next] : []; });
      if (!nextMessages.length || Buffer.byteLength(JSON.stringify(nextMessages)) > 256 * 1024) return current;
      if (JSON.stringify(nextMessages) === JSON.stringify(current.messages)) return current;
      const updated = { ...current, messages: nextMessages };
      records[index] = updated;
      const raw = JSON.stringify(records);
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) return current;
      await this.secrets.store(STORAGE_KEY, raw);
      return updated;
    });
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function sharedConversationPage(share: Share, token?: string): string {
  const messages = share.messages.map(message => `<article class="cli-session-message is-${message.role === 'user' ? 'user' : 'assistant'}"><div class="cli-session-message-body"><div class="cli-session-message-text">${escapeHtml(message.text)}</div></div></article>`).join('');
  return `<!doctype html><html lang="en" data-theme="auto"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="theme-color" content="#101827"><title>${escapeHtml(share.title)} · Shared conversation</title><link rel="stylesheet" href="/assets/shared.css"><link rel="stylesheet" href="/assets/dashboard.css"></head><body class="public-conversation"><main class="cli-workspace cli-public-session"><div id="shared-header"><header class="cli-conversation-header"><div class="cli-conversation-title"><h1 id="conversation-title">${escapeHtml(share.title)}</h1></div></header></div><span id="live-state" role="status"></span><div class="cli-message-region"><section id="conversation" class="cli-message-viewport" aria-label="Conversation"><div class="cli-session-messages">${messages}</div></section></div></main>${token ? '<script src="/assets/dashboard.js" defer></script><script src="/assets/sharedConversation.js" defer></script>' : ''}</body></html>`;
}
