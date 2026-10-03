import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

// Only GET the canonical local snapshot. All browser actions are intercepted
// in memory, so this check cannot send a turn or change a real account.
const origin = process.env.CODEX_MANAGER_UI_URL || "http://127.0.0.1:39875";
const response = await fetch(`${origin}/api/state`);
if (!response.ok) throw new Error(`Local dashboard snapshot returned ${response.status}.`);
const snapshot = await response.json();
snapshot.settings.cliIntegrationEnabled = true;
snapshot.settings.privacyMode = true;
const parentId = "01a04882-d037-7a42-ad24-9afb61901188";
const runningId = "01a04882-d037-7a42-ad24-9afb61901189";
const agentId = "01a04882-d037-7a42-ad24-9afb61901190";
const sessions = [
  { id: parentId, title: "Evaluate stack beyond expectations", status: "idle", projectPath: "D:/demo", updatedAt: new Date().toISOString() },
  { id: runningId, title: "Running workspace task", status: "running", projectPath: "D:/demo", updatedAt: new Date().toISOString(), runningBy: "another Codex process" },
  { id: agentId, title: "Evaluate stack beyond expectations", status: "running", projectPath: "D:/demo", parentSessionId: parentId, agentName: "Reviewer" },
  { id: "01a04882-d037-7a42-ad24-9afb61901191", title: "Archived task", status: "idle", projectPath: "D:/demo", archived: true }
];
sessions.push(sessions[0]);
const messages = [
  { id: "user", kind: "message", role: "user", text: "Review the workspace and explain the result." },
  { id: "assistant", kind: "message", role: "assistant", text: "The workspace is ready.\n\n```ts\nconst answer = 42;\n```\n\n[Documentation](https://example.com/docs)\n\n| Item | State |\n| --- | --- |\n| Chat | Ready |" }
];
const config = { models: [{ id: "gpt-5", label: "GPT-5", reasoningEfforts: ["medium", "high"] }], projects: [{ id: "demo", path: "D:/demo", label: "demo" }, { id: "empty", path: "D:/empty-project-with-a-long-name", label: "empty-project-with-a-long-name" }], defaultModel: "gpt-5", defaultReasoningEffort: "medium", defaultSandboxMode: "workspace-write" };
const mockHost = `(() => {
  const state = ${JSON.stringify(snapshot)};
  const sessions = ${JSON.stringify(sessions)};
  const messages = ${JSON.stringify(messages)};
  const config = ${JSON.stringify(config)};
  let messageReads = 0;
  const dispatch = data => window.dispatchEvent(new MessageEvent('message', {data}));
  window.__uiActions = [];
  window.acquireVsCodeApi = () => ({postMessage(message) {
    window.__uiActions.push(message);
    setTimeout(() => {
      if(message.type === 'dashboard:ready') {
        dispatch({type:'dashboard:snapshot',state});
        dispatch({type:'dashboard:connection',connected:true});
      } else if(message.type === 'dashboard:action') {
        let payload = {}, error;
        if(message.action === 'listCodexCliSessions') payload = {cliSessions:sessions,cliComposerConfig:config};
        else if(message.action === 'startCodexCliSession') {
          const session = {id:'01a04882-d037-7a42-ad24-9afb61901198',title:'New smoke chat',status:'idle',projectPath:message.payload.projectPath};
          if(!sessions.some(row=>row.id===session.id)) sessions.push(session);
          payload = {cliSession:session,cliSessionMessages:[{id:'new-user',kind:'message',role:'user',text:message.payload.text},{id:'new-answer',kind:'message',role:'assistant',text:'New chat first response'}],notice:{level:'info',message:'New Codex chat is ready.'}};
        }
        else if(message.action === 'getCodexCliSessionMessages') {
          messageReads++;
          payload = {cliSession:sessions.find(s => s.id === message.payload.sessionId),cliSessionMessages:messageReads > 1 ? [...messages,{id:'live',kind:'message',role:'assistant',text:'Live transcript update'}] : messages};
        } else if(message.action === 'getCodexSubAgentMessages') payload = {cliSubAgentSession:sessions.find(s => s.id === message.payload.sessionId),cliSubAgentMessages:[{id:'agent-msg',kind:'message',role:'assistant',text:'Agent reviewer message'}]};
        else if(message.action === 'getWorkspaceEnvironment') payload = {workspaceEnvironment:{projectPath:'D:/demo',projectName:'demo',isGitRepository:true,branch:'main',changes:0,additions:0,deletions:0,ahead:0,behind:0,hasRemote:false}};
        else if(message.action === 'listWorkspaceTerminals') payload = {workspaceTerminals:[]};
        else if(message.action === 'listWorkspaceFiles') payload = {workspaceFiles:[]};
        else error = 'Simulated action failure. Your draft is preserved.';
        const result = {type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:error?'failed':'completed',payload,error};
        if(message.action === 'getCodexCliSessionMessages' && window.__holdNextMessageRead) {
          window.__holdNextMessageRead = false;
          window.__heldMessageResult = result;
          return;
        }
        if(message.action === 'sendCodexCliSessionMessage' && window.__holdNextSend) {
          window.__holdNextSend = false;
          window.__heldSendResult = {...result,status:'completed',error:undefined,payload:{cliSession:sessions.find(s=>s.id===message.payload.sessionId),cliSessions:sessions,cliSessionMessages:[{id:'late-turn',kind:'message',role:'assistant',text:'Completed original conversation'}]}};
          return;
        }
        dispatch(result);
      }
    }, 50);
  },getState(){},setState(){}});
})();`;
const output = path.join(tmpdir(), "codex-manager-ui-check");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.CODEX_MANAGER_BROWSER || "msedge", headless: true });
const results = [];
try {
  for (const [width, height] of (process.argv.includes("--landscape") ? [[844, 390]] : [[1440, 1000], [1024, 768], [768, 1024], [390, 844], [320, 667], [844, 390]])) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width <= 760, serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
    if (width === 320) await context.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("Browser storage unavailable", "SecurityError"); } } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    console.log(`Checking ${width}x${height}: session list`);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", (route) => route.abort());
    await page.route("**/assets/browserHost.js*", (route) => route.fulfill({ contentType: "text/javascript", body: mockHost }));
    for (const [url, file, contentType] of [["dashboard.js", "media/webview/dashboard/dashboard.js", "text/javascript"], ["dashboard.css", "media/webview/quotaSummary.css", "text/css"], ["shared.css", "media/webview/shared.css", "text/css"]]) {
      await page.route(`**/assets/${url}*`, (route) => route.fulfill({ contentType, path: path.resolve(file) }));
    }
    await page.goto(`${origin}/workspace`);
    await page.locator(".cli-workspace").waitFor();
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Expand demo", exact: true }).waitFor();
    const railBounds = await page.locator(".cli-session-rail").boundingBox();
    const footerBounds = await page.locator(".cli-account-footer").boundingBox();
    assert.ok(railBounds && footerBounds && footerBounds.y + footerBounds.height >= railBounds.y + railBounds.height - 16, "Account footer stays at the bottom of the sidebar");
    assert.equal(await page.locator(".cli-session-row-select").count(), 0, "Projects start collapsed");
    assert.equal(await page.locator(".cli-project-running").count(), 1, "Collapsed project shows running sessions");
    assert.equal(await page.getByRole("button", { name: "Expand empty-project-with-a-long-name", exact: true }).count(), 0, "Projects without sessions stay hidden");
    const searchBounds = await page.getByRole("searchbox", { name: "Search sessions", exact: true }).boundingBox();
    assert.ok(searchBounds && searchBounds.width >= railBounds.width - 40, "Search keeps full rail width");
    await page.getByRole("searchbox", { name: "Search sessions", exact: true }).fill("Running workspace");
    await page.locator(".cli-compact-session-list").waitFor();
    assert.equal(await page.locator(".cli-session-row-select").count(), 1, "Search shows matching chats without opening projects");
    await page.getByRole("searchbox", { name: "Search sessions", exact: true }).fill("");
    await page.getByRole("button", { name: "Expand demo", exact: true }).waitFor();
    assert.equal(await page.getByRole("tablist", { name: "Session state" }).count(), 0, "No separate state tabs");
    await page.getByRole("button", { name: "Show compact session list", exact: true }).click();
    await page.locator(".cli-compact-session-list").waitFor();
    assert.equal(await page.locator(".cli-session-row-select").count(), 2, "Compact view keeps only distinct parents");
    assert.equal(await page.locator(".cli-project-group").count(), 0, "Compact view has no project nesting");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("codexManager.workspaceLayout.v2") || "{}").sessionView === "compact");
    await page.reload();
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Show projects and sessions", exact: true }).waitFor();
    await page.locator(".cli-compact-session-list").waitFor();
    await page.getByRole("button", { name: "Show projects and sessions", exact: true }).click();
    await page.getByRole("button", { name: "Expand demo", exact: true }).waitFor();
    await page.getByRole("button", { name: "Show archived sessions (1)", exact: true }).click();
    await page.getByRole("button", { name: "Show active sessions (2)", exact: true }).waitFor();
    await page.getByRole("button", { name: "Show active sessions (2)", exact: true }).click();
    await page.getByRole("button", { name: "Expand demo", exact: true }).click();
    assert.equal(await page.locator(".cli-session-row-select").count(), 2, "Only distinct parent sessions should appear");
    assert.equal(await page.locator(".cli-session-row.is-running .cli-session-spinner").count(), 1, "Running parent needs an icon");
    await page.locator(".cli-session-row-select").filter({ hasText: "Evaluate stack" }).click();
    await page.getByRole("textbox", { name: "Message Codex", exact: true }).waitFor();
    if (width <= 760) assert.equal(await page.locator(".cli-rail-toggle").getAttribute("aria-expanded"), "false", "Selecting a chat closes the mobile drawer");
    console.log(`Checking ${width}x${height}: realtime messages`);
    await page.getByText("Live transcript update", { exact: true }).waitFor({ timeout: 12_000 });
    const copyCode = page.getByRole("button", { name: "Copy code", exact: true }).first();
    await copyCode.click();
    await page.getByText("Code copied.", { exact: true }).first().waitFor();
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), "const answer = 42;\n");
    const documentation = page.getByRole("link", { name: "Documentation", exact: true }).first();
    assert.equal(await documentation.getAttribute("target"), "_blank");
    assert.match(await documentation.getAttribute("rel"), /noopener/);
    assert.equal(await page.locator(".cli-message-markdown table").first().getByRole("cell", { name: "Ready", exact: true }).count(), 1);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.getByRole("dialog", { name: "Share session" }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".cli-share-modal").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Session actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Copy link", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".cli-session-menu").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Show Environment", exact: true }).click();
    await page.getByRole("button", { name: "Close Environment", exact: true }).click();
    console.log(`Checking ${width}x${height}: Agent tabs`);
    await page.getByRole("button", { name: /^Agents/ }).click();
    await page.locator(".cli-agent-row").filter({ hasText: "Reviewer" }).click();
    await page.getByRole("tab", { name: "Agent: Reviewer" }).waitFor();
    await page.getByText("Agent reviewer message", { exact: true }).waitFor();
    assert.equal(await page.getByText("Get codex sub agent messages completed.", { exact: true }).count(), 0, "Agent loading must not cover the composer with redundant success feedback");
    await page.getByRole("button", { name: "Hide workspace tools", exact: true }).click();
    await page.getByRole("button", { name: "Show workspace tools", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "New VS Code terminal", exact: true }).count(), 0, "Only one panel creation control");
    for (const tool of ["files", "reviews"]) {
      await page.getByRole("button", { name: "Add workspace tool or terminal", exact: true }).click();
      await page.getByRole("menuitem", { name: new RegExp(`^${tool}$`, "i") }).click();
      await page.getByRole("tab", { name: new RegExp(`^${tool}$`, "i") }).waitFor();
    }
    await page.getByRole("button", { name: "Hide workspace tools", exact: true }).click();
    const userMessage = page.locator(".cli-conversation .cli-session-message.is-user").first();
    const initialMessageHeight = await userMessage.evaluate(element => element.getBoundingClientRect().height);
    await page.mouse.move(width - 2, height - 2);
    assert.equal(await userMessage.locator(".cli-message-actions").evaluate(element => getComputedStyle(element).opacity), "0", "Actions start hidden");
    if (width <= 760) await userMessage.tap(); else await userMessage.hover();
    await userMessage.getByRole("button", { name: "Quote", exact: true }).click();
    assert.equal(await userMessage.evaluate(element => element.getBoundingClientRect().height), initialMessageHeight, "Actions never add message height");
    assert.equal(await userMessage.locator(".cli-message-actions").evaluate(element => getComputedStyle(element).position), "absolute", "Actions anchor to the message");
    assert.match(await page.getByRole("textbox", { name: "Message Codex", exact: true }).inputValue(), /^> /);
    await page.locator('input[type="file"][aria-label="Choose attachments"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Review this text attachment") });
    await page.getByRole("button", { name: "Remove notes.txt", exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `before-send-${width}x${height}.png`) });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("Simulated action failure. Your draft is preserved.", { exact: true }).first().waitFor();
    assert.match(await page.getByRole("textbox", { name: "Message Codex", exact: true }).inputValue(), /^> /, "Failed sends preserve the draft");
    assert.equal(await page.getByRole("button", { name: "Remove notes.txt", exact: true }).count(), 1, "Failed sends preserve attachments");
    // Hold a real FileReader until after navigating to another composer.
    await page.evaluate(() => {
      const read = FileReader.prototype.readAsText;
      FileReader.prototype.readAsText = function(file) {
        FileReader.prototype.readAsText = read;
        window.__releaseAttachmentRead = () => read.call(this, file);
      };
    });
    await page.locator('input[type="file"][aria-label="Choose attachments"]').setInputFiles({ name: "late.txt", mimeType: "text/plain", buffer: Buffer.from("Original conversation only") });
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Message Codex", exact: true });
    assert.equal(await composer.inputValue(), "", "New chats must not inherit another chat's draft");
    assert.equal(await page.getByRole("button", { name: "Remove notes.txt", exact: true }).count(), 0);
    await composer.fill("Separate new chat draft");
    await page.evaluate(() => window.__releaseAttachmentRead());
    await page.getByRole("button", { name: "Attach files", exact: true }).waitFor();
    await page.getByText("Attachments added to the original chat draft. Return to that chat to use them.", { exact: true }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Remove late.txt", exact: true }).count(), 0, "Late file reads stay with the originating chat");
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.locator(".cli-session-row-select").filter({ hasText: "Evaluate stack" }).click();
    assert.match(await composer.inputValue(), /^> /, "Returning to a chat restores its draft");
    await page.getByRole("button", { name: "Remove late.txt", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Remove notes.txt", exact: true }).count(), 1);
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    assert.equal(await composer.inputValue(), "Separate new chat draft", "Returning to a new-chat project restores its separate draft");
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.locator(".cli-session-row-select").filter({ hasText: "Evaluate stack" }).click();
    await page.evaluate(() => { window.__holdNextMessageRead = true; window.__heldMessageResult = undefined; });
    await page.getByRole("button", { name: "Refresh conversation", exact: true }).click();
    await page.waitForFunction(() => window.__heldMessageResult);
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: window.__heldMessageResult })));
    assert.equal(new URL(page.url()).pathname, "/", "A late transcript read cannot reopen an old conversation");
    assert.equal(await composer.inputValue(), "Separate new chat draft");
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.locator(".cli-session-row-select").filter({ hasText: "Evaluate stack" }).click();
    await composer.fill("Original long-running turn");
    await page.evaluate(() => { window.__holdNextSend = true; window.__heldSendResult = undefined; });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.waitForFunction(() => window.__heldSendResult);
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await composer.fill("Keep this new draft");
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: window.__heldSendResult })));
    await page.getByText("Codex completed the turn in the original chat.", { exact: true }).first().waitFor();
    assert.equal(new URL(page.url()).pathname, "/", "A completed turn cannot pull the user back to its conversation");
    assert.equal(await composer.inputValue(), "Keep this new draft");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("New Codex chat is ready.", { exact: true }).first().waitFor();
    await page.waitForFunction(() => document.querySelector('textarea[name="codex-message"]')?.value === "");
    assert.equal(new URL(page.url()).pathname, "/01a04882-d037-7a42-ad24-9afb61901198", "A new-session acknowledgement opens the accepted thread without requiring another list/catalog payload");
    assert.equal(await composer.inputValue(), "", "A newly accepted chat clears only its submitted project draft");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 2, `Chat overflows by ${overflow}px at ${width}px`);
    await page.screenshot({ path: path.join(output, `chat-${width}x${height}.png`) });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:host-status", stage: "unreachable" } })));
    await page.getByText("Dashboard host unavailable", { exact: true }).waitFor();
    const banner = await page.locator(".dashboard-connection-banner").boundingBox();
    assert.ok(banner && banner.x >= width - banner.width - 24 && banner.y + banner.height >= height - 24, "Connection notice sits bottom-right");
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:host-status", stage: "live" } })));
    console.log(`Checking ${width}x${height}: dashboard and settings`);
    await page.goto(`${origin}/dash`);
    await page.locator("#settingsOpenButton").click();
    await page.locator(".overlay.open").waitFor();
    for (const tab of await page.locator(".settings-tab").all()) {
      await tab.click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2), "Settings overflow");
    }
    assert.equal(await page.locator('[data-setting-key="backgroundTokenRefreshEnabled"]').count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".overlay.open").count(), 0, "Escape closes Settings");
    assert.deepEqual(errors, [], "Browser runtime errors");
    await page.screenshot({ path: path.join(output, `dashboard-${width}x${height}.png`) });
    results.push({ width, height, checks: "parent list, running icon, chat, live messages, Agent tabs, share, session menu, Environment, Files, Reviews, quote, attachment, failed send, settings" });
    await context.close();
  }
} finally { await browser.close(); }
console.log(JSON.stringify({ results, screenshots: output }, null, 2));
