import { afterEach, expect, it, vi } from "vitest";
import { request } from "../webview-src/dashboard/teamManagementPage";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("bounds a save and reports an unconfirmed outcome without replaying it", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const fetch = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  vi.stubGlobal("fetch", fetch);
  const result = request("/api/office/users/u1", "PATCH", { enabled: false });
  const outcome = expect(result).rejects.toThrow("Refresh before retrying to avoid duplicate changes.");
  await vi.advanceTimersByTimeAsync(15_000);
  await outcome;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves a server conflict instead of treating it as success", async () => {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "User changed in another window." }), { status: 409 })));
  await expect(request("/api/office/users/u1", "PATCH", { enabled: false })).rejects.toThrow("User changed in another window.");
});
