import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

// Sends a real turn only when explicitly requested. Choose a stopped test conversation.
const sessionId = process.argv.find(argument => argument.startsWith("--session="))?.slice(10);
assert.match(sessionId ?? "", /^[a-z0-9-]{20,64}$/i, "Pass --session=<stopped-session-id>");
const sendContinue = process.argv.includes("--send-continue");
const origin = "http://127.0.0.1:39875";
const output = path.join(tmpdir(), "codex-manager-continue-ui");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const result = { sessionId, sent: false, started: false, completed: false };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(30_000);
  for (const [asset, file, contentType] of [["browserHost.js", "media/webview/browserHost.js", "text/javascript"], ["dashboard.js", "media/webview/dashboard/dashboard.js", "text/javascript"], ["dashboard.css", "media/webview/quotaSummary.css", "text/css"]]) {
    await page.route(`**/assets/${asset}*`, route => route.fulfill({ contentType, path: path.resolve(file) }));
  }
  await page.addInitScript(() => {
    window.__continueEvents = [];
    window.addEventListener("message", event => {
      if (event.data?.type?.startsWith("dashboard:")) window.__continueEvents.push(event.data);
    });
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${origin}/workspace/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(id => window.__continueEvents.some(event => event.type === "dashboard:action-result" && event.action === "getCodexCliSessionMessages" && event.payload?.cliSession?.id === id), sessionId);
    result.opened = await page.evaluate(id => window.__continueEvents.find(event => event.action === "getCodexCliSessionMessages" && event.payload?.cliSession?.id === id)?.payload?.cliSession, sessionId);
    console.log(JSON.stringify({ opened: result.opened }));
    assert.ok(result.opened && result.opened.status !== "running" && !result.opened.locked, "Choose a session without an active writer");
    const composer = page.getByRole("textbox", { name: "Message Codex", exact: true });
    await composer.waitFor();
    if (sendContinue) {
      await page.getByRole("button", { name: "Message settings", exact: true }).click();
      await page.getByRole("combobox", { name: "Access mode", exact: true }).selectOption("read-only");
      await page.keyboard.press("Escape");
      await composer.fill("continue");
      const startedAt = Date.now();
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      result.sent = true;
      await page.waitForFunction(id => window.__continueEvents.some(event => event.type === "dashboard:codex-session-live" && event.state?.sessionId === id && event.state?.status === "running") || window.__continueEvents.some(event => event.type === "dashboard:action-result" && event.action === "sendCodexCliSessionMessage" && event.status === "failed"), sessionId, { timeout: 45_000 });
      const failure = await page.evaluate(() => window.__continueEvents.find(event => event.type === "dashboard:action-result" && event.action === "sendCodexCliSessionMessage" && event.status === "failed"));
      assert.ok(!failure, failure?.error);
      result.started = true;
      result.startedMs = Date.now() - startedAt;
      await page.screenshot({ path: path.join(output, "running.png") });
      if (process.argv.includes("--stop-after-start")) await page.getByRole("button", { name: "Stop", exact: true }).click();
      await page.waitForFunction(() => window.__continueEvents.some(event => event.type === "dashboard:action-result" && event.action === "sendCodexCliSessionMessage"), null, { timeout: 120_000 });
      const action = await page.evaluate(() => window.__continueEvents.find(event => event.type === "dashboard:action-result" && event.action === "sendCodexCliSessionMessage"));
      assert.ok(action.status === "completed" || (process.argv.includes("--stop-after-start") && action.status === "cancelled"), action.error || "The continued turn must finish");
      result.completed = action.status === "completed";
      result.stopped = action.status === "cancelled";
      result.completedMs = Date.now() - startedAt;
    }
    assert.deepEqual(errors, [], "Browser runtime errors");
    await page.screenshot({ path: path.join(output, "result.png") });
  } catch (error) {
    result.error = error.message;
    result.feedback = await page.locator('.cli-workspace-feedback, .cli-composer-unavailable').allTextContents();
    await page.screenshot({ path: path.join(output, "failure.png") });
    throw error;
  } finally {
    await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await browser.close();
}
