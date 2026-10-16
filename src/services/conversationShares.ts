import { createHash, randomBytes } from "node:crypto";
import type { SecretStorage } from "vscode";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";

const STORAGE_KEY = "codexManager.conversationShares.v1";
const TTL = 30 * 24 * 60 * 60 * 1000;
type Share = { fingerprint: string; sessionKey: string; title: string; messages: { role: string; text: string }[]; expiresAt: number };
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");

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
      Array.isArray(record.messages) && record.messages.every(message =>
        message && (message.role === "user" || message.role === "assistant") && typeof message.text === "string") &&
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
      await this.secrets.store(STORAGE_KEY, JSON.stringify((await this.read(true)).filter(record => record.sessionKey !== sessionKey)));
    });
  }

  async get(token: string): Promise<Share | undefined> {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    await this.writes.catch(() => undefined);
    return (await this.read()).find(record => record.fingerprint === fingerprint(token));
  }

  async refresh(token: string, messages: readonly { role?: unknown; text?: unknown }[]): Promise<Share | undefined> {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    return this.mutate(async () => {
      const records = await this.read();
      const index = records.findIndex((record) => record.fingerprint === fingerprint(token));
      if (index < 0) return undefined;
      const current = records[index]!;
      const nextMessages = messages.filter((message) =>
        message && (message.role === "user" || message.role === "assistant") && typeof message.text === "string"
      ).slice(-2000).map((message) => ({ role: message.role as string, text: String(message.text) }));
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
  const date = new Date(share.expiresAt).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });
  const messages = share.messages.map((message, index) => `<article class="message ${message.role === "user" ? "user" : "assistant"}"><div class="message-head"><span class="avatar">${message.role === "user" ? "Y" : "✦"}</span><strong>${message.role === "user" ? "You" : "Codex"}</strong><span class="message-number">${index + 1}</span></div><div class="message-body">${escapeHtml(message.text)}</div></article>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="theme-color" content="#101827"><title>${escapeHtml(share.title)} · Shared conversation</title><style>:root{color-scheme:light dark;--bg:#0d1422;--surface:#151f31;--surface2:#1b2940;--line:#2b3b55;--text:#edf3ff;--muted:#9eacc2;--accent:#78a9ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% -10%,#23395d 0,#0d1422 48%);color:var(--text);font:15px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}main{width:min(860px,100%);margin:auto;padding:clamp(18px,4vw,48px) clamp(14px,4vw,28px) 56px}.topbar{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;letter-spacing:.02em}.topbar .live-state{margin-left:auto;color:#75e2b4;font-size:11px}.topbar .live-state.offline{color:#ffb86b}.mark{display:grid;place-items:center;width:30px;height:30px;border:1px solid #5276ad;border-radius:9px;background:#172845;color:var(--accent);font-size:16px}.topbar strong{color:var(--text);font-size:13px}.hero{margin:26px 0 22px}.eyebrow{margin:0 0 8px;color:var(--accent);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em}.hero h1{margin:0;font-size:clamp(24px,5vw,38px);line-height:1.16;overflow-wrap:anywhere;letter-spacing:-.02em}.hero-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.chip{padding:5px 10px;border:1px solid var(--line);border-radius:999px;background:#142036;color:var(--muted);font-size:12px}.chip.readonly{border-color:#41678f;color:#b9d5ff}.conversation{display:grid;gap:12px}.message{padding:16px 18px;border:1px solid var(--line);border-radius:16px;background:color-mix(in srgb,var(--surface) 94%,transparent);box-shadow:0 8px 24px #0003}.message.user{background:linear-gradient(135deg,#1b3152,#17263d);border-color:#36577f}.message-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;color:var(--muted);font-size:12px}.message-head strong{color:var(--text);font-size:13px}.avatar{display:grid;place-items:center;width:25px;height:25px;border-radius:8px;background:#2a466d;color:#cfe1ff;font-weight:700}.assistant .avatar{background:#234b49;color:#a4eee0}.message-number{margin-left:auto;color:#70809a;font-variant-numeric:tabular-nums}.message-body{white-space:pre-wrap;overflow-wrap:anywhere;color:#e4ebf8}.footer{margin-top:22px;color:var(--muted);font-size:12px;text-align:center}@media(max-width:520px){main{padding-top:16px}.hero{margin-top:20px}.message{padding:14px;border-radius:13px}.message-body{font-size:14px}}
  </style></head><body><main><div class="topbar"><span class="mark">✦</span><strong>Codex Manager</strong><span>·</span><span>Shared conversation</span><span id="live-state" class="live-state">● Live snapshot</span></div><header class="hero"><p class="eyebrow">Read-only snapshot</p><h1 id="conversation-title">${escapeHtml(share.title)}</h1><div class="hero-meta"><span class="chip readonly">Anyone with this link can view</span><span class="chip">Expires ${escapeHtml(date)}</span><span id="message-count" class="chip">${share.messages.length} messages</span></div></header><section id="conversation" class="conversation" aria-label="Conversation">${messages}</section><p class="footer">This link is read-only. New messages appear automatically while the host is online.</p></main>${token ? '<script src="/assets/sharedConversation.js" defer></script>' : ""}</body></html>`;
}
