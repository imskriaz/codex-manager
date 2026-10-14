import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

// Read-only local UI surface; notification providers and all mutations are fixtures.
const origin = process.env.CODEX_MANAGER_UI_URL || "http://127.0.0.1:39875";
const response = await fetch(`${origin}/api/state`);
assert.ok(response.ok);
const state = await response.json();
const host = `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(m){setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:m.type==='dashboard:ready'?{type:'dashboard:snapshot',state:${JSON.stringify(state)}}:{type:'dashboard:action-result',requestId:m.requestId,action:m.action,status:'completed',payload:{cliSessions:[]}}})),0)}});`;
const screenshots = path.join(tmpdir(), "codex-manager-ui-check");
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ channel: process.env.CODEX_MANAGER_BROWSER || "msedge", headless: true });
try {
  for (const scenario of ["subscribe", "registered", "revoked", "denied", "cancelled", "storage-failure", "timeout"]) {
    console.log(`Checking browser notification ${scenario}`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    await context.addInitScript(({ scenario }) => {
      window.__permissionRequests = 0; window.__unsubscribes = 0;
      const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/fixture", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/fixture", keys: { p256dh: "fixture", auth: "fixture" } }), unsubscribe: async () => { window.__unsubscribes++; return true; } };
      let current = ["registered", "revoked"].includes(scenario) ? subscription : null;
      const registration = { pushManager: { getSubscription: async () => current, subscribe: async () => { current = subscription; return subscription; } } };
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve(registration) } });
      window.PushManager = function() {};
      Object.defineProperty(window, "Notification", { configurable: true, value: { permission: "default", requestPermission: () => {
        window.__permissionRequests++;
        return scenario === "timeout" ? new Promise(() => {}) : Promise.resolve(scenario === "denied" ? "denied" : scenario === "cancelled" ? "default" : "granted");
      } } });
      const setTimeout = window.setTimeout.bind(window);
      if (scenario === "timeout") window.setTimeout = (fn, ms, ...args) => setTimeout(fn, ms === 15000 ? 200 : ms, ...args);
    }, { scenario });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const calls = [], errors = [];
    let registered = scenario === "registered";
    let windowlessTestResult = { subscriptions: 1, accepted: 1, failed: 0 };
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      calls.push(pathname);
      if (pathname === "/api/push/test") return route.fulfill({ json: windowlessTestResult });
      if (pathname === "/api/push/key") return route.fulfill({ json: { publicKey: Buffer.alloc(65, 1).toString("base64url") } });
      if (pathname === "/api/push/status") return route.fulfill({ json: { subscribed: registered } });
      if (pathname === "/api/push/subscribe") { registered = scenario !== "storage-failure"; return route.fulfill({ status: scenario === "storage-failure" ? 500 : 200, json: scenario === "storage-failure" ? { error: "Notification storage failed. Retry when storage recovers." } : { ok: true } }); }
      return route.fulfill({ json: { ok: true } });
    });
    await page.route("**/assets/browserHost.js*", route => route.fulfill({ contentType: "text/javascript", body: host }));
    for (const [asset, file, contentType] of [["dashboard.js", "media/webview/dashboard/dashboard.js", "text/javascript"], ["dashboard.css", "media/webview/quotaSummary.css", "text/css"], ["shared.css", "media/webview/shared.css", "text/css"]])
      await page.route(`**/assets/${asset}*`, route => route.fulfill({ contentType, path: path.resolve(file) }));
    console.log(`${scenario}: opening dashboard`);
    await page.goto(`${origin}/dash`);
    console.log(`${scenario}: dashboard loaded`);
    await page.locator(".dashboard-mobile-actions").waitFor();
    console.log(`${scenario}: dashboard ready`);
    const offer = page.getByRole("region", { name: "Notification subscription", exact: true });
    if (scenario === "registered") {
      await page.waitForTimeout(300);
      assert.equal(await offer.count(), 0, "Registered devices are not prompted again");
    } else {
      await offer.waitFor().catch(async error => { console.log("Offer state", calls, await page.locator("body").textContent(), errors); throw error; });
      console.log(`${scenario}: offer visible`);
      const card = await offer.boundingBox();
      assert.ok(card.x >= 0 && card.y >= 0 && card.x + card.width <= 390 && card.y + card.height <= 844, "Notification card fits mobile");
      assert.ok(card.height <= 190, "Initial notification card is compact");
      const enableButton = offer.getByRole("button", { name: "Subscribe to browser notifications", exact: true });
      const buttonBounds = await enableButton.boundingBox();
      assert.ok(buttonBounds.width >= 120 && buttonBounds.height >= 40, "Enable is a full text button with a touch target");
      assert.ok(await enableButton.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "Button text is not clipped");
      if (scenario === "subscribe") await page.screenshot({ path: path.join(screenshots, "notification-offer-mobile.png") });
      if (scenario === "subscribe") {
        for (const [width, height] of [[320, 667], [844, 390], [1440, 1000]]) {
          await page.setViewportSize({ width, height });
          const bounds = await offer.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height, `Notification offer fits ${width}x${height}`);
          assert.ok(await enableButton.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "Notification action text fits");
          await page.screenshot({ path: path.join(screenshots, `notification-offer-${width}x${height}.png`) });
        }
        await page.setViewportSize({ width: 390, height: 844 });
      }
      assert.equal(await page.evaluate(() => window.__permissionRequests), 0, "Permission requires an explicit gesture");
      await offer.getByRole("button", { name: "Subscribe to browser notifications", exact: true }).click();
      console.log(`${scenario}: subscribe clicked`);
      if (["subscribe", "revoked"].includes(scenario)) {
        await offer.getByRole("status").filter({ hasText: "Subscribed on this device" }).waitFor().catch(async error => { console.log("Subscription state", calls, await offer.textContent(), errors); throw error; });
        console.log(`${scenario}: subscribed`);
        assert.equal(calls.filter(path => path === "/api/push/subscribe").length, 1);
        await offer.getByRole("button", { name: "Done", exact: true }).click();
        await page.locator(".dashboard-mobile-actions > summary").click();
        await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: "Disable notifications", exact: true }).waitFor();
        const testButton = page.getByRole("button", { name: "Send test notification", exact: true });
        await testButton.click();
        await page.getByRole("status").filter({ hasText: "Push service accepted the test for 1 device" }).waitFor();
        assert.equal(calls.filter(path => path === "/api/push/test").length, 1);
        windowlessTestResult = { subscriptions: 1, accepted: 0, failed: 1 };
        await testButton.click();
        await page.getByRole("alert").filter({ hasText: "1 failed" }).waitFor();
        windowlessTestResult = { subscriptions: 0, accepted: 0, failed: 0 };
        await testButton.click();
        await page.getByRole("alert").filter({ hasText: "No subscribed devices were found" }).waitFor();
        assert.equal(await testButton.isEnabled(), true);
        if (scenario === "subscribe") await page.screenshot({ path: path.join(screenshots, "notification-settings-mobile.png") });
      } else {
        await offer.getByRole("alert").waitFor();
        assert.equal(await offer.getByRole("button", { name: "Subscribe to browser notifications", exact: true }).isEnabled(), true, "Failures leave a retryable terminal state");
        assert.equal(await page.evaluate(() => window.__unsubscribes), scenario === "storage-failure" ? 1 : 0, "Failed persistence rolls back a new browser subscription");
      }
    }
    assert.deepEqual(errors, [], `${scenario} has no console errors`);
    console.log(`Browser notification ${scenario}: passed`);
    await context.close();
  }
} finally { await browser.close(); }
