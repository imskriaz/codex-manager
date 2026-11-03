import { notificationTargetUrl } from '../domain/notificationTarget';
import type webPush from "web-push";
import type * as vscode from "vscode";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { compactNotificationMessage, type MirroredNotification } from "../utils/notificationMirror";

const STORAGE_KEY = "codexManager.browserPush.v1";
const MAX_SUBSCRIPTIONS = 64;
const SUBSCRIPTION_TTL = 30 * 24 * 60 * 60_000;
type Subscription = webPush.PushSubscription & { owner: string; origin: string; password?: string; expiresAt: number };
type PushState = { keys: { publicKey: string; privateKey: string }; subscriptions: Subscription[]; delivered?: Array<[string, number]> };
const DELIVERY_RETENTION_MS = 24 * 60 * 60_000;
const MAX_DELIVERIES = 1024;

export class BrowserPushRegistrationConflictError extends Error {
  constructor() { super("Notification registration needs refreshing."); }
}

let webPushModule: Promise<typeof import("web-push")> | undefined;
function loadWebPush(): Promise<typeof import("web-push")> {
  return (webPushModule ??= import("web-push").then((module) => {
    const runtime = module as unknown as { default?: typeof import("web-push") };
    return runtime.default ?? (module as unknown as typeof import("web-push"));
  }));
}

/** Restrict outbound requests to browser push services, never arbitrary dashboard-supplied URLs. */
export function validateBrowserPushSubscription(value: unknown): webPush.PushSubscription {
  if (!value || typeof value !== "object") throw new Error("Invalid subscription. Enable notifications again.");
  const entry = value as Partial<webPush.PushSubscription>;
  const url = new URL(typeof entry.endpoint === "string" ? entry.endpoint : "invalid:");
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "fcm.googleapis.com" ||
    host === "web.push.apple.com" ||
    host.endsWith(".push.services.mozilla.com") ||
    host.endsWith(".notify.windows.com") ||
    host.endsWith(".push.apple.com");
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !allowed ||
    url.hash ||
    url.href.length > 4096 ||
    !entry.keys ||
    !/^[\w-]{87}=?$/.test(entry.keys.p256dh) ||
    !/^[\w-]{22}={0,2}$/.test(entry.keys.auth) ||
    Buffer.from(entry.keys.p256dh, "base64url").length !== 65 ||
    Buffer.from(entry.keys.p256dh, "base64url")[0] !== 4 ||
    Buffer.from(entry.keys.auth, "base64url").length !== 16
  )
    throw new Error("Invalid browser push service or subscription keys.");
  return { endpoint: url.href, keys: { p256dh: entry.keys.p256dh, auth: entry.keys.auth } };
}

export class BrowserPushService {
  private mutations: Promise<unknown> = Promise.resolve();
  private sends: Promise<void> = Promise.resolve();
  private queued = 0;
  private recent = new Map<string, number>();
  private readonly actions = new Map<string, string[]>();
  private testing: Promise<{ subscriptions: number; accepted: number; failed: number }> | undefined;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly password: () => Promise<string | undefined>
  ) {}

  private async read(): Promise<PushState> {
    const raw = await this.secrets.get(STORAGE_KEY);
    if (!raw) return { keys: (await loadWebPush()).generateVAPIDKeys(), subscriptions: [] };
    const state = JSON.parse(raw) as PushState;
    if (!state || typeof state !== "object" || !state.keys?.publicKey || !state.keys.privateKey || !Array.isArray(state.subscriptions))
        throw new Error("Notification storage is unavailable. Try again.");
    state.delivered = Array.isArray(state.delivered) ? state.delivered.filter(entry => Array.isArray(entry) &&
      typeof entry[0] === "string" && /^[a-f0-9]{64}$/.test(entry[0]) && Number.isFinite(entry[1]) && entry[1] > Date.now()).slice(-MAX_DELIVERIES) : [];
    return state;
  }

  private mutate<T>(work: (state: PushState) => T | Promise<T>): Promise<T> {
    const task = this.mutations
      .catch(() => undefined)
      .then(async () => {
        const state = await this.read();
        state.subscriptions = state.subscriptions.filter(item => item && typeof item === "object" && typeof item.endpoint === "string" && item.keys && Number.isFinite(item.expiresAt) && item.expiresAt > Date.now());
        const result = await work(state);
        await this.secrets.store(STORAGE_KEY, JSON.stringify(state));
        return result;
      });
    this.mutations = task;
    return task;
  }

  publicKey(): Promise<string> {
    return this.mutate((state) => state.keys.publicKey);
  }

  subscribe(value: unknown, owner: string, origin: string, password?: string): Promise<void> {
    const subscription = validateBrowserPushSubscription(value);
    return this.mutate((state) => {
      const existing = state.subscriptions.find((item) => item.endpoint === subscription.endpoint);
      if (
        existing &&
        (existing.origin !== origin ||
          existing.keys.p256dh !== subscription.keys.p256dh ||
          existing.keys.auth !== subscription.keys.auth)
      )
        throw new BrowserPushRegistrationConflictError();
      state.subscriptions = state.subscriptions.filter(
        (item) => item.endpoint !== subscription.endpoint && item.expiresAt > Date.now()
      );
      if (state.subscriptions.length >= MAX_SUBSCRIPTIONS)
        throw new Error(
          "Too many devices are connected. Disable one first."
        );
      state.subscriptions.push({ ...subscription, owner, origin, password, expiresAt: Date.now() + SUBSCRIPTION_TTL });
    });
  }

  unsubscribe(endpoint: string, owner: string, origin: string): Promise<void> {
    return this.mutate((state) => {
      state.subscriptions = state.subscriptions.filter(
        (item) => item.endpoint !== endpoint || item.owner !== owner || item.origin !== origin
      );
    });
  }

  revokeOwner(owner: string): Promise<void> {
    return this.mutate((state) => {
      state.subscriptions = state.subscriptions.filter((item) => item.owner !== owner);
    });
  }

  dismiss(notificationId: string): void {
    this.actions.delete(notificationId);
  }
  takeAction(notificationId: string, action: string): boolean {
    if (!this.actions.get(notificationId)?.includes(action)) return false;
    this.actions.delete(notificationId);
    return true;
  }

  notify(notice: MirroredNotification): void {
    if (notice.level === "info" && !notice.actions?.length) return;
    const key = createHash("sha256").update(JSON.stringify([notice.systemName?.trim() || hostname(),
      notice.notificationId ?? [notice.level, notice.title, notice.message]])).digest("hex");
    const now = Date.now();
    const expiresAt = now + (notice.notificationId ? DELIVERY_RETENTION_MS : 5 * 60_000);
    for (const [id, until] of this.recent) if (until <= now) this.recent.delete(id);
    if (this.recent.has(key)) return;
    if (this.queued >= 32) {
      console.warn("[codexManager] push notification queue full");
      return;
    }
    this.recent.set(key, expiresAt);
    while (this.recent.size > MAX_DELIVERIES) this.recent.delete(this.recent.keys().next().value!);
    if (notice.notificationId && notice.actions?.length) {
      this.actions.set(notice.notificationId, notice.actions.slice(0, 2));
      if (this.actions.size > 64) this.actions.delete(this.actions.keys().next().value!);
    }
    this.queued++;
    let acceptedDelivery = false;
    const work = this.sends
      .catch(() => undefined)
      .then(async () => {
        await this.mutations.catch(() => undefined);
        const state = await this.read();
        const password = await this.password();
        const webPush = await loadWebPush();
        const expired = new Set<string>();
        const delivered = new Map((state.delivered ?? []).filter(([id, until]) => typeof id === "string" && Number.isFinite(until) && until > now));
        const accepted: Array<[string, number]> = [];
        let retryable = false;
        const payload = JSON.stringify({
          title: compactNotificationMessage(`${notice.systemName?.trim() || hostname()} · ${notice.title ?? "Codex Manager"}`, 120),
          body: compactNotificationMessage(notice.message, 180),
          tag: `codex-manager-${key}`,
          eventId: key,
          dedupeUntil: expiresAt,
          level: notice.level,
          notificationId: notice.notificationId,
          actions: notice.actions?.slice(0, 2),
          replyAction: notice.replyAction,
          url: notificationTargetUrl(notice.url),
          createdAt: now
        });
        await Promise.all(state.subscriptions.slice(0, MAX_SUBSCRIPTIONS).map(async subscription => {
          const deliveryId = createHash("sha256").update(`${key}:${subscription.endpoint}`).digest("hex");
          if (delivered.has(deliveryId)) return;
          if (Date.now() - now > (notice.actions?.length ? 120_000 : 300_000)) return;
          if (
            subscription.expiresAt <= Date.now() ||
            (subscription.password !== undefined && subscription.password !== password)
          ) {
            expired.add(subscription.endpoint);
            return;
          }
          try {
            await webPush.sendNotification(validateBrowserPushSubscription(subscription), payload, {
              TTL: notice.actions?.length ? 120 : 300,
              urgency: notice.level === "error" ? "high" : "normal",
              timeout: 8_000,
              vapidDetails: { subject: "https://github.com/imskriaz/codex-manager", ...state.keys }
            });
            acceptedDelivery = true;
            accepted.push([deliveryId, expiresAt]);
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) expired.add(subscription.endpoint);
            else { retryable = true; console.warn("[codexManager] push delivery failed", status ?? "network unavailable"); }
          }
        }));
        if (retryable || !accepted.length && !state.subscriptions.length) this.recent.delete(key);
        if (expired.size || accepted.length)
          await this.mutate((current) => {
            current.subscriptions = current.subscriptions.filter((item) => !expired.has(item.endpoint));
            const retained = new Map((current.delivered ?? []).filter(([, until]) => until > Date.now()));
            for (const entry of accepted) retained.set(...entry);
            current.delivered = [...retained].slice(-MAX_DELIVERIES);
          });
      })
      .catch(() => {
        if (!acceptedDelivery) this.recent.delete(key);
        console.warn("[codexManager] push notification storage unavailable");
      })
      .finally(() => {
        this.queued--;
      });
    this.sends = work;
  }

  flush(): Promise<void> { return this.sends; }

  /** Provider acceptance is observable; the browser controls when a phone displays the push. */
  sendTest(): Promise<{ subscriptions: number; accepted: number; failed: number }> {
    if (this.testing) return this.testing;
    if (this.queued >= 32) return Promise.reject(new Error("Notification delivery is busy. Retry shortly."));
    this.queued++;
    const work = this.sends.catch(() => undefined).then(async () => {
      await this.mutations.catch(() => undefined);
      const state = await this.read();
      const password = await this.password();
      const webPush = await loadWebPush();
      const subscriptions = state.subscriptions.slice(0, MAX_SUBSCRIPTIONS).filter(subscription =>
        subscription.expiresAt > Date.now() && (subscription.password === undefined || subscription.password === password));
      const result = { subscriptions: subscriptions.length, accepted: 0, failed: 0 };
      const expired = new Set<string>();
      const payload = JSON.stringify({ title: `${hostname()} · Codex Manager`, body: "Test notification: this device is connected.", tag: "codex-manager-delivery-test", eventId: randomUUID(), url: "/", createdAt: Date.now() });
      await Promise.all(subscriptions.map(async subscription => {
        try {
          await webPush.sendNotification(validateBrowserPushSubscription(subscription), payload, {
            TTL: 120, urgency: "high", timeout: 8000,
            vapidDetails: { subject: "https://github.com/imskriaz/codex-manager", ...state.keys }
          });
          result.accepted++;
        } catch (error) {
          result.failed++;
          if ([404, 410].includes((error as { statusCode?: number }).statusCode ?? 0)) expired.add(subscription.endpoint);
        }
      }));
      if (expired.size) await this.mutate(current => {
        current.subscriptions = current.subscriptions.filter(subscription => !expired.has(subscription.endpoint));
      });
      return result;
    }).finally(() => { this.queued--; if (this.testing === work) this.testing = undefined; });
    this.testing = work;
    this.sends = work.then(() => undefined, () => undefined);
    return work;
  }

  async hasSubscriptions(): Promise<boolean> {
    await this.mutations.catch(() => undefined);
    const raw = await this.secrets.get(STORAGE_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw) as PushState;
    return Array.isArray(state.subscriptions) && state.subscriptions.some(item => item.expiresAt > Date.now());
  }

  async isSubscribed(endpoint: string, owner: string, origin: string): Promise<boolean> {
    await this.mutations.catch(() => undefined);
    const state = await this.read(), password = await this.password();
    return state.subscriptions.some(item => item.endpoint === endpoint && item.owner === owner && item.origin === origin &&
      item.expiresAt > Date.now() && (item.password === undefined || item.password === password));
  }
}
