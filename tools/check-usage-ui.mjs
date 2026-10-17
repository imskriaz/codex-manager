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
  window.__missingUsageIds = []; window.__usageActions = []; window.__deferredUsage = []; window.__dailyResults = []; window.__dailyActive = 0; window.__dailyMax = 0;
  window.__addUsageAccounts = () => { state = {...state, accounts:[...state.accounts, ...["c","d","e","f","g","h"].map(id => ({...state.accounts[1],id,email:id+"@example.invalid"}))]}; dispatch({type:"dashboard:snapshot",state}); };
  window.__setUsageAutomatic = enabled => { state = {...state,settings:{...state.settings,dailyTokenUsageEnabled:enabled}}; dispatch({type:"dashboard:snapshot",state}); };
  window.__setUsagePrivacy = enabled => { state = {...state,settings:{...state.settings,privacyMode:enabled}}; dispatch({type:"dashboard:snapshot",state}); };
  window.__addMissingAccounts = () => {
    window.__missingUsageIds = ["i","j","k","l"];
    state = {...state, settings:{...state.settings,dailyTokenUsageEnabled:true}, usageSummary:{...state.usageSummary,revision:state.usageSummary.revision+1}, accounts:[...state.accounts,...window.__missingUsageIds.map(id => ({...state.accounts[1],id,email:id+"@example.invalid"}))]};
    dispatch({type:"dashboard:snapshot",state});
  };
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
          dailyUsageCache: query.mode === 'tokens' ? state.accounts.filter(account => !window.__missingUsageIds.includes(account.id)).map((account,index) => ({accountId:account.id,
            fetchedAt:Date.now() - (index ? 60000 : 2 * 3600000),usage:{days:30,points:window.__emptyUsage ? [] : window.__richUsage ? Array.from({length:30},(_,i) => ({date:new Date(query.to-(30-i)*day).toISOString().slice(0,10),unit:"tokens",totalTokens:window.__zeroUsage || (window.__mixedZeroUsage && index === 0) ? 0 : 234,extensionTokens:window.__zeroUsage || (window.__mixedZeroUsage && index === 0) ? 0 : 134,otherTokens:window.__zeroUsage || (window.__mixedZeroUsage && index === 0) ? 0 : 100})) : [{date:query.to-query.from===day ? new Date(query.to-day).toISOString().slice(0,10) : date,unit:"tokens",totalTokens:tokens * (index + 1),extensionTokens:Math.floor(tokens * (index + 1) / 2),otherTokens:Math.ceil(tokens * (index + 1) / 2)}]}})) : []};
        if (window.__failUsage) { window.__failUsage = false; error = 'Saved graph database is temporarily unavailable.'; }
      } else if (message.action === 'getDailyUsage') {
        payload = {dailyUsage:{days:30,points:[{unit:"tokens",date,totalTokens:600,extensionTokens:100,otherTokens:500}]},dailyUsageFetchedAt:Date.now()};
        if (window.__failDaily === message.accountId) error = "Token endpoint temporarily unavailable.";
        else window.__missingUsageIds = window.__missingUsageIds.filter(id => id !== message.accountId);
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
    await page.goto(`${origin}/`);
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
    await page.getByRole("button", { name: "Token usage", exact: true }).click();
    await page.locator('.usage-graph-bar-hitarea[aria-label*="300 tokens"]').waitFor();
    assert.equal(await page.locator(".usage-graph-bar-hitarea").count(), 1, "All accounts share one daily stacked bar");
    assert.deepEqual(new Set(await page.locator(".usage-graph-bar").evaluateAll(bars => bars.map(bar => bar.getAttribute("data-source")))), new Set(["VS Code", "Other"]), "The daily bar stacks VS Code and Other");
    assert.equal(await chart.locator(".usage-graph-status, .usage-graph-feedback, .usage-graph-empty").count(), 0, "Chart has no message overlays or badges");
    assert.equal(await page.locator('.usage-graph-bar-hitarea[aria-label*="% tokens"]').count(), 0, "Token totals are not percentages");
    assert.equal((await chart.boundingBox()).height, quotaHeight, "Both chart modes keep the same height");
    await page.locator('.usage-graph-bar-hitarea[aria-label*="300 tokens"]').click();
    const tooltip = page.getByRole("tooltip");
    await tooltip.waitFor();
    assert.match(await tooltip.innerText(), /a@example.invalid/);
    assert.match(await tooltip.locator(".usage-graph-tooltip-value").innerText(), /300[\s\S]*All accounts this day/);
    assert.deepEqual(await tooltip.locator(".usage-graph-account-stat").allTextContents(), ["a@example.invalid100 tokens", "b@example.invalid200 tokens"]);
    assert.deepEqual(await tooltip.getByLabel("Usage by source", { exact: true }).allTextContents(), ["VS Code150 tokensOther150 tokens"]);
    assert.match(await tooltip.innerText(), /stale/i);
    const box = await tooltip.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900, "Tooltip stays inside viewport");
    await page.screenshot({ path: path.join(output, `tokens-${width}.png`) });
    await page.keyboard.press("Escape");

    const statsTrigger = page.getByRole("button", { name: "View account usage stats", exact: true });
    await statsTrigger.click();
    const accountStats = page.getByRole("tooltip", { name: "Account usage stats", exact: true });
    await accountStats.waitFor();
    assert.equal(await accountStats.locator(".usage-graph-account-stat").count(), 2);
    assert.match(await accountStats.innerText(), /VS Code \+ Other/);
    assert.match(await accountStats.innerText(), /100 tokens/);
    assert.match(await accountStats.innerText(), /200 tokens/);
    const statsBounds = await accountStats.boundingBox();
    assert.ok(statsBounds.x >= 8 && statsBounds.x + statsBounds.width <= width - 7 && statsBounds.y >= 8 && statsBounds.y + statsBounds.height <= 893, "Account stats stay inside the viewport");
    await page.screenshot({ path: path.join(output, `account-stats-${width}.png`) });
    await page.keyboard.press("Escape");
    await page.mouse.move(width - 1, 899);
    assert.equal(await accountStats.count(), 0, "Escape dismisses account stats");
    assert.deepEqual(await page.getByRole("combobox", { name: "Graph time range" }).locator("option").allTextContents(), ["1D", "7D", "30D"]);
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("24h");
    await page.locator('.usage-graph-bar-hitarea[aria-label*="2,100 tokens"]').waitFor();
    assert.equal((await chart.boundingBox()).height, quotaHeight);
    await page.getByRole("button", { name: "Older period", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("codexManager.usageGraphPreferences.v1")).windowOffset === 1);
    await page.reload();
    await page.locator('.usage-graph-bar-hitarea[aria-label*="2,100 tokens"]').waitFor();
    assert.equal(await chart.getAttribute("data-mode"), "tokens", "Reload keeps the selected mode");
    assert.equal(await page.getByRole("combobox", { name: "Graph time range" }).inputValue(), "24h", "Reload keeps the selected range");
    const restoredQuery = await page.evaluate(() => window.__usageActions.find(action => action.action === "getUsageGraph").payload.usageGraph);
    assert.equal(restoredQuery.mode, "tokens");
    assert.equal(restoredQuery.to - restoredQuery.from, 86_400_000);
    assert.equal(restoredQuery.to, await page.evaluate(() => Math.floor(Date.now() / 86_400_000) * 86_400_000), "The first reload query restores the saved historical period");
    await page.getByRole("button", { name: "Newer period", exact: true }).click();
    await page.getByRole("button", { name: "Newer period", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Graph settings", exact: true }).click();
    await page.getByRole("button", { name: "Quota changes", exact: true }).click();
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("6h");
    await page.getByRole("button", { name: "Graph settings", exact: true }).click();
    await page.getByRole("button", { name: "Token usage", exact: true }).click();
    assert.equal(await page.getByRole("combobox", { name: "Graph time range" }).inputValue(), "24h", "Mode switching keeps its separate range");
    await page.getByRole("button", { name: "Graph settings", exact: true }).click();
    await page.getByRole("button", { name: "Quota changes", exact: true }).click();
    assert.equal(await page.getByRole("combobox", { name: "Graph time range" }).inputValue(), "6h");
    await page.reload();
    await page.locator('.usage-graph-card[data-mode="quota"]').waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Graph time range" }).inputValue(), "6h", "Quota choice also survives reload");
    await page.getByRole("button", { name: "Graph settings", exact: true }).click();
    await page.getByRole("button", { name: "Token usage", exact: true }).click();
    await page.evaluate(() => window.__setUsagePrivacy(true));
    await page.locator(".usage-graph-bar-hitarea").first().focus();
    await tooltip.waitFor();
    assert.doesNotMatch(await tooltip.innerText(), /@example.invalid/, "Daily account details respect privacy mode");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__setUsagePrivacy(false));
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("30d");
    await page.locator('.usage-graph-bar-hitarea[aria-label*="300 tokens"]').waitFor();

    await page.evaluate(() => { window.__failUsage = true; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("7d");
    await page.getByRole("button", { name: "Graph settings", exact: true }).click();
    await page.getByRole("button", { name: "Retry saved graph", exact: true }).waitFor();
    assert.equal(await page.locator(".usage-graph-bar-hitarea").count(), 1, "A failed query preserves the last result");
    assert.equal((await chart.boundingBox()).height, quotaHeight, "A failure does not resize the chart");
    assert.doesNotMatch(await chart.innerText(), /temporarily unavailable/);
    assert.match(await page.getByRole("dialog", { name: "Graph settings", exact: true }).innerText(), /temporarily unavailable/);
    await page.getByRole("button", { name: "Retry saved graph", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.locator('.usage-graph-bar-hitarea[aria-label*="2,100 tokens"]').waitFor();

    await page.evaluate(() => { window.__deferUsage = true; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("30d");
    await page.waitForFunction(() => window.__deferredUsage.length === 1);
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("7d");
    await page.waitForFunction(() => window.__deferredUsage.length === 2);
    await page.evaluate(() => { window.__deferUsage = false; window.__finishUsage(); });
    await page.locator('.usage-graph-bar-hitarea[aria-label*="2,100 tokens"]').waitFor();
    assert.equal(await page.locator('.usage-graph-bar-hitarea[aria-label*="300 tokens"]').count(), 0, "A late response cannot replace the selected range");

    await page.evaluate(() => { window.__richUsage = true; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("30d");
    await page.waitForFunction(() => document.querySelectorAll(".usage-graph-bar").length === 60);
    assert.equal((await chart.boundingBox()).height, quotaHeight, "A full month stays compact");
    await page.locator(".usage-graph-bar-hitarea").first().focus();
    await page.getByRole("tooltip").waitFor();
    assert.deepEqual(await tooltip.locator(".usage-graph-account-stat strong").allTextContents(), ["234 tokens", "234 tokens"], "Daily rows use only the hovered UTC day, not the monthly total");
    await page.locator(".usage-graph-bar-hitarea").last().focus();
    await tooltip.waitFor();
    await tooltip.evaluate(element => { element.style.width = "480px"; element.style.paddingBottom = "80px"; });
    await page.waitForFunction(() => {
      const box = document.querySelector('[role="tooltip"]')?.getBoundingClientRect();
      return box && box.left >= 8 && box.right <= innerWidth - 7 && box.top >= 8 && box.bottom <= innerHeight - 7;
    });
    const segments = await page.locator(".usage-graph g").last().locator(".usage-graph-bar").evaluateAll(bars => bars.map(bar => ({ y: +bar.getAttribute("y"), height: +bar.getAttribute("height") })));
    assert.ok(Math.abs(segments[1].y + segments[1].height - segments[0].y) < 0.001, "Source segments touch without overlapping");
    await page.screenshot({ path: path.join(output, `month-${width}.png`) });
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__mixedZeroUsage = true; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("24h");
    await page.waitForFunction(() => document.querySelectorAll(".usage-graph-bar-hitarea").length === 1);
    await page.locator('.usage-graph-bar-hitarea[aria-label*="234 tokens"]').first().waitFor();
    await page.locator(".usage-graph-bar-hitarea").last().click();
    await tooltip.waitFor();
    assert.deepEqual(await tooltip.locator(".usage-graph-account-stat").allTextContents(), ["b@example.invalid234 tokens"], "Daily tooltips omit zero-token accounts");
    assert.equal(await tooltip.locator(".usage-graph-tooltip-value strong").innerText(), "234", "Hiding zero rows preserves the daily total");
    assert.equal(await tooltip.locator('[data-stale="true"]').count(), 0, "Hidden zero-token rows do not add stale notices");
    await page.keyboard.press("Escape");
    await statsTrigger.click();
    await accountStats.waitFor();
    assert.deepEqual(await accountStats.locator(".usage-graph-account-stat").allTextContents(), ["b@example.invalid234 tokens"], "Period tooltips also omit zero-token accounts");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__mixedZeroUsage = false; });
    await page.evaluate(() => { window.__zeroUsage = true; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("7d");
    await page.locator('.usage-graph-bar-hitarea[aria-label*="0 tokens"]').first().waitFor();
    assert.equal(await chart.locator(".usage-graph-empty").count(), 0);
    assert.equal((await chart.boundingBox()).height, quotaHeight);
    await page.locator(".usage-graph-bar-hitarea").first().focus();
    await tooltip.waitFor();
    assert.equal(await tooltip.locator(".usage-graph-account-stat").count(), 0, "All-zero days show no account rows");
    assert.equal(await tooltip.locator(".usage-graph-tooltip-value strong").innerText(), "0", "The zero daily total remains visible");
    await page.keyboard.press("Escape");
    await statsTrigger.click();
    await accountStats.waitFor();
    assert.equal(await accountStats.locator(".usage-graph-account-stat").count(), 0, "All-zero periods show no account rows");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__emptyUsage = true; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("30d");
    await page.waitForFunction(() => document.querySelectorAll(".usage-graph-bar-hitarea").length === 0);
    assert.equal(await chart.locator(".usage-graph-empty").count(), 0);
    assert.equal((await chart.boundingBox()).height, quotaHeight);

    if (width === 1440) {
      await page.locator("#settingsOpenButton").click();
      await page.locator("#settings-tab-automation").click();
      const toggle = page.getByRole("button", { name: "Automatic token history", exact: true });
      assert.equal(await toggle.getAttribute("aria-pressed"), "false");
      assert.equal(await toggle.locator("../..").evaluate(block => block === block.parentElement.lastElementChild), true, "Automatic token history is last in Automation");
      await toggle.click();
      await page.waitForFunction(() => window.__usageActions.some(action => action.action === "getDailyUsage"));
      const checks = await page.evaluate(() => window.__usageActions.filter(action => action.action === "getDailyUsage"));
      assert.equal(checks.length, 1, "Enabling collection checks the current account once");
      assert.equal(checks[0].accountId, "a");
      assert.equal(checks[0].payload.automatic, true);
      const gap = page.getByRole("slider", { name: "Gap between automatic checks; server retry delays still apply.", exact: true });
      assert.equal(await gap.getAttribute("min"), "1");
      assert.equal(await gap.getAttribute("max"), "1440");
      for (const value of [1, 1440, 60]) {
        await gap.evaluate((element, value) => { element.value = String(value); element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); }, value);
        await page.waitForFunction(value => window.__usageActions.some(action => action.type === "dashboard:setting" && action.key === "dailyTokenUsageIntervalMinutes" && action.value === value), value);
      }
      await gap.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `automation-gap-${width}.png`) });
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
    await menu.getByRole("alert").filter({ hasText: "Token endpoint temporarily unavailable." }).first().waitFor();
    assert.equal(await page.locator(".dashboard-notice-stack").count(), 0, "Token failures stay out of toasts");
    assert.doesNotMatch(await chart.innerText(), /Token endpoint temporarily unavailable/);
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
    if (width === 1440) {
      await page.keyboard.press("Escape");
      await page.mouse.move(width - 1, 899);
      await page.evaluate(() => { window.__holdDaily = true; window.__failDaily = "j"; window.__addMissingAccounts(); });
      await page.waitForFunction(() => window.__dailyResults.length === 3);
      const startedBeforeOff = await page.evaluate(() => window.__usageActions.filter(action => action.action === "getDailyUsage" && ["i","j","k","l"].includes(action.accountId)).length);
      await page.evaluate(() => window.__setUsageAutomatic(false));
      await page.locator("#settingsOpenButton").click();
      await page.locator("#settings-tab-automation").click();
      const automaticToggle = page.getByRole("button", { name: "Automatic token history", exact: true });
      await automaticToggle.waitFor();
      assert.equal(await automaticToggle.getAttribute("aria-pressed"), "false");
      await page.keyboard.press("Escape");
      await page.evaluate(() => window.__releaseDaily());
      await page.waitForFunction(() => window.__dailyActive === 0);
      assert.equal(await page.evaluate(() => window.__usageActions.filter(action => action.action === "getDailyUsage" && ["i","j","k","l"].includes(action.accountId)).length), startedBeforeOff, "Turning automatic collection off cancels queued checks");
      await page.evaluate(() => window.__setUsageAutomatic(true));
      await page.waitForFunction(() => ["i","j","k","l"].every(id => window.__usageActions.some(action => action.action === "getDailyUsage" && action.accountId === id && action.payload.automatic === true)));
      await page.waitForFunction(() => window.__missingUsageIds.length === 1);
      const autoChecks = await page.evaluate(() => window.__usageActions.filter(action => action.action === "getDailyUsage" && ["i","j","k","l"].includes(action.accountId)));
      assert.equal(autoChecks.length, 4, "Missing usage loads without opening account stats");
      await statsTrigger.click();
      await accountStats.waitFor();
      await accountStats.locator(".usage-graph-account-stat").filter({ hasText: "j@example.invalid" }).getByText("Failed", { exact:true }).waitFor();
      assert.equal(await accountStats.locator(".usage-graph-account-stat").count(), 12, "The tooltip lists every account");
      assert.equal(await page.evaluate(() => window.__usageActions.filter(action => action.action === "getDailyUsage" && ["i","j","k","l"].includes(action.accountId)).length), 4, "Opening stats does not fetch or retry usage");
      await page.keyboard.press("Escape");
      await page.evaluate(() => { window.__emptyUsage = false; window.__zeroUsage = false; window.__richUsage = true; });
      await page.getByRole("combobox", { name: "Graph time range" }).selectOption("7d");
      await page.locator(".usage-graph-bar-hitarea").last().focus();
      await tooltip.waitFor();
      assert.equal(await tooltip.locator(".usage-graph-account-stat").count(), 12, "Daily tooltip includes every account");
      await tooltip.locator(".usage-graph-account-stat").filter({ hasText: "j@example.invalid" }).getByText("No data", { exact: true }).waitFor();
      await tooltip.getByLabel("Daily usage by account", { exact: true }).focus();
      await tooltip.getByLabel("Daily usage by account", { exact: true }).evaluate(element => { element.scrollTop = element.scrollHeight; });
      await tooltip.waitFor();
      assert.ok(await tooltip.getByLabel("Daily usage by account", { exact: true }).evaluate(element => element.scrollTop > 0), "Many accounts remain scrollable by keyboard");
    }
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__originalStorageSet = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException("Storage full", "QuotaExceededError"); }; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("24h");
    assert.equal(await chart.getByRole("alert").count(), 0);
    await page.getByRole("button", { name: "Graph settings", exact: true }).click();
    await menu.getByRole("alert").filter({ hasText: "Chart choices could not be saved on this device." }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Graph time range" }).inputValue(), "24h", "Storage failures never block chart controls");
    await page.evaluate(() => { Storage.prototype.setItem = window.__originalStorageSet; });
    await page.getByRole("combobox", { name: "Graph time range" }).selectOption("30d");
    await menu.getByText("Chart choices could not be saved on this device.", { exact: true }).waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), "The graph fits the viewport");
    assert.deepEqual(errors, [], "No browser runtime errors");
    results.push({ width, loadMs, consolidatedAccounts: 2, staleHistory: "visible", failedQuery: "preserved", outOfOrder: "ignored", savedPreferences: "restored", dailyAccountTotals: "verified", storageFailure: "non-blocking" });
    await context.close();
  }
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ results, screenshots: output }, null, 2));
} finally { await browser.close(); }
