import { createECDH, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("web-push", async (original) => {
  const module = await original<typeof import("web-push")>();
  const api = (module as any).default ?? module;
  return { default: { generateVAPIDKeys: api.generateVAPIDKeys.bind(api), sendNotification: send } };
});
import { BrowserPushService, validateBrowserPushSubscription } from "../src/services/browserPush";

const subscription = (name = "one") => {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
    keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") }
  };
};
let stored: Map<string, string>;
let service: BrowserPushService;
let password: string;
const settle = async () => {
  await (service as unknown as { sends: Promise<void> }).sends;
};
beforeEach(() => {
  stored = new Map();
  password = "shared-password";
  send.mockReset().mockResolvedValue({ statusCode: 201 });
  service = new BrowserPushService(
    {
      get: async (key: string) => stored.get(key),
      store: async (key: string, value: string) => {
        stored.set(key, value);
      }
    } as never,
    async () => password
  );
});
afterEach(() => vi.restoreAllMocks());

describe("persistent browser push", () => {
  it("reports actual provider acceptance and removes rejected subscriptions from a test send", async () => {
    await service.subscribe(subscription(), "phone", "https://dashboard.example", password);
    await service.subscribe(subscription("expired"), "other", "https://dashboard.example", password);
    send.mockResolvedValueOnce({ statusCode: 201 }).mockRejectedValueOnce({ statusCode: 410 });
    expect(await service.sendTest()).toEqual({ subscriptions: 2, accepted: 1, failed: 1 });
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Test notification:"), expect.objectContaining({ TTL: 120, timeout: 8000, urgency: "high" }));
    send.mockClear();
    expect(await service.sendTest()).toEqual({ subscriptions: 1, accepted: 1, failed: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0][1]).url).toBe("/");
  });
  it("does not claim delivery with no subscribers, a changed password, or a provider failure", async () => {
    expect(await service.sendTest()).toEqual({ subscriptions: 0, accepted: 0, failed: 0 });
    const phone = subscription();
    await service.subscribe(phone, "phone", "https://dashboard.example", password);
    password = "rotated";
    expect(await service.sendTest()).toEqual({ subscriptions: 0, accepted: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    await service.subscribe(phone, "phone", "https://dashboard.example", password);
    send.mockRejectedValueOnce(new Error("Provider timeout"));
    expect(await service.sendTest()).toEqual({ subscriptions: 1, accepted: 0, failed: 1 });
    expect(await service.sendTest()).toEqual({ subscriptions: 1, accepted: 1, failed: 0 });
  });
  it("coalesces repeated test requests and exposes them to reload delivery flushing", async () => {
    await service.subscribe(subscription(), "phone", "https://dashboard.example", password);
    let finish: (() => void) | undefined;
    send.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = service.sendTest(); expect(service.sendTest()).toBe(first);
    await vi.waitFor(() => expect(finish).toBeDefined());
    let flushed = false; void service.flush().then(() => { flushed = true; });
    expect(flushed).toBe(false); finish!();
    expect(await first).toEqual({ subscriptions: 1, accepted: 1, failed: 0 });
    await service.flush(); expect(flushed).toBe(true); expect(send).toHaveBeenCalledOnce();
  });
  it("surfaces storage and full-queue failures without leaving test delivery stuck", async () => {
    stored.set("codexManager.browserPush.v1", "corrupt");
    await expect(service.sendTest()).rejects.toThrow();
    stored.clear(); await service.subscribe(subscription(), "phone", "https://dashboard.example", password);
    (service as unknown as { queued: number }).queued = 32;
    await expect(service.sendTest()).rejects.toThrow("busy");
    (service as unknown as { queued: number }).queued = 0;
    expect(await service.sendTest()).toEqual({ subscriptions: 1, accepted: 1, failed: 0 });
  });
  it("checks the registered owner and detects logout or changed-password subscriptions", async () => {
    const item = subscription(); await service.subscribe(item, "owner", "https://dashboard.example", password);
    expect(await service.isSubscribed(item.endpoint, "owner", "https://dashboard.example")).toBe(true);
    expect(await service.isSubscribed(item.endpoint, "other", "https://dashboard.example")).toBe(false);
    password = "changed";
    expect(await service.isSubscribed(item.endpoint, "owner", "https://dashboard.example")).toBe(false);
    await service.revokeOwner("owner");
    expect(await service.isSubscribed(item.endpoint, "owner", "https://dashboard.example")).toBe(false);
  });
  it("sends a major reload to all subscribed devices in parallel and exposes a completion barrier", async () => {
    await service.subscribe(subscription(), "one", "https://dashboard.example", password);
    await service.subscribe(subscription("two"), "two", "https://dashboard.example", password);
    const finish: Array<() => void> = [];
    send.mockImplementation(() => new Promise<void>(resolve => finish.push(resolve)));
    service.notify({ level: "info", message: "Reloading Codex Manager" });
    let drained = false;
    void service.flush().then(() => { drained = true; });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(drained).toBe(false);
    finish.forEach(resolve => resolve());
    await service.flush();
    expect(drained).toBe(true);
  });
  it("uses a session title as the browser push title", async () => {
    await service.subscribe(subscription(), "phone", "https://dashboard.example", password);
    service.notify({ level: "info", title: "Fix SMS end to end", message: "Session completed. Open the dashboard to review the turn." });
    await settle();
    const payload = JSON.parse(send.mock.calls[0]![1]);
    expect(payload.title).toBe("Fix SMS end to end");
    expect(payload.body).toContain("Session completed");
  });
  it("uses the first recovered title for an auto-resume push", async () => {
    await service.subscribe(subscription(), "phone", "https://dashboard.example", password);
    service.notify({ level: "info", message: "Auto resume reopened 1 running VS Code Codex session: “Fix SMS end to end”." });
    await settle();
    expect(JSON.parse(send.mock.calls[0]![1]).title).toBe("Fix SMS end to end");
  });
  it("rejects arbitrary endpoints, private hosts, credentials, and malformed keys", () => {
    const valid = subscription();
    for (const endpoint of [
      "http://fcm.googleapis.com/path",
      "https://127.0.0.1/path",
      "https://fcm.googleapis.com.evil.example/path",
      "https://user:pass@fcm.googleapis.com/path",
      "https://fcm.googleapis.com:8443/path"
    ]) {
      expect(() => validateBrowserPushSubscription({ ...valid, endpoint })).toThrow();
    }
    expect(() => validateBrowserPushSubscription({ ...valid, keys: { ...valid.keys, auth: "bad" } })).toThrow();
    expect(validateBrowserPushSubscription(valid)).toEqual(valid);
  });

  it("persists one VAPID key across concurrent subscriptions and host restarts", async () => {
    const keys = await Promise.all([service.publicKey(), service.publicKey()]);
    expect(keys[0]).toBe(keys[1]);
    await Promise.all([
      service.subscribe(subscription(), "device1", "https://dashboard.example", password),
      service.subscribe(subscription("two"), "device2", "https://dashboard.example", password)
    ]);
    const second = new BrowserPushService(
      {
        get: async (key: string) => stored.get(key),
        store: async (key: string, value: string) => {
          stored.set(key, value);
        }
      } as never,
      async () => password
    );
    expect(await second.publicKey()).toBe(keys[0]);
    service.notify({ level: "warning", message: "Quota is low" });
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ timeout: 8000, TTL: 300 })
    );
  });

  it("deduplicates major events, excludes routine notices, and validates single-use actions", async () => {
    await service.subscribe(subscription(), "device", "https://dashboard.example", password);
    service.notify({ level: "info", message: "Quotas refreshed" });
    service.notify({
      level: "warning",
      message: "Switch account?",
      notificationId: "prompt",
      actions: ["Switch", "Cancel"]
    });
    service.notify({
      level: "warning",
      message: "Switch account?",
      notificationId: "prompt",
      actions: ["Switch", "Cancel"]
    });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(service.takeAction("prompt", "Delete")).toBe(false);
    expect(service.takeAction("prompt", "Switch")).toBe(true);
    expect(service.takeAction("prompt", "Switch")).toBe(false);
    service.dismiss("prompt");
  });

  it("removes expired endpoints, revokes logout/password changes, and keeps network failures retryable", async () => {
    const first = subscription();
    await service.subscribe(first, "device", "https://dashboard.example", password);
    send.mockRejectedValueOnce({ statusCode: 410 });
    service.notify({ level: "error", message: "Failed once" });
    await settle();
    service.notify({ level: "error", message: "Failed twice" });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    await service.subscribe(first, "device", "https://dashboard.example", password);
    password = "rotated";
    service.notify({ level: "error", message: "Password changed" });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    await service.subscribe(first, "device", "https://dashboard.example", password);
    await service.revokeOwner("device");
    service.notify({ level: "error", message: "Logged out" });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    await service.subscribe(first, "device", "https://dashboard.example", password);
    send.mockRejectedValueOnce(new Error("offline"));
    service.notify({ level: "error", message: "Offline" });
    await settle();
    service.notify({ level: "info", message: "Switched to the next account" });
    await settle();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("renews the same device after login expiry and reports storage and capacity failures", async () => {
    const first = subscription();
    await service.subscribe(first, "login1", "https://dashboard.example", password);
    await service.subscribe(first, "login2", "https://dashboard.example", password);
    await service.revokeOwner("login1");
    service.notify({ level: "warning", message: "Still subscribed" });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    const raw = JSON.parse(stored.get("codexManager.browserPush.v1")!);
    raw.subscriptions = Array.from({ length: 64 }, (_, index) => ({
      ...first,
      endpoint: `${first.endpoint}/${index}`,
      owner: "device",
      origin: "https://dashboard.example",
      expiresAt: Date.now() + 10000
    }));
    stored.set("codexManager.browserPush.v1", JSON.stringify(raw));
    await expect(service.subscribe(subscription("full"), "device", "https://dashboard.example")).rejects.toThrow(
      "devices"
    );
    stored.set("codexManager.browserPush.v1", "partial");
    await expect(service.publicKey()).rejects.toThrow();
  });
});
