import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";

assert.ok(process.argv.includes("--mutate"), "Pass --mutate for disposable browser and AI action checks.");
const sourceHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
for (const key of Object.keys(process.env)) if (key.startsWith("CODEX_MANAGER_")) delete process.env[key];
const root = await mkdtemp(path.join(tmpdir(), "manager-standalone-features-"));
const repository = path.resolve(import.meta.dirname, "..");
process.env.CODEX_MANAGER_STORAGE_ROOT = root;
process.env.NODE_PATH = path.join(repository, "tools", "node-vscode-shim");
const require = createRequire(import.meta.url); require("node:module").Module._initPaths();
const { SqliteStateStore, configureSqliteStateStore } = require("../out/storage/sqliteState.js");
const store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
for (const [key, value] of Object.entries({ webDashboardEnabled: true, cliIntegrationEnabled: true, apiAccessEnabled: true, autoResumeEnabled: false, autoSwitchEnabled: false, autoResetEnabled: false, autoRefreshMinutes: 0, autoRefreshCurrentMinutes: 0, encryptedSyncEnabled: false }))
  store.set("settings-overrides:global", key, value);
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`, admin = randomBytes(32).toString("hex");
let host, hostDone;
function run(script, args, environment, cwd) {
  const child = spawn(process.execPath, [path.join(repository, "tools", script), ...args], { env: environment, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => process.stdout.write(chunk)); child.stderr.on("data", chunk => process.stderr.write(chunk));
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { child, done };
}
try {
  for (const name of ["auth.json", "config.toml", "models_cache.json"]) await copyFile(path.join(sourceHome, name), path.join(root, name)).catch(error => { if (error.code !== "ENOENT") throw error; });
  const auth = JSON.parse(await readFile(path.join(root, 'auth.json'), 'utf8'));
  if (auth.tokens) auth.tokens.refresh_token = "";
  await writeFile(path.join(root, 'auth.json'), JSON.stringify(auth));
  await require("../out/utils/crossWindowOperations.js").configureCrossWindowOperationCoordinator(root);
  const cli = await require("../out/services/codexCliRuntime.js").installManagedCodexCli();
  store.set("settings-overrides:global", "codexCliPath", cli);
  const environment = { ...process.env, CODEX_HOME: root, CODEX_MANAGER_PORT: String(port), CODEX_MANAGER_WORKSPACE_STORAGE: root, CODEX_MANAGER_ADMIN_TOKEN: admin, CODEX_MANAGER_HANDOFF: "", CODEX_MANAGER_UI_URL: origin };
  delete environment.CODEX_CLI_PATH;
  await mkdir(path.join(root, "workspace"));
  ({ child: host, done: hostDone } = run("start-node.cjs", [], environment, path.join(root, "workspace")));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(origin + "/api/state", { signal: AbortSignal.timeout(1000) })).status === 200) break; } catch { /* Wait for the disposable host. */ }
    if (host.exitCode !== null || Date.now() > deadline) throw new Error("Standalone fixture did not become ready.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const action = async (name, payload = {}) => {
    const requestId = randomBytes(16).toString("hex");
    const response = await fetch(`${origin}/api/message`, { method: "POST", headers: { "content-type": "application/json", "x-codex-dashboard": "1", origin }, body: JSON.stringify({ type: "dashboard:action", action: name, requestId, payload, ...(payload.accountId ? { accountId: payload.accountId } : {}) }), signal: AbortSignal.timeout(120_000) });
    assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
    const result = (await response.json()).messages.find(message => message.type === "dashboard:action-result" && message.requestId === requestId);
    assert.equal(result?.status, "completed", result?.error || `${name}: missing result`);
    return result.payload;
  };
  if (process.argv.includes('--restart-recovery')) {
    store.set('settings-overrides:global', 'autoResumeEnabled', true);
    store.set('settings-overrides:global', 'autoSwitchEnabled', true);
    const created = await action('startCodexCliSession', { projectPath: path.join(root, 'workspace'), sandboxMode: 'danger-full-access', autoApprove: true,
      text: 'This is a disposable restart test. Run node -e "setTimeout(()=>{},30000)" exactly once. After it finishes or is interrupted, reply exactly RESTART RECOVERY OK. If you receive Continue if not completed, do not repeat the command; just reply RESTART RECOVERY OK. Do not create goals or change files.' });
    const sessionId = created.cliSession.id;
    const deadline = Date.now() + 90_000;
    while (true) {
      const history = await action('getCodexCliSessionMessages', { sessionId });
      if ([...history.cliSessionMessages, ...(history.cliSessionLive?.messages ?? [])].some(message => message.role !== 'user' && message.kind === 'command' && /setTimeout/.test(JSON.stringify(message)))) break;
      assert.ok(Date.now() < deadline, 'Restart fixture did not start its command');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    // Remove the fixture's prior periodic snapshot to exercise the final shutdown save.
    const namespace = 'workspace:' + createHash('sha256').update(require('vscode').Uri.file(root).fsPath).digest('hex');
    for (const key of ['codexManager.autoResumeSessionIds', 'codexManager.autoResumeOpenSessionIds']) store.set(namespace, key, []);
    await fetch(origin + '/shutdown', { method: 'POST', headers: { 'X-Codex-Admin': admin }, signal: AbortSignal.timeout(3000) });
    assert.equal(await hostDone, 0, 'Standalone shutdown completed');
    assert.ok(['codexManager.autoResumeSessionIds', 'codexManager.autoResumeOpenSessionIds'].some(key => store.get(namespace, key)?.includes(sessionId)), 'Final shutdown captured the active session');
    console.log('PASS graceful shutdown saved active work with an empty prior snapshot');
    ({ child: host, done: hostDone } = run('start-node.cjs', [], environment, path.join(root, 'workspace')));
    const restartDeadline = Date.now() + 120_000;
    for (;;) {
      try {
        const history = await action('getCodexCliSessionMessages', { sessionId });
        if (history.cliSessionLive?.status === 'completed' && history.cliSessionMessages.some(message => message.role === 'assistant' && message.text.includes('RESTART RECOVERY OK'))) {
          assert.ok(history.cliSessionMessages.filter(message => message.role === 'user' && message.text.trim() === 'Continue if not completed').length <= 1, 'Recovery sent at most one continuation');
          break;
        }
      } catch (error) { if (host.exitCode !== null) throw error; }
      assert.ok(Date.now() < restartDeadline, 'Session did not complete after standalone restart');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    await action('archiveCodexCliSession', { sessionId });
    await action('deleteCodexCliSession', { sessionId, confirmed: true });
    assert.ok(!(await action('listCodexCliSessions')).cliSessions.some(session => session.id === sessionId));
    console.log('PASS restarted standalone continued, archived and deleted its test session');
  } else {
  const taskProject = path.join(root, "workspace");
  await action('importCurrent');
  console.log('PASS standalone current account import');
  const taskId = "standalone-play-check";
  const saved = await action("saveProjectTask", { projectPath: taskProject, task: { id: taskId, title: "Standalone play", prompt: "Reply exactly STANDALONE PLAY OK. Do not use tools or modify files.", stage: "planned", expectedRevision: 0 } });
  const started = await action("startProjectTask", { projectPath: taskProject, taskId, taskRevision: saved.projectBoard.tasks.find(task => task.id === taskId)?.revision });
  const taskSessionId = started.projectBoard.tasks.find(task => task.parentTaskId === taskId)?.sessionId;
  assert.ok(taskSessionId, "Standalone task play must create a session");
  const turnDeadline = Date.now() + 120_000;
  for (;;) {
    const history = await action('getCodexCliSessionMessages', { sessionId: taskSessionId });
    if (['completed', 'failed', 'cancelled', 'disconnected'].includes(history.cliSessionLive?.status)) {
      assert.equal(history.cliSessionLive.status, 'completed', history.cliSessionLive.error);
      assert.ok(history.cliSessionMessages.some(message => message.role === 'assistant' && message.text.includes('STANDALONE PLAY OK')));
      break;
    }
    assert.ok(Date.now() < turnDeadline, 'Standalone task Play response timed out.');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  console.log('PASS standalone project-task Play and first response');
  await action("deleteCodexCliSession", { sessionId: taskSessionId, confirmed: true });
  const state = await (await fetch(`${origin}/api/state`)).json();
  const active = state.accounts.find(account => account.isActive);
  assert.ok(active, "Standalone host exposes an active account");
  await action('refresh', { accountId: active.id });
  console.log('PASS standalone manual quota refresh');
  const switched = await action("switch", { accountId: active.id });
  assert.match(switched.notice?.message ?? "", /already active|Switched to/i, "Standalone account switch must complete without a VS Code reload");
  const reloaded = await action('reloadPrompt', { forceReload: true });
  assert.equal(reloaded.reloadScheduled, false);
  assert.equal((await (await fetch(`${origin}/api/state`)).json()).accounts.find(account => account.isActive)?.id, active.id);
  console.log('PASS standalone account switch and Reload state refresh');
  const result = await run("check-live-actions.mjs", ["--mutate"], environment, repository).done;
  assert.equal(result, 0, "Standalone browser feature checks failed.");
  console.log(JSON.stringify({ passed: true, host: "standalone", cli: "fresh-managed-install", vsCodeRequired: false }));
  }
} finally {
  if (host && host.exitCode === null) {
    try { await fetch(origin + "/shutdown", { method: "POST", headers: { "X-Codex-Admin": admin }, signal: AbortSignal.timeout(3000) }); } catch { host.kill(); }
    await hostDone;
  }
  configureSqliteStateStore(undefined); store.close();
  assert.ok(root.startsWith(tmpdir() + path.sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
