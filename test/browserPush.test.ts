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
      "full"
    );
    stored.set("codexManager.browserPush.v1", "partial");
    await expect(service.publicKey()).rejects.toThrow();
  });
});
