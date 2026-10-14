import webPush from "web-push";
import type * as vscode from "vscode";
import type { MirroredNotification } from "../utils/notificationMirror";

const STORAGE_KEY = "codexManager.browserPush.v1";
const MAX_SUBSCRIPTIONS = 64;
const SUBSCRIPTION_TTL = 30 * 24 * 60 * 60_000;
type Subscription = webPush.PushSubscription & { owner: string; origin: string; password?: string; expiresAt: number };
type PushState = { keys: { publicKey: string; privateKey: string }; subscriptions: Subscription[] };

/** Restrict outbound requests to browser push services, never arbitrary dashboard-supplied URLs. */
export function validateBrowserPushSubscription(value: unknown): webPush.PushSubscription {
  if (!value || typeof value !== "object") throw new Error("Invalid push subscription. Enable notifications again.");
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

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly password: () => Promise<string | undefined>
  ) {}

  private async read(): Promise<PushState> {
    const raw = await this.secrets.get(STORAGE_KEY);
    if (!raw) return { keys: webPush.generateVAPIDKeys(), subscriptions: [] };
    const state = JSON.parse(raw) as PushState;
    if (!state.keys?.publicKey || !state.keys.privateKey || !Array.isArray(state.subscriptions))
      throw new Error("Push notification storage could not be read. Retry after Secret Storage is available.");
    return state;
  }

  private mutate<T>(work: (state: PushState) => T | Promise<T>): Promise<T> {
    const task = this.mutations
      .catch(() => undefined)
      .then(async () => {
        const state = await this.read();
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
        throw new Error(
          "This subscription belongs to another dashboard login. Disable notifications before subscribing again."
        );
      state.subscriptions = state.subscriptions.filter(
        (item) => item.endpoint !== subscription.endpoint && item.expiresAt > Date.now()
      );
      if (state.subscriptions.length >= MAX_SUBSCRIPTIONS)
        throw new Error(
          "The notification subscription queue is full. Disable notifications on an unused device first."
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
    if (
      notice.level === "info" &&
      !notice.actions?.length &&
      !/\b(switch(?:ed|ing)?|reset quota|reload(?:ing|ed)?|restart(?:ed|ing)?|session (completed|failed|cancelled))\b/i.test(notice.message)
    )
      return;
    const key = notice.notificationId ?? `${notice.level}:${notice.message}`;
    const now = Date.now();
    for (const [id, at] of this.recent) if (now - at > 60_000) this.recent.delete(id);
    if (this.recent.has(key)) return;
    if (this.queued >= 32) {
      console.warn("[codexManager] push notification queue full");
      return;
    }
    this.recent.set(key, now);
    if (notice.notificationId && notice.actions?.length) {
      this.actions.set(notice.notificationId, notice.actions.slice(0, 2));
      if (this.actions.size > 64) this.actions.delete(this.actions.keys().next().value!);
    }
    this.queued++;
    const work = this.sends
      .catch(() => undefined)
      .then(async () => {
        await this.mutations.catch(() => undefined);
        const state = await this.read();
        const password = await this.password();
        const expired = new Set<string>();
        const payload = JSON.stringify({
          title: "Codex Manager",
          body: notice.message.slice(0, 900),
          tag: `codex-manager-${key.slice(0, 150)}`,
          notificationId: notice.notificationId,
          actions: notice.actions?.slice(0, 2),
          url: "/dash",
          createdAt: now
        });
        await Promise.all(state.subscriptions.slice(0, MAX_SUBSCRIPTIONS).map(async subscription => {
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
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) expired.add(subscription.endpoint);
            else console.warn("[codexManager] push delivery failed", status ?? "network unavailable");
          }
        }));
        if (expired.size)
          await this.mutate((current) => {
            current.subscriptions = current.subscriptions.filter((item) => !expired.has(item.endpoint));
          });
      })
      .catch(() => {
        console.warn("[codexManager] push notification storage unavailable");
      })
      .finally(() => {
        this.queued--;
      });
    this.sends = work;
  }

  flush(): Promise<void> { return this.sends; }

  async isSubscribed(endpoint: string, owner: string, origin: string): Promise<boolean> {
    await this.mutations.catch(() => undefined);
    const state = await this.read(), password = await this.password();
    return state.subscriptions.some(item => item.endpoint === endpoint && item.owner === owner && item.origin === origin &&
      item.expiresAt > Date.now() && (item.password === undefined || item.password === password));
  }
}
