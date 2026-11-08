import assert from "node:assert/strict";
import { chromium } from "playwright";
import { useWorkspaceDashboardAssets } from "./workspace-dashboard-assets.mjs";

const origin = "http://127.0.0.1:39875";
const snapshot = await (await fetch(`${origin}/api/state`)).json();
snapshot.connectedPeers = [{ id: "remote-a", name: "Other PC", local: false, connected: true, sessionCount: 0 }];
snapshot.accounts = []; snapshot.peerAccounts = {};
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const width of [1440, 390]) {
    for (const device of [undefined, "remote-b"]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
      try {
        const page = await context.newPage();
        await useWorkspaceDashboardAssets(page, origin);
        await page.route("**/api/state*", route => route.fulfill({ json: snapshot }));
        await page.route("**/api/message", route => route.fulfill({ json: { messages: [] } }));
        await page.addInitScript(state => {
          window.__deviceActions = [];
          const sockets = new Set();
          window.WebSocket = class extends EventTarget {
            static OPEN = 1; readyState = 0; bufferedAmount = 0;
            constructor() {
              super(); sockets.add(this);
              setTimeout(() => {
                this.readyState = 1; this.dispatchEvent(new Event("open"));
                this.receive({ type: "dashboard:snapshot", state });
              }, 0);
            }
            receive(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
            send(raw) {
              const message = JSON.parse(raw);
              window.__deviceActions.push(message);
              if (message.type === "dashboard:action") queueMicrotask(() => this.receive({ type: "dashboard:action-result", requestId: message.requestId, action: message.action, status: "completed", payload: { cliSessions: [] } }));
            }
            close() { this.readyState = 3; sockets.delete(this); }
          };
          window.__deviceSnapshot = peers => {
            state.connectedPeers = peers;
            for (const socket of sockets) socket.receive({ type: "dashboard:snapshot", state });
          };
        }, snapshot);
        await page.goto(`${origin}/workspace${device ? `?device=${device}` : ""}`);
        await page.waitForSelector(".cli-workspace");
        await page.waitForTimeout(400);
        assert.equal(new URL(page.url()).searchParams.get("device"), device ?? null, "remote-only discovery must retain the intended system");
        await page.evaluate(() => window.__deviceSnapshot([
          { id: "native-local", name: "This PC", local: true, connected: true, sessionCount: 0 },
          { id: "remote-a", name: "Other PC", local: false, connected: true, sessionCount: 0 }
        ]));
        await page.waitForTimeout(400);
        assert.equal(new URL(page.url()).searchParams.get("device"), device ?? null, "local host returning must not change an explicitly selected remote system");
        assert.equal(await page.evaluate(() => window.__deviceActions.some(message => message.type === "dashboard:action" && message.payload?.targetDeviceId === "remote-a")), false, "actions must never be redirected to the first available PC");
      } finally { await context.close(); }
    }
  }
  console.log("Device selection retained at 1440px and 390px through remote-only discovery and local host return; no action reached the wrong PC.");
} finally { await browser.close(); }
