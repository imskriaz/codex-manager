import { createHash, randomBytes } from "node:crypto";
import type { SecretStorage } from "vscode";

const STORAGE_KEY = "codexManager.conversationShares.v1";
const TTL = 30 * 24 * 60 * 60 * 1000;
type Share = { fingerprint: string; sessionKey: string; title: string; messages: { role: string; text: string }[]; expiresAt: number };
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");

/** Explicitly published snapshots never grant dashboard or account access. */
export class ConversationShares {
  private writes: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(private readonly secrets: Pick<SecretStorage, "get" | "store">) {}

  private async read(): Promise<Share[]> {
    const raw = await this.secrets.get(STORAGE_KEY);
    if (!raw) return [];
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("Shared conversation storage is full. Revoke a link and retry.");
    const records: unknown = JSON.parse(raw);
    if (!Array.isArray(records)) throw new Error("Shared conversation storage could not be read. Restore storage before retrying.");
    return (records as Share[]).filter(record => typeof record.fingerprint === "string" &&
      typeof record.sessionKey === "string" && typeof record.title === "string" &&
      Array.isArray(record.messages) && record.messages.every(message =>
        (message.role === "user" || message.role === "assistant") && typeof message.text === "string") && record.expiresAt > Date.now());
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= 16) return Promise.reject(new Error("Share requests are busy. Retry shortly."));
    this.pending++;
    const result = this.writes.catch(() => undefined).then(work).finally(() => { this.pending--; });
    this.writes = result;
    return result;
  }

  create(input: unknown): Promise<{ token: string; expiresAt: number }> {
    return this.mutate(async () => {
      const value = input as Partial<Share> | undefined;
      if (!value || typeof value.sessionKey !== "string" || !value.sessionKey || value.sessionKey.length > 256 ||
          typeof value.title !== "string" || value.title.length > 512 || !Array.isArray(value.messages) || !value.messages.length ||
          value.messages.length > 2000 || value.messages.some(message => !message ||
            (message.role !== "user" && message.role !== "assistant") || typeof message.text !== "string"))
        throw new Error("Choose a conversation with messages before sharing.");
      const token = randomBytes(32).toString("hex");
      const expiresAt = Date.now() + TTL;
      const share: Share = { fingerprint: fingerprint(token), sessionKey: value.sessionKey, title: value.title,
        messages: value.messages.map(message => ({ role: message.role, text: message.text })), expiresAt };
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
      await this.secrets.store(STORAGE_KEY, JSON.stringify((await this.read()).filter(record => record.sessionKey !== sessionKey)));
    });
  }

  async get(token: string): Promise<Share | undefined> {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    await this.writes.catch(() => undefined);
    return (await this.read()).find(record => record.fingerprint === fingerprint(token));
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function sharedConversationPage(share: Share): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escapeHtml(share.title)} · Shared conversation</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;font:15px/1.6 system-ui;background:light-dark(#fafafa,#151719);color:light-dark(#202124,#eef0f2)}main{max-width:800px;margin:auto;padding:24px 16px}h1{font-size:24px;overflow-wrap:anywhere}header p{opacity:.75}article{margin:20px 0;padding:16px;border:1px solid light-dark(#ddd,#383c40);border-radius:12px}h2{font-size:13px;margin:0 0 10px}article div{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><main><header><h1>${escapeHtml(share.title)}</h1><p>Shared conversation · Read only · Snapshot expires ${new Date(share.expiresAt).toISOString().slice(0,10)}</p></header>${share.messages.map(message => `<article><h2>${message.role === "user" ? "You" : "Codex"}</h2><div>${escapeHtml(message.text)}</div></article>`).join("")}</main></body></html>`;
}
