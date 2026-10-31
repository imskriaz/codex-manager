import { chromium } from "playwright";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { useWorkspaceDashboardAssets } from "./workspace-dashboard-assets.mjs";

// Explicit opt-in: uses disposable sessions/files/repository, never existing
// accounts or session mutations. API setup goes through the real browser bridge.
assert.ok(process.argv.includes("--mutate"), "Pass --mutate to authorize disposable live action checks.");
const origin = process.env.CODEX_MANAGER_UI_URL || "http://127.0.0.1:39875";
const output = path.join(tmpdir(), "codex-manager-live-actions");
await mkdir(output, { recursive: true });
// Keep the disposable repository in its own nested project under the opened
// workspace; the host accepts it as a workspace child while it stays separate
// from the codex-manager source tree and its files.
const fixture = await mkdtemp(path.resolve("output", "live-actions-project-"));
const project = path.join(fixture, "project");
const remote = path.join(fixture, "remote.git");
await mkdir(project);
const git = (...args) => execFileSync("git", args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "--initial-branch=main");
git("config", "user.name", "UI Check");
git("config", "user.email", "ui-check@example.invalid");
git("config", "core.autocrlf", "false");
git("init", "--bare", remote);
git("remote", "add", "origin", remote);
await writeFile(path.join(project, "editable.txt"), "original\n");
await writeFile(path.join(project, "delete-me.txt"), "disposable\n");
await writeFile(path.join(project, "README.md"), "# Disposable preview\n\nBrowser Markdown check.\n");
await writeFile(path.join(project, "test-image.png"), await readFile("media/product-icons/codex-openai.png"));
git("add", "--all");
git("commit", "-m", "Initial disposable fixture");
git("push", "-u", "origin", "main");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.addInitScript(() => {
  window.__liveEvents = [];
  window.__dropStartAcknowledgment = false;
  window.__droppedStartAcknowledgment = undefined;
  window.addEventListener("message", event => {
    if (window.__dropStartAcknowledgment && event.data?.type === "dashboard:action-result" && event.data.action === "startCodexCliSession") {
      window.__dropStartAcknowledgment = false;
      window.__droppedStartAcknowledgment = event.data;
      event.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener("message", event => {
    if (event.data?.type?.startsWith("dashboard:")) window.__liveEvents.push(event.data);
  });
});
if (process.argv.includes("--workspace-assets")) {
  await useWorkspaceDashboardAssets(page, origin);
}
const results = [];
const owned = new Set();
const record = async (name, operation) => {
  const started = Date.now();
  try {
    await operation();
    results.push({ name, status: "passed", durationMs: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: "failed", error: error.message, durationMs: Date.now() - started });
    console.log(`FAIL ${name}: ${error.message}`);
    const file = name.replace(/[^a-z0-9]+/gi, "-");
    await page.screenshot({ path: path.join(output, `failed-${file}.png`) }).catch(() => {});
    await writeFile(path.join(output, `failed-${file}.json`), JSON.stringify(await page.evaluate(() => ({ url: location.href, title: document.querySelector(".cli-conversation-title h1")?.textContent, unavailable: document.querySelector(".cli-composer-unavailable")?.textContent, events: window.__liveEvents.filter(event => event.action !== 'listCodexCliSessions').slice(-50) })).catch(() => ({})), null, 2));
  }
};
const action = async (name, payload = {}, expected = "completed", requestId = randomUUID()) => {
  const offset = await page.evaluate(() => window.__liveEvents.length);
  await page.evaluate(message => window.acquireVsCodeApi().postMessage(message), { type: "dashboard:action", action: name, requestId, payload });
  await page.waitForFunction(({ requestId, offset }) => window.__liveEvents.slice(offset).some(event => event.type === "dashboard:action-result" && event.requestId === requestId), { requestId, offset }, { timeout: 95_000 });
  const result = await page.evaluate(({ requestId, offset }) => window.__liveEvents.slice(offset).find(event => event.type === "dashboard:action-result" && event.requestId === requestId), { requestId, offset });
  assert.equal(result.status, expected, result.error || `${name} must reach ${expected}`);
  return result;
};
const postAction = async (name, payload = {}, requestId = randomUUID()) => {
  await page.evaluate(message => window.acquireVsCodeApi().postMessage(message), { type: "dashboard:action", action: name, requestId, payload });
  return requestId;
};
const clickAction = async (name, click) => {
  const offset = await page.evaluate(() => window.__liveEvents.length);
  await click();
  await page.waitForFunction(({ name, offset }) => window.__liveEvents.slice(offset).some(event => event.type === "dashboard:action-result" && event.action === name), { name, offset }, { timeout: 95_000 });
  const result = await page.evaluate(({ name, offset }) => window.__liveEvents.slice(offset).find(event => event.type === "dashboard:action-result" && event.action === name), { name, offset });
  assert.equal(result.status, "completed", result.error || `${name} must complete`);
  return result;
};
const menu = async name => {
  await page.getByRole("button", { name: "Session actions", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
};
const open = async id => {
  await page.goto(`${origin}/workspace/${id}`);
  await page.waitForFunction(id => window.__liveEvents.some(event => event.type === "dashboard:action-result" && event.action === "getCodexCliSessionMessages" && event.status === "completed" && event.payload?.cliSession?.id === id), id, { timeout: 95_000 });
  const session = await page.evaluate(id => window.__liveEvents.find(event => event.action === "getCodexCliSessionMessages" && event.status === "completed" && event.payload?.cliSession?.id === id).payload.cliSession, id);
  await page.waitForFunction(session => document.querySelector('.cli-conversation-title h1')?.textContent === session.title && (!session.projectPath || document.querySelector('.cli-conversation-project')?.getAttribute('title') === session.projectPath), session);
};
const waitIdle = async id => {
  await page.waitForFunction(id => ["completed", "cancelled", "failed"].includes(window.__liveEvents.filter(event => event.type === "dashboard:codex-session-live" && event.state?.sessionId === id).at(-1)?.state.status), id, { timeout: 120_000 });
};
const addTool = async name => {
  const tab = page.getByRole("tab", { name, exact: true });
  if (await tab.count()) return tab.click();
  const showTools = page.getByRole("button", { name: "Show workspace tools", exact: true });
  if (await showTools.count()) await showTools.click();
  await page.getByRole("button", { name: "Add workspace tool", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
};
let terminalId;
try {
  await page.goto(`${origin}/workspace`);
  const list = await action("listCodexCliSessions");
  const projects = list.payload.cliComposerConfig.projects;
  assert.ok(projects.length, "The live host must have an open workspace");
  let stale;
  for (const candidate of list.payload.cliSessions) {
    if (candidate.archived || candidate.subAgent || candidate.remote || !candidate.projectPath || projects.some(project => path.resolve(project.path).toLowerCase() === path.resolve(candidate.projectPath).toLowerCase())) continue;
    try {
      await stat(candidate.projectPath);
      stale = candidate;
      break;
    } catch {
      // Ignore disposable sessions whose fixture directory was already removed.
    }
  }
  if (!stale) {
    const createdOutside = await action("startCodexCliSession", { projectPath: project, text: "Reply exactly LIVE OUTSIDE OK. Do not run tools or modify files.", sandboxMode: "workspace-write" });
    stale = createdOutside.payload.cliSession;
    owned.add(stale.id);
    await waitIdle(stale.id);
  }
  await record("desktop new chat from a session outside the open workspace", async () => {
    assert.ok(stale, "The real outside-workspace session could not be created");
    await open(stale.id);
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Message Codex", exact: true }).fill("Reply exactly LIVE DESKTOP OK. Do not run tools or modify files.");
    const created = await clickAction("startCodexCliSession", () => page.getByRole("button", { name: "Send message", exact: true }).click());
    owned.add(created.payload.cliSession.id);
    assert.equal(path.resolve(created.payload.cliSession.projectPath).toLowerCase(), path.resolve(stale.projectPath).toLowerCase(), "New chat retains the selected session's project");
    await page.locator(".cli-session-message.is-assistant").filter({ hasText: "LIVE DESKTOP OK" }).waitFor({ timeout: 120_000 });
    await waitIdle(created.payload.cliSession.id);
  });
  await record("mobile new chat and first response", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Message Codex", exact: true }).fill("Reply exactly LIVE MOBILE OK. Do not run tools or modify files.");
    const created = await clickAction("startCodexCliSession", () => page.getByRole("button", { name: "Send message", exact: true }).click());
    owned.add(created.payload.cliSession.id);
    await page.locator(".cli-session-message.is-assistant").filter({ hasText: "LIVE MOBILE OK" }).waitFor({ timeout: 120_000 });
    await waitIdle(created.payload.cliSession.id);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    assert.ok((await page.locator(".cli-conversation-header").boundingBox()).height <= 48, "Mobile header stays compact");
    await page.screenshot({ path: path.join(output, "mobile.png") });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await record("reload after a real accepted send with its acknowledgment lost", async () => {
    await page.goto(`${origin}/workspace`);
    await page.evaluate(() => { window.__dropStartAcknowledgment = true; });
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    const prompt = "Reply exactly LIVE ACK OK. Do not run tools or modify files.";
    await page.getByRole("textbox", { name: "Message Codex", exact: true }).fill(prompt);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const deadline = Date.now() + 95_000;
    let lostAcknowledgment = await page.evaluate(() => window.__droppedStartAcknowledgment);
    while (!lostAcknowledgment && Date.now() < deadline) {
      await page.waitForTimeout(100);
      lostAcknowledgment = await page.evaluate(() => window.__droppedStartAcknowledgment);
    }
    if (lostAcknowledgment?.payload?.cliSession?.id) owned.add(lostAcknowledgment.payload.cliSession.id);
    assert.equal(lostAcknowledgment?.status, "completed", lostAcknowledgment?.error || "The real host must accept the send before its acknowledgment is dropped");
    await page.reload();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    const draft = page.getByRole("textbox", { name: "Message Codex", exact: true });
    await draft.waitFor();
    await page.waitForFunction(prompt => document.querySelector('textarea[aria-label="Message Codex"]')?.value === prompt, prompt);
    assert.equal(await draft.inputValue(), prompt, "An unacknowledged send keeps its draft after reload");
    const sessions = (await action("listCodexCliSessions")).payload.cliSessions;
    assert.equal(sessions.filter(session => session.id === lostAcknowledgment.payload.cliSession.id).length, 1);
    assert.equal(await page.evaluate(() => window.__liveEvents.filter(event => event.type === "dashboard:action-result" && event.action === "startCodexCliSession").length), 0, "Reload must not resend an uncertain prompt");
  });
  const created = await action("startCodexCliSession", { projectPath: project, text: "Reply exactly LIVE FIXTURE OK. Do not run tools or modify files.", sandboxMode: "workspace-write" });
  const sessionId = created.payload.cliSession.id;
  owned.add(sessionId);
  await waitIdle(sessionId);
  await open(sessionId);
  await record("rename and refreshed title", async () => {
    await menu("Rename");
    await page.getByRole("textbox", { name: "Session name", exact: true }).fill("Disposable live action check");
    const renamed = await clickAction("renameCodexCliSession", () => page.locator(".cli-rename-form").getByRole("button", { name: "Save", exact: true }).click());
    assert.equal(renamed.payload?.cliSession?.title, "Disposable live action check");
    await page.reload();
    await page.locator(".cli-conversation-title h1").waitFor();
    assert.equal(await page.locator(".cli-conversation-title h1").textContent(), "Disposable live action check");
  });
  await record("follow-up response and completed running state", async () => {
    await page.getByRole("textbox", { name: "Message Codex", exact: true }).fill("Reply exactly LIVE FOLLOWUP OK. Do not run tools or modify files.");
    await clickAction("sendCodexCliSessionMessage", () => page.getByRole("button", { name: "Send message", exact: true }).click());
    await page.locator(".cli-session-message.is-assistant").filter({ hasText: "LIVE FOLLOWUP OK" }).waitFor({ timeout: 120_000 });
    await waitIdle(sessionId);
    const sessions = (await action("listCodexCliSessions")).payload.cliSessions;
    assert.notEqual(sessions.find(session => session.id === sessionId)?.status, "running");
    await page.locator(".cli-conversation-title [aria-label='Ready']").waitFor();
  });
  await record("live turn steering fence and Stop", async () => {
    const liveEventOffset = await page.evaluate(() => window.__liveEvents.length);
    await postAction("sendCodexCliSessionMessage", { sessionId, projectPath: project, targetDeviceId: undefined, text: "Run the Node.js command node -e \"setTimeout(() => {}, 90000)\" once, then reply DONE. Do not modify files.", sandboxMode: "workspace-write" });
    const approvalDetail = page.locator(".codex-request-detail").filter({ hasText: /setTimeout|node -e/i });
    await page.waitForFunction(() => Boolean(document.querySelector('.codex-request-detail')) || window.__liveEvents.some(event => event.type === "dashboard:codex-session-live" && event.state?.status === "running" && event.state?.turnId), undefined, { timeout: 95_000 });
    if (await approvalDetail.isVisible().catch(() => false)) {
      assert.match(await approvalDetail.innerText(), /setTimeout|node -e/i, "The visible approval belongs to this disposable turn");
      await clickAction("respondCodexServerRequest", () => page.getByRole("button", { name: "Approve once", exact: true }).click());
      await page.locator(".codex-request-backdrop").waitFor({ state: "detached" });
    }
    await page.waitForFunction(({id, offset}) => window.__liveEvents.slice(offset).some(event => event.type === "dashboard:codex-session-live" && event.state?.sessionId === id && event.state?.status === "running" && event.state?.turnId), { id: sessionId, offset: liveEventOffset }, { timeout: 95_000 });
    const live = await page.evaluate(({id, offset}) => window.__liveEvents.slice(offset).filter(event => event.type === "dashboard:codex-session-live" && event.state?.sessionId === id && event.state?.status === "running" && event.state?.turnId).at(-1)?.state, { id: sessionId, offset: liveEventOffset });
    assert.ok(live?.turnId, "The live turn exposes a turn fence before steering");
    await action("steerCodexCliSessionTurn", { sessionId, projectPath: project, targetDeviceId: undefined, expectedTurnId: "stale-turn", text: "Stale test" }, "failed");
    await action("steerCodexCliSessionTurn", { sessionId, projectPath: project, targetDeviceId: undefined, expectedTurnId: live.turnId, text: "After this command, reply LIVE STEER OK. Do not modify files." });
    await clickAction("cancelCodexCliSessionTurn", () => page.getByRole("button", { name: "Stop", exact: true }).click());
    await waitIdle(sessionId);
    const final = await page.evaluate(id => window.__liveEvents.filter(event => event.type === "dashboard:codex-session-live" && event.state.sessionId === id).at(-1).state.status, sessionId);
    assert.equal(final, "cancelled");
  });
  await record("duplicate send request creates one user message", async () => {
    const payload = { sessionId, text: "Reply exactly LIVE DUPLICATE OK. Do not run tools or modify files." };
    const requestId = randomUUID();
    await action("sendCodexCliSessionMessage", payload, "completed", requestId);
    await action("sendCodexCliSessionMessage", payload, "completed", requestId);
    await waitIdle(sessionId);
    const history = (await action("getCodexCliSessionMessages", { sessionId })).payload.cliSessionMessages;
    assert.equal(history.filter(message => message.role === "user" && message.text.includes(payload.text)).length, 1);
    await action("sendCodexCliSessionMessage", { ...payload, text: "Changed duplicate" }, "failed", requestId);
  });
  await record("disposable child agent creation and transcript", async () => {
    await action("sendCodexCliSessionMessage", { sessionId, text: "Use one sub-agent to answer exactly LIVE CHILD OK, wait for it to finish, then reply LIVE AGENT OK. Do not run shell commands or modify files." });
    await waitIdle(sessionId);
    const sessions = (await action("listCodexCliSessions")).payload.cliSessions;
    const child = sessions.find(session => session.parentSessionId === sessionId && session.subAgent);
    assert.ok(child, "The owned child agent appears with its parent metadata");
    owned.add(child.id);
    const transcript = (await action("getCodexSubAgentMessages", { sessionId: child.id })).payload.cliSubAgentMessages;
    assert.ok(transcript.some(message => message.text?.includes("LIVE CHILD OK")), "The real child transcript contains its response");
    if (await page.getByRole("button", { name: "Show workspace tools", exact: true }).count()) await page.getByRole("button", { name: "Show workspace tools", exact: true }).click();
    await addTool("Agents");
    await page.locator(".cli-agent-row").filter({ hasText: child.agentName || child.model || "Agent" }).first().click();
    await page.locator(".cli-agent-transcript").filter({ hasText: "LIVE CHILD OK" }).waitFor();
  });
  await record("disposable goal creation, completion and compact display", async () => {
    await action("sendCodexCliSessionMessage", { sessionId, text: "Create a goal with objective 'Verify a disposable dashboard goal', mark it complete, then reply LIVE GOAL OK. Do not run shell commands or modify files." });
    await waitIdle(sessionId);
    const messages = (await action("getCodexCliSessionMessages", { sessionId })).payload.cliSessionMessages;
    const goalSession = (await action("getCodexCliSessionMessages", { sessionId })).payload.cliSession;
    assert.ok(messages.some(message => /create_goal|update_goal/.test(message.title ?? "")) || goalSession.goal?.objective === "Verify a disposable dashboard goal" && goalSession.goal.status === "complete", "Goal completion is recorded in the real session state");
    await page.locator(".cli-goal-strip.is-complete").filter({ hasText: "Verify a disposable dashboard goal" }).waitFor();
  });
  await record("Files refresh, open, edit, save and disk content", async () => {
    if (await page.getByRole("button", { name: "Show workspace tools", exact: true }).count()) await page.getByRole("button", { name: "Show workspace tools", exact: true }).click();
    await addTool("Files");
    await clickAction("listWorkspaceFiles", () => page.getByRole("button", { name: "Refresh files", exact: true }).click());
    await clickAction("readWorkspaceFile", () => page.locator(".cli-file-tree").getByRole("button", { name: "editable.txt", exact: true }).click());
    await page.locator(".cm-content").fill("saved from real browser\n");
    await clickAction("saveWorkspaceFile", () => page.locator(".cli-file-editor").getByRole("button", { name: "Save", exact: true }).click());
    assert.equal(await readFile(path.join(project, "editable.txt"), "utf8"), "saved from real browser\n");
  });
  await record("file conflict preserves newer disk content", async () => {
    const file = (await action("readWorkspaceFile", { projectPath: project, filePath: "editable.txt" })).payload.workspaceFile;
    await writeFile(path.join(project, "editable.txt"), "newer external content\n");
    const failed = await action("saveWorkspaceFile", { projectPath: project, filePath: "editable.txt", fileContent: "stale draft", fileRevision: file.revision }, "failed");
    assert.match(failed.error, /changed/i);
    assert.equal(await readFile(path.join(project, "editable.txt"), "utf8"), "newer external content\n");
  });
  await record("file Delete confirmation and disk removal", async () => {
    await addTool("Files");
    await page.locator(".cli-file-tree").getByRole("button", { name: "delete-me.txt", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await clickAction("deleteWorkspaceFile", () => page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click());
    await assert.rejects(readFile(path.join(project, "delete-me.txt")), { code: "ENOENT" });
    assert.equal(await page.locator(".cli-file-tree").getByRole("button", { name: "delete-me.txt", exact: true }).count(), 0);
  });
  await record("file path escape and missing file failures", async () => {
    for (const filePath of ["../outside.txt", "missing.txt"]) await action("readWorkspaceFile", { projectPath: project, filePath }, "failed");
  });
  await record("real file image modal and Markdown preview/edit/save", async () => {
    await addTool("Files");
    await clickAction("readWorkspaceFile", () => page.locator(".cli-file-tree").getByRole("button", { name: "test-image.png", exact: true }).click());
    await page.getByRole("button", { name: "Preview test-image.png", exact: true }).click();
    await page.locator(".cli-image-lightbox").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".cli-image-lightbox").waitFor({ state: "detached" });
    await addTool("Files");
    await clickAction("readWorkspaceFile", () => page.locator(".cli-file-tree").getByRole("button", { name: "README.md", exact: true }).click());
    await page.locator(".cli-file-editor").getByRole("heading", { name: "Disposable preview", exact: true }).waitFor();
    await page.locator(".cli-file-editor").getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator(".cli-file-editor .cm-content").fill("# Edited Markdown\n");
    await clickAction("saveWorkspaceFile", () => page.locator(".cli-file-editor").getByRole("button", { name: "Save", exact: true }).click());
    assert.equal(await readFile(path.join(project, "README.md"), "utf8"), "# Edited Markdown\n");
    await page.locator(".cli-file-editor").getByRole("button", { name: "Preview", exact: true }).click();
    await page.locator(".cli-file-editor").getByRole("heading", { name: "Edited Markdown", exact: true }).waitFor();
  });
  const terminalClient = 'live-' + randomUUID();
  let terminalEpoch, terminalSequence = 0;
  const typeTerminal = data => action('workspaceTerminal', { projectPath: project, terminalId, terminalRequest: {operation:'input',clientId:terminalClient,epoch:terminalEpoch,sequence:++terminalSequence,data} });
  const waitTerminal = text => page.waitForFunction(({terminalId,text}) => window.__liveEvents.filter(event=>event.type==='dashboard:terminal-output'&&event.output.raw&&event.output.terminalId===terminalId).map(event=>event.output.chunk).join('').includes(text), {terminalId,text});
  await record('Shared terminal creation and raw streaming', async () => {
    const created = await action('workspaceTerminal', {projectPath:project,terminalProfile:'powershell',terminalRequest:{operation:'create',clientId:terminalClient,operationId:randomUUID()}});
    terminalId=created.payload.workspaceTerminal.id;terminalEpoch=created.payload.terminalSnapshot.epoch;
    await addTool('Terminal'); await page.getByRole('button',{name:'Refresh terminals',exact:true}).click();
    await page.getByRole('combobox',{name:'Select terminal',exact:true}).selectOption(terminalId);
    const claimed = await action('workspaceTerminal', { projectPath: project, terminalId, terminalRequest: { operation: 'claim', clientId: terminalClient, takeControl: true } });
    terminalEpoch = claimed.payload.terminalSnapshot.epoch;
    assert.equal(claimed.payload.terminalSnapshot.writable, true, 'The direct claim owns the disposable terminal before typing');
    await typeTerminal("node -e \"console.log('LIVE TERMINAL OK');setTimeout(()=>console.log('STREAM END'),400)\"\r");
    await waitTerminal('STREAM END');
    const restored=await action('workspaceTerminal',{projectPath:project,terminalId,terminalRequest:{operation:'read',clientId:terminalClient}});
    assert.ok(restored.payload.terminalSnapshot.content.includes('LIVE TERMINAL OK'));
  });
  await record('Shared terminal cancellation and concurrent control', async () => {
    await typeTerminal("node -e \"setInterval(()=>console.log('waiting'),500)\"\r"); await waitTerminal('waiting');
    await typeTerminal('\x03');
    const observer='observer-'+randomUUID();
    await action('workspaceTerminal',{projectPath:project,terminalId,terminalRequest:{operation:'input',clientId:observer,epoch:terminalEpoch,sequence:1,data:'echo rejected\r'}},'failed');
    await action('workspaceTerminal',{projectPath:project,terminalId,terminalRequest:{operation:'claim',clientId:observer,takeControl:true}});
    await action('workspaceTerminal',{projectPath:project,terminalId,terminalRequest:{operation:'input',clientId:terminalClient,epoch:terminalEpoch,sequence:terminalSequence+1,data:'echo rejected\r'}},'failed');
    await action('workspaceTerminal',{projectPath:project,terminalId,terminalRequest:{operation:'claim',clientId:terminalClient,takeControl:true}});
  });
  await record('Shared terminal reload screen recovery', async () => {
    await page.reload(); await page.getByRole('textbox',{name:'Message Codex',exact:true}).waitFor(); await addTool('Terminal');
    await page.locator('.workspace-xterm .xterm-screen').waitFor();
    const restored=await action('workspaceTerminal',{projectPath:project,terminalId,terminalRequest:{operation:'read',clientId:terminalClient}});
    assert.ok(restored.payload.terminalSnapshot.content.includes('STREAM END'));
  });
  await record("Git Environment, commit and local-remote push", async () => {
    if(await page.getByRole("button",{name:"Show workspace tools",exact:true}).count()) await page.getByRole("button",{name:"Show workspace tools",exact:true}).click();
    await addTool("Env");
    const inspected = await clickAction("getWorkspaceEnvironment", () => page.getByRole("button", { name: "Refresh Environment", exact: true }).click());
    assert.ok(inspected.payload.workspaceEnvironment, "The environment panel returned a real repository state");
    const scopedEnvironment = await action("getWorkspaceEnvironment", { projectPath: project });
    assert.equal(path.resolve(scopedEnvironment.payload.workspaceEnvironment.projectPath).toLowerCase(), path.resolve(project).toLowerCase(), "Only commit the disposable repository");
    await writeFile(path.join(project, "editable.txt"), "newer external content\n");
    await addTool("Git");
    const gitRead = await action('workspaceGit', { projectPath: project, gitRequest: { operation: 'read' } });
    const gitRevision = gitRead.payload.workspaceGit.revision;
    await action('workspaceGit', { projectPath: project, gitRequest: { operation: 'stage', operationId: randomUUID(), revision: gitRevision }, confirmed: true });
    const compared=await action('workspaceGit',{projectPath:project,gitRequest:{operation:'diff',staged:true,revision:gitRevision}});
    assert.ok(compared.payload.workspaceGit.diff.includes('+newer external content'));
    await clickAction('workspaceGit', () => page.getByRole('button', { name: 'Refresh Git', exact: true }).click());
    await page.getByRole('textbox',{name:'Commit message',exact:true}).fill('Verified disposable browser changes');
    await clickAction('workspaceGit',()=>page.getByRole('button',{name:/^Commit staged/}).click());
    assert.equal(git('status','--porcelain'),'');
    await page.getByRole('button',{name:'Repository actions',exact:true}).click();
    await page.getByRole('button',{name:'Push branch',exact:true}).click();
    await clickAction('workspaceGit',()=>page.getByRole('dialog').getByRole('button',{name:'Confirm',exact:true}).click());
    assert.equal(git('rev-parse','HEAD'),git('rev-parse','origin/main'));
    const gitMutation = async (operation, fields = {}) => {
      const current = await action('workspaceGit', { projectPath: project, gitRequest: { operation: 'read' } });
      return action('workspaceGit', { projectPath: project, gitRequest: { operation, operationId: randomUUID(), revision: current.payload.workspaceGit.revision, ...fields }, confirmed: true });
    };
    await gitMutation('createBranch', { name: 'feature/ops-check' });
    await writeFile(path.join(project, 'branch-ops.txt'), 'branch operation\n');
    await gitMutation('stage');
    await gitMutation('commit', { message: 'Verify branch operations', staged: true });
    await gitMutation('switch', { ref: 'main' });
    await gitMutation('merge', { ref: 'feature/ops-check' });
    await gitMutation('deleteBranch', { ref: 'feature/ops-check' });
    assert.equal(git('branch', '--list', 'feature/ops-check'), '');
    await gitMutation('createBranch', { name: 'rename-source' });
    await gitMutation('renameBranch', { ref: 'rename-source', name: 'rename-target' });
    await gitMutation('switch', { ref: 'main' });
    await gitMutation('deleteBranch', { ref: 'rename-target' });
    await writeFile(path.join(project, 'stash-check.txt'), 'stash operation\n');
    const stashed = await gitMutation('stash', { message: 'Verify stash operations' });
    const stash = stashed.payload.workspaceGit.stashes[0];
    assert.ok(stash?.hash, 'The disposable repository returned a real stash');
    await gitMutation('applyStash', { ref: stash.hash });
    assert.equal(await readFile(path.join(project, 'stash-check.txt'), 'utf8'), 'stash operation\n');
    await gitMutation('dropStash', { ref: stash.hash });
    await writeFile(path.join(project, 'editable.txt'), 'discard operation\n');
    await gitMutation('discard', { path: 'editable.txt' });
    assert.equal(await readFile(path.join(project, 'editable.txt'), 'utf8'), 'newer external content\n');
    await writeFile(path.join(project, 'unstage.txt'), 'unstage operation\n');
    await gitMutation('stage');
    await gitMutation('unstage', { path: 'unstage.txt' });
    await rm(path.join(project, 'unstage.txt'), { force: true });
    await rm(path.join(project, 'stash-check.txt'), { force: true });
    await gitMutation('fetch');
    await gitMutation('pull');
    await gitMutation('push');
    assert.equal(git('rev-parse','HEAD'),git('rev-parse','origin/main'));
    await page.getByRole("button", { name: "Hide workspace tools", exact: true }).click();
  });
  await record("Reviews and Agents states and tool tabs", async () => {
    await addTool("Reviews");
    if (await page.getByRole("button", { name: "Show turn changes", exact: true }).count()) await page.getByRole("button", { name: "Show turn changes", exact: true }).click();
    await page.locator(".cli-reviews-view").waitFor();
    await addTool("Agents");
    if (await page.locator(".cli-agent-row").count() === 0) await page.getByText("No sub-agents recorded for this session.", { exact: true }).waitFor();
    for (const name of ["Files", "Terminal", "Reviews", "Agents"]) await addTool(name);
  });
  await record("Fork, archive, restore, delete and refreshed list", async () => {
    const fork = await action("forkCodexCliSession", { sessionId });
    const forkId = fork.payload.cliSession.id;
    owned.add(forkId);
    assert.notEqual(forkId, sessionId);
    await action("getCodexCliSessionMessages", { sessionId: forkId });
    await action("archiveCodexCliSession", { sessionId: forkId });
    let sessions = (await action("listCodexCliSessions")).payload.cliSessions;
    assert.equal(sessions.find(session => session.id === forkId)?.archived, true);
    await action("unarchiveCodexCliSession", { sessionId: forkId });
    await action("deleteCodexCliSession", { sessionId: forkId, confirmed: true });
    owned.delete(forkId);
    sessions = (await action("listCodexCliSessions")).payload.cliSessions;
    assert.equal(sessions.some(session => session.id === forkId), false);
  });
  await record("offline/reconnect recovery without runtime errors", async () => {
    await context.setOffline(true);
    await page.waitForFunction(() => window.__liveEvents.filter(event => event.type === "dashboard:connection").at(-1)?.connected === false, null, { timeout: 45_000 });
    await context.setOffline(false);
    await page.waitForFunction(() => window.__liveEvents.filter(event => event.type === "dashboard:connection").at(-1)?.connected === true);
    await page.reload();
    await action("listCodexCliSessions");
    assert.deepEqual(errors, []);
  });
  await record("live account filter counts, search, card/table views and quota metrics", async () => {
    await page.goto(`${origin}/`);
    await page.locator(".header-count-link").first().waitFor();
    await page.locator('input[name="account-search"]').fill("");
    for (const filter of await page.locator(".header-count-link").all()) {
      const expected = Number((await filter.innerText()).match(/\d+/)?.[0]);
      assert.ok(Number.isFinite(expected), "Each filter exposes its count");
      await filter.click();
      await page.waitForFunction(expected => document.querySelectorAll(".accounts-grid .saved-card-container, .accounts-grid .saved-table-row").length === expected, expected);
    }
    await page.locator(".header-count-link").first().click();
    const count = await page.locator(".accounts-grid .saved-card-container, .accounts-grid .saved-table-row").count();
    await page.locator(".dashboard-view-toggle").click();
    assert.equal(await page.locator(".accounts-grid .saved-card-container, .accounts-grid .saved-table-row").count(), count);
    await page.locator(".dashboard-view-toggle").click();
    const metric = page.locator(".metric-priority-control select");
    const initialMetric = await metric.inputValue();
    try {
      for (const option of await page.locator(".metric-priority-control option").all()) await metric.selectOption(await option.getAttribute("value"));
    } finally { await metric.selectOption(initialMetric); }
    await page.locator('input[name="account-search"]').fill("no-such-account-ui-check");
    await page.locator(".accounts-empty-filter").waitFor();
    assert.equal(await page.locator(".accounts-grid .saved-card-container, .accounts-grid .saved-table-row").count(), 0);
    await page.locator('input[name="account-search"]').fill("");
    await page.screenshot({ path: path.join(output, "accounts.png") });
  });
} finally {
  for (const sessionId of owned) {
    await record("cleanup disposable session", async () => {
      const sessions = (await action("listCodexCliSessions")).payload.cliSessions;
      const session = sessions.find(session => session.id === sessionId);
      if (!session) return;
      if (session.canStop) {
        await action("cancelCodexCliSessionTurn", { sessionId });
        await waitIdle(sessionId);
      }
      await action("deleteCodexCliSession", { sessionId, confirmed: true });
    });
  }
  if (terminalId) await record('cleanup disposable terminal', async () => {
    const state=await action('workspaceTerminal',{projectPath:project,terminalId,terminalRequest:{operation:'read',clientId:'cleanup-'+randomUUID()}});
    await action('workspaceTerminal',{projectPath:project,terminalId,terminalRequest:{operation:'close',clientId:'cleanup-'+randomUUID(),epoch:state.payload.terminalSnapshot.epoch}});
  });
  await browser.close();
  // The only recursive removal is the exact directory returned by mkdtemp.
  await rm(fixture, { recursive: true, force: true });
  await writeFile(path.join(output, "results.json"), JSON.stringify({ results, externalRequirements: ["No remote peer connected", "OAuth/account switching and host restart require an isolated host"] }, null, 2));
  console.log(`Results: ${path.join(output, "results.json")}`);
}
assert.equal(results.filter(result => result.status === "failed").length, 0, "Live action failures; inspect results.json");
