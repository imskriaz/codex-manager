import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import os from "node:os";
import { readdir } from "node:fs/promises";

// Real local host, real WebSocket, real sessions. No mocked application responses.
const origin = process.env.CODEX_MANAGER_UI_URL || "http://127.0.0.1:39875";
const output = path.join(tmpdir(), "codex-manager-live-ui");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
const childIdsFromDisk = new Set();
try {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const names = (await readdir(home)).filter(name => /^state_[0-9]+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/[0-9]+/)[0]) - Number(a.match(/[0-9]+/)[0]));
  if (names[0]) {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(home, names[0]), { readOnly: true });
    try {
      for (const row of database.prepare("SELECT id, source FROM threads ORDER BY updated_at DESC LIMIT 2000").all()) {
        if (/sub[_-]?agent/i.test(String(row.source))) childIdsFromDisk.add(row.id);
      }
    } finally { database.close(); }
  }
} catch (error) { console.log(`Optional child metadata check unavailable: ${error.message}`); }
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, serviceWorkers: "block" });
    const page = await context.newPage();
    if (process.argv.includes("--workspace-assets")) {
      for (const [asset, file, contentType] of [["browserHost.js", "media/webview/browserHost.js", "text/javascript"], ["dashboard.js", "media/webview/dashboard/dashboard.js", "text/javascript"], ["dashboard.css", "media/webview/quotaSummary.css", "text/css"]]) {
        await page.route(`**/assets/${asset}*`, route => route.fulfill({ contentType, path: path.resolve(file) }));
      }
    }
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__liveEvents = [];
      window.addEventListener("message", event => {
        const message = event.data;
        if (message?.type?.startsWith("dashboard:")) window.__liveEvents.push(message);
      });
    });
    const start = Date.now();
    await page.goto(`${origin}/dash`);
    await page.locator("#settingsOpenButton").waitFor();
    await page.waitForFunction(() => window.__liveEvents.some(event => event.type === "dashboard:connection" && event.connected));
    const loadMs = Date.now() - start;
    console.log(`${width}px: real host connected in ${loadMs}ms`);
    await page.locator("#settingsOpenButton").click();
    for (const tab of await page.locator(".settings-tab").all()) await tab.click();
    await page.keyboard.press("Escape");
    await page.goto(`${origin}/workspace`);
    await page.locator(".cli-workspace").waitFor();
    if (width === 390) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.waitForFunction(() => window.__liveEvents.some(event => event.type === "dashboard:action-result" && event.action === "listCodexCliSessions" && event.status === "completed"));
    const sessionResult = await page.evaluate(() => window.__liveEvents.filter(event => event.type === "dashboard:action-result" && event.action === "listCodexCliSessions").at(-1));
    const sessions = sessionResult.payload?.cliSessions || [];
    for (const session of sessions.filter(session => !session.remote && childIdsFromDisk.has(session.id))) {
      assert.ok(session.subAgent || session.parentSessionId, "Real child metadata must be present before list rendering");
    }
    const childIds = sessions.filter(session => session.subAgent || session.parentSessionId).map(session => session.id);

    assert.equal(await page.locator(".cli-session-row-select").count(), 0, "Real projects start collapsed");
    if (sessions.some(session => !session.archived && !session.subAgent && !session.parentSessionId)) await page.locator(".cli-project-collapse").first().waitFor();
    for (const expand of await page.locator(".cli-project-collapse").all()) await expand.click();
    if (sessions.some(session => !session.archived && !session.subAgent && !session.parentSessionId)) await page.locator(".cli-session-row-select").first().waitFor();
    assert.equal(await page.locator(".cli-session-row-select").count(), new Set(sessions.filter(session => !session.archived && !session.subAgent && !session.parentSessionId).map(session => `${session.deviceId || "local"}:${session.id}`)).size, "Real list contains parents only");
    const row = page.locator(".cli-session-row-select").first();
    let messages = 0;
    if (await row.count()) {
      await row.click();
      await page.waitForFunction(() => window.__liveEvents.some(event => event.type === "dashboard:action-result" && event.action === "getCodexCliSessionMessages" && event.status === "completed"));
      messages = await page.locator(".cli-conversation .cli-session-message").count();
    }
    assert.equal(await page.locator(".cli-workspace-feedback.is-error").count(), 0, "Opening real chat must not fail automatic workspace inspection");
    await page.screenshot({ path: path.join(output, `workspace-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), "Real UI fits viewport");
    if (width === 1440 && process.argv.includes("--create-session")) {
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await page.getByRole("textbox", { name: "Message Codex", exact: true }).fill("Reply exactly UI smoke test OK. Do not run tools or modify any files.");
      const startedAt = Date.now();
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.waitForFunction(() => window.__liveEvents.some(event => event.type === "dashboard:action-result" && event.action === "startCodexCliSession"), null, { timeout: 95_000 });
      const created = await page.evaluate(() => window.__liveEvents.filter(event => event.type === "dashboard:action-result" && event.action === "startCodexCliSession").at(-1));
      assert.equal(created.status, "completed", created.error || "Real new-session creation must complete");
      assert.ok(created.payload?.cliSession?.id, "Created chat has a session ID");
      await page.locator(".cli-conversation .cli-session-message.is-assistant").filter({ hasText: "UI smoke test OK" }).waitFor({ timeout: 95_000 });
      console.log("Real new chat and first response completed in " + (Date.now() - startedAt) + "ms.");
    }
    // Disconnect this test browser only, then require the real transport to recover.
    await context.setOffline(true);
    await page.waitForFunction(() => window.__liveEvents.filter(event => event.type === "dashboard:connection").at(-1)?.connected === false, null, { timeout: 45_000 });
    await context.setOffline(false);
    await page.waitForFunction(() => window.__liveEvents.filter(event => event.type === "dashboard:connection").at(-1)?.connected === true, null, { timeout: 30_000 });
    assert.deepEqual(errors, [], "Real browser runtime errors");
    results.push({ width, loadMs, sessions: sessions.length, children: childIds.length, messages, reconnect: "passed" });
    await context.close();
  }
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ results, screenshots: output }, null, 2));
} finally {
  await browser.close();
}
