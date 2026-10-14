import assert from "node:assert/strict";
import { chromium } from "playwright";

// Read-only actions on the canonical host; never retry a submitted mutation.
const origin = "http://127.0.0.1:39875";
const browser = await chromium.launch({ channel: process.env.CODEX_MANAGER_BROWSER || "msedge", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [], sockets = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("websocket", socket => sockets.push(socket.url()));
  await page.addInitScript(() => {
    window.__socketCheck = [];
    window.addEventListener("message", event => {
      if (event.data?.type?.startsWith("dashboard:")) window.__socketCheck.push(event.data);
    });
  });
  await page.goto(`${origin}/dash`);
  const waitLive = () => page.waitForFunction(() => window.__socketCheck.some(message => message.type === "dashboard:connection" && message.connected), null, { timeout: 20000 });
  await waitLive();
  const readSessions = async label => {
    const requestId = `socket-read-${label}-${Date.now()}`;
    await page.evaluate(requestId => window.acquireVsCodeApi().postMessage({ type: "dashboard:action", action: "listCodexCliSessions", requestId }), requestId);
    await page.waitForFunction(requestId => window.__socketCheck.some(message => message.requestId === requestId && message.type === "dashboard:action-result"), requestId, { timeout: 30000 });
    const result = await page.evaluate(requestId => window.__socketCheck.find(message => message.requestId === requestId && message.type === "dashboard:action-result"), requestId);
    assert.equal(result.status, "completed", result.error);
    const sessions = result.payload?.cliSessions;
    assert.ok(Array.isArray(sessions), "Socket returns the session catalog");
    return sessions.filter(session => !session.parentSessionId && !session.archived && session.status === "running").length;
  };
  const initialRunning = await readSessions("initial");
  await page.evaluate(() => { window.__socketCheck = []; });
  await context.setOffline(true);
  await page.waitForFunction(() => window.__socketCheck.some(message => message.type === "dashboard:host-status" && message.stage === "offline"));
  await context.setOffline(false);
  await waitLive();
  const recoveredRunning = await readSessions("network-recovery");
  const beforeRetry = sockets.length;
  await page.evaluate(() => { window.__socketCheck = []; return window.acquireVsCodeApi().postMessage({ type: "dashboard:retry-connection" }); });
  await waitLive();
  assert.ok(sockets.length > beforeRetry, "Manual retry replaces an already-open socket");
  await page.waitForFunction(() => window.__socketCheck.some(message => message.type === "dashboard:notice"));
  const retryRunning = await readSessions("manual-retry");
  assert.ok(sockets.every(url => url === "ws://127.0.0.1:39875/ws"));
  assert.deepEqual(errors, [], "Browser runtime errors");
  const csp = await fetch(`${origin}/dash`).then(response => response.headers.get("content-security-policy"));
  assert.ok(csp.includes("ws://127.0.0.1:39875"), "Installed host explicitly permits WebSocket traffic");
  console.log(JSON.stringify({ connected: true, sockets: sockets.length, initialRunning, recoveredRunning, retryRunning, browserErrors: errors.length }));
} finally { await browser.close(); }
