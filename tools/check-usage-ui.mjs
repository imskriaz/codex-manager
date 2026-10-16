import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

// Read the local shell and metadata only; intercept every action in this browser.
const origin = "http://127.0.0.1:39875";
const response = await fetch(`${origin}/api/state`);
assert.ok(response.ok, "The read-only local dashboard must be available");
const snapshot = await response.json();
assert.ok(snapshot.accounts[0], "The smoke check needs one saved account as a rendering fixture");
snapshot.onboardingCompleted = true;
snapshot.settings = { ...snapshot.settings, privacyMode: false, dailyTokenUsageEnabled: false, cliIntegrationEnabled: false };
snapshot.accounts = ["a", "b"].map((id, index) => ({ ...snapshot.accounts[0], id, email: `${id}@example.invalid`, displayName: id,
  accountName: "Usage fixture", runningDeviceName: undefined, isActive: index === 0, isCurrentWindowAccount: index === 0, switchQueued: false }));
snapshot.usageSummary = { revision: 1, count: 4 };
delete snapshot.usageHistory;
delete snapshot.dailyUsageCache;
const mockHost = `(() => {
  let state = ${JSON.stringify(snapshot)};
  const day = 86400000;
  const date = new Date(Date.now() - day).toISOString().slice(0,10);
  const dispatch = data => window.dispatchEvent(new MessageEvent('message', {data}));
  window.__usageActions = []; window.__deferredUsage = []; window.__dailyResults = []; window.__dailyActive = 0; window.__dailyMax = 0;
  window.__addUsageAccounts = () => { state = {...state, accounts:[...state.accounts, ...["c","d","e","f","g","h"].map(id => ({...state.accounts[1],id,email:id+"@example.invalid"}))]}; dispatch({type:"dashboard:snapshot",state}); };
  window.__releaseDaily = () => { window.__holdDaily = false; for (const result of window.__dailyResults.splice(0)) { window.__dailyActive--; dispatch(result); } };
  window.__finishUsage = () => { for (const result of window.__deferredUsage.splice(0).reverse()) dispatch(result); };
  window.acquireVsCodeApi = () => ({ postMessage(message) {
    window.__usageActions.push(message);
    if (message.action === "getDailyUsage" && window.__holdDaily) { window.__dailyActive++; window.__dailyMax = Math.max(window.__dailyMax,window.__dailyActive); }
    setTimeout(() => {
      if (message.type === 'dashboard:ready') { dispatch({type:'dashboard:snapshot',state}); return; }
      if (message.type === 'dashboard:setting') {
        state.settings[message.key] = message.value; dispatch({type:'dashboard:snapshot',state}); return;
      }
      if (message.type !== 'dashboard:action') return;
      let payload = {}, error;
      if (message.action === 'getUsageGraph') {
        const query = message.payload.usageGraph;
        const tokens = query.to - query.from <= 7 * day ? 700 : 100;
        payload.usageGraph = {...query, truncated:false, oldestAt:query.from - day,
          history: query.mode === 'quota' ? state.accounts.flatMap(account => [
            {accountId:account.id,at:query.from + 60000,hourly:90},
            {accountId:account.id,at:query.to - 60000,hourly:80}]) : [],
          dailyUsageCache: query.mode === 'tokens' ? state.accounts.map((account,index) => ({accountId:account.id,
            fetchedAt:Date.now() - (index ? 60000 : 2 * day),usage:{days:30,points:window.__emptyUsage ? [] : window.__richUsage ? Array.from({length:30},(_,i) => ({date:new Date(query.to-(30-i)*day).toISOString().slice(0,10),totalTokens:window.__zeroUsage ? 0 : (1+(i*7)%11)*1234*(index+1),surfaceValues:window.__zeroUsage ? {} : {cli:1000,vscode:234}})) : [{date,totalTokens:tokens * (index + 1)}]}})) : []};
        if (window.__failUsage) { window.__failUsage = false; error = 'Saved graph database is temporarily unavailable.'; }
      } else if (message.action === 'getDailyUsage') {
        payload = {dailyUsage:{days:30,points:[{date,totalTokens:100}]},dailyUsageFetchedAt:Date.now()};
        if (window.__failDaily === message.accountId) error = "Token endpoint temporarily unavailable.";
      }
      const result = {type:'dashboard:action-result',requestId:message.requestId,action:message.action,
        accountId:message.accountId,status:error ? 'failed' : 'completed',payload,error};
      if (window.__holdDaily && message.action === "getDailyUsage") window.__dailyResults.push(result);
      else if (window.__deferUsage && message.action === 'getUsageGraph') window.__deferredUsage.push(result);
      else dispatch(result);
    }, 0);
  }});
})();`;

const output = path.join(tmpdir(), "codex-manager-usage-ui");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
try {
  for (const width of [1440, 1024, 768, 390, 320].filter(width => !process.argv.includes("--desktop-only") || width === 1440)) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", route => route.abort());
    await page.route("**/assets/browserHost.js*", route => route.fulfill({ contentType: "text/javascript", body: mockHost }));
    for (const [url, file, contentType] of [["dashboard.js", "media/webview/dashboard/dashboard.js", "text/javascript"], ["dashboard.css", "media/webview/quotaSummary.css", "text/css"]]) {
      await page.route(`**/assets/${url}*`, route => route.fulfill({ contentType, path: path.resolve(file) }));
    }
    const started = Date.now();
    await page.goto(`${origin}/dash`);
    await page.locator(".usage-graph-bar-hitarea").first().waitFor({ timeout: 8000 }).catch(async error => {
      console.log(JSON.stringify({ errors, debug: await page.evaluate(() => ({ actions: window.__usageActions?.map(action => ({ type: action.type, action: action.action })), graph: document.querySelector(".usage-graph-card")?.textContent, loading: document.querySelector(".loading-section")?.textContent })) }));
      await page.screenshot({ path: path.join(output, `failure-${width}.png`) });
      throw error;
    });
    const loadMs = Date.now() - started;
    assert.equal(await page.evaluate(() => window.__usageActions.filter(action => action.action === "getDailyUsage").length), 0, "Explicitly disabled collection does not fetch");
    assert.equal(await page.evaluate(() => window.__usageActions.filter(action => ["getWorkspaceEnvironment", "listWorkspaceTerminals"].includes(action.action)).length), 0, "The dashboard does not inspect an inactive workspace");
    const chart = page.locator(".usage-graph-card");
    const quotaHeight = (await chart.boundingBox()).height;
    if (width <= 760) assert.ok(quotaHeight <= 130, "Stacked charts keep their compact height");
    else {
      const left = page.locator(".overview-shell > .overview-account").first();
      const right = page.locator(".overview-main");
      const leftBounds = await left.boundingBox();
      const rightBounds = await right.boundingBox();
      assert.ok(Math.abs(leftBounds.y - rightBounds.y) <= 1 && Math.abs(leftBounds.height - rightBounds.height) <= 1, "Desktop overview columns align at top and bottom");
      const plotHeight = (await page.locator(".usage-graph").boundingBox()).height;
      await left.evaluate(element => { element.style.minHeight = `${element.getBoundingClientRect().height + 80}px`; });
      assert.ok(Math.abs((await chart.boundingBox()).height - quotaHeight - 80) <= 1, "Chart fills a taller account column");
      assert.ok(Math.abs((await page.locator(".usage-graph").boundingBox()).height - plotHeight - 80) <= 1, "Only the plot grows to fill available height");
      await left.evaluate(element => { element.style.minHeight = ""; });
    }
    await page.locator(".usage-graph-bar-hitarea").first().focus();
    await page.getByRole("tooltip").waitFor();
    assert.match(await page.getByRole("tooltip").innerText(), /quota used/);
    await page.keyboard.press("ArrowRight");
    assert.ok(await page.locator(".usage-graph-bar-hitarea").nth(1).evaluate(bar => bar === document.activeElement), "Arrow keys move between account bars");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("tooltip").count(), 0);
    await page.screenshot({ path: path.join(output, `quota-${width}.png`) });
    await page.getByRole("button", { name: "Graph settings", exact: true }).click();
    const quotaSummary = page.getByLabel("Account quota summary", { exact: true });
    await quotaSummary.waitFor();
    assert.equal(await quotaSummary.locator(".usage-graph-cache-row").count(), 2);
    assert.match(await quotaSummary.innerText(), /10%/);
    await page.getByRole("button", { name: "Daily token usage", exact: true }).click();
    await page.locator('.usage-graph-bar-hitarea[aria-label*="100 tokens"]').waitFor();
    assert.equal(await page.locator(".usage-graph-bar-hitarea").count(), 2, "Both cached accounts appear");
    assert.equal(new Set(await page.locator(".usage-graph-bar").evaluateAll(bars => bars.map(bar => bar.getAttribute("fill")))).size, 2, "Account colours remain distinct");
    assert.ok(await page.locator(".usage-graph-card").getByText(/Stale/).count(), "Stale history is labelled");
    assert.equal(await page.locator('.usage-graph-bar-hitarea[aria-label*="% tokens"]').count(), 0, "Token totals are not percentages");
    assert.equal((await chart.boundingBox()).height, quotaHeight, "Both chart modes keep the same height");
    await page.locator('.usage-graph-bar-hitarea[aria-label*="100 tokens"]').click();
    const tooltip = page.getByRole("tooltip");
    await tooltip.waitFor();
    assert.match(await tooltip.innerText(), /a@example.invalid/);
    assert.match(await tooltip.innerText(), /300 tokens/);
    assert.match(await tooltip.innerText(), /Stale/);
    const box = await tooltip.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900, "Tooltip stays inside viewport");
    await page.screenshot({ path: path.join(output, `tokens-${width}.png`) });
    await page.keyboard.press("Escape");

    await page.evaluate(() => { window.__failUsage = true; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("7d");
    await page.getByRole("button", { name: "Retry saved graph", exact: true }).waitFor();
    assert.equal(await page.locator(".usage-graph-bar-hitarea").count(), 2, "A failed query preserves the last result");
    assert.equal((await chart.boundingBox()).height, quotaHeight, "A failure does not resize the chart");
    assert.match(await chart.innerText(), /temporarily unavailable/);
    await page.getByRole("button", { name: "Retry saved graph", exact: true }).click();
    await page.locator('.usage-graph-bar-hitarea[aria-label*="700 tokens"]').waitFor();

    await page.evaluate(() => { window.__deferUsage = true; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("30d");
    await page.waitForFunction(() => window.__deferredUsage.length === 1);
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("7d");
    await page.waitForFunction(() => window.__deferredUsage.length === 2);
    await page.evaluate(() => { window.__deferUsage = false; window.__finishUsage(); });
    await page.locator('.usage-graph-bar-hitarea[aria-label*="700 tokens"]').waitFor();
    assert.equal(await page.locator('.usage-graph-bar-hitarea[aria-label*="100 tokens"]').count(), 0, "A late response cannot replace the selected range");

    await page.evaluate(() => { window.__richUsage = true; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("30d");
    await page.waitForFunction(() => document.querySelectorAll(".usage-graph-bar").length === 60);
    assert.equal((await chart.boundingBox()).height, quotaHeight, "A full month stays compact");
    await page.locator(".usage-graph-bar-hitarea").last().focus();
    await page.getByRole("tooltip").waitFor();
    await page.screenshot({ path: path.join(output, `month-${width}.png`) });
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__zeroUsage = true; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("7d");
    await chart.getByText("No token use recorded", { exact: true }).waitFor();
    assert.equal((await chart.boundingBox()).height, quotaHeight);
    await page.evaluate(() => { window.__emptyUsage = true; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("30d");
    await chart.getByText("No saved tokens in this period", { exact: true }).waitFor();
    assert.equal((await chart.boundingBox()).height, quotaHeight);

    if (width === 1440) {
      await page.locator("#settingsOpenButton").click();
      await page.locator("#settings-tab-data").click();
      const toggle = page.getByRole("button", { name: "Automatic token history", exact: true });
      assert.equal(await toggle.getAttribute("aria-pressed"), "false");
      await toggle.click();
      await page.waitForFunction(() => window.__usageActions.some(action => action.action === "getDailyUsage"));
      const checks = await page.evaluate(() => window.__usageActions.filter(action => action.action === "getDailyUsage"));
      assert.equal(checks.length, 1, "Enabling collection checks the current account once");
      assert.equal(checks[0].accountId, "a");
      assert.equal(checks[0].payload.automatic, true);
      await toggle.click();
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "Graph settings", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "Graph settings", exact: true });
    const menuBounds = await menu.boundingBox();
    assert.ok(menuBounds.x >= 8 && menuBounds.x + menuBounds.width <= width - 7 && menuBounds.y >= 8 && menuBounds.y + menuBounds.height <= 893, "Chart menu stays within the viewport");
    await page.getByRole("button", { name: "Refresh token history for a@example.invalid", exact: true }).click();
    await menu.getByText("Updated", { exact: true }).waitFor();
    await page.evaluate(() => { window.__failDaily = "b"; });
    await page.getByRole("button", { name: "Refresh token history for b@example.invalid", exact: true }).click();
    await menu.getByRole("alert").filter({ hasText: "Token endpoint temporarily unavailable." }).waitFor();
    assert.ok((await menu.locator(".usage-graph-cache-row").first().boundingBox()).height <= 24, "Each account stays on one compact line");
    await page.screenshot({ path: path.join(output, `menu-${width}.png`) });
    if (width === 1440) {
      await page.evaluate(() => { window.__addUsageAccounts(); window.__holdDaily = true; window.__failDaily = "b"; });
      await menu.getByRole("button", { name: "Refresh all", exact: true }).click();
      await page.waitForFunction(() => window.__dailyResults.length === 3);
      assert.equal(await page.evaluate(() => window.__dailyMax), 3, "Bulk history refresh has three requests in flight");
      await page.evaluate(() => window.__releaseDaily());
      await menu.getByText("Finished: 7 updated, 1 failed.", { exact: true }).waitFor().catch(async error => {
        console.log(JSON.stringify(await page.evaluate(() => ({menu:document.querySelector(".usage-graph-settings-popover")?.textContent,pending:window.__dailyResults.length,actions:window.__usageActions.filter(action => action.action === "getDailyUsage").map(action => action.accountId)}))));
        await page.screenshot({ path: path.join(output, "bulk-failure.png") });
        throw error;
      });
    }
    await page.keyboard.press("Escape");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), "The graph fits the viewport");
    assert.deepEqual(errors, [], "No browser runtime errors");
    results.push({ width, loadMs, consolidatedAccounts: 2, staleHistory: "visible", failedQuery: "preserved", outOfOrder: "ignored" });
    await context.close();
  }
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ results, screenshots: output }, null, 2));
} finally { await browser.close(); }
