import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

assert.ok(process.argv.includes("--mutate"), "Pass --mutate for disposable real Codex turns.");
const sourceHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const root = await mkdtemp(path.join(tmpdir(), "manager-standalone-session-"));
const project = path.join(root, "project"); await mkdir(project);
const repository = path.resolve(import.meta.dirname, "..");
process.env.CODEX_MANAGER_STORAGE_ROOT = root;
process.env.NODE_PATH = path.join(repository, "tools", "node-vscode-shim");
const require = createRequire(import.meta.url);
require("node:module").Module._initPaths();
const { SqliteStateStore, configureSqliteStateStore } = require("../out/storage/sqliteState.js");
const store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
configureSqliteStateStore(store);
for (const [key, value] of Object.entries({ webDashboardEnabled: true, cliIntegrationEnabled: true, webSocketServerEnabled: false, autoResumeEnabled: false, autoSwitchEnabled: false, autoResetEnabled: false }))
  store.set("settings-overrides:global", key, value);
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const admin = randomBytes(32).toString("hex");
let child; let childDone; let output = "";
const timings = {};
async function action(name, payload = {}) {
  const started = performance.now();
  const requestId = randomUUID();
  const response = await fetch(`${origin}/api/message`, { method: "POST", signal: AbortSignal.timeout(120_000),
    headers: { "content-type": "application/json", "x-codex-dashboard": "1", origin },
    body: JSON.stringify({ type: "dashboard:action", action: name, requestId, payload }) });
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
  const result = (await response.json()).messages.find(message => message.type === "dashboard:action-result" && message.requestId === requestId);
  assert.equal(result?.status, "completed", result?.error || `${name}: missing result`);
  timings[name] = Math.round(performance.now() - started);
  return result.payload;
}
try {
  if (process.argv.includes("--install-cli")) {
    await require("../out/utils/crossWindowOperations.js").configureCrossWindowOperationCoordinator(root);
    const script = await require("../out/services/codexCliRuntime.js").installManagedCodexCli();
    store.set("settings-overrides:global", "codexCliPath", script);
  }
  // Reuse authentication without changing the user's session databases or config.
  for (const name of ["auth.json", "config.toml", "models_cache.json"]) {
    await copyFile(path.join(sourceHome, name), path.join(root, name)).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  const environment = { ...process.env, CODEX_HOME: root, CODEX_MANAGER_WORKSPACE_STORAGE: root,
    CODEX_MANAGER_PORT: String(port), CODEX_MANAGER_ADMIN_TOKEN: admin, CODEX_MANAGER_HANDOFF: "" };
  delete environment.CODEX_CLI_PATH;
  for (const key of Object.keys(environment)) if (key.toLowerCase() === "path") delete environment[key];
  environment.PATH = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32") : "/usr/bin:/bin";
  const started = performance.now();
  child = spawn(process.execPath, [path.join(repository, "tools", "start-node.cjs")], { cwd: project, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  childDone = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { if ((await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(1000) })).status === 200) break; } catch { /* Wait for startup. */ }
    if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Standalone failed to start: ${output.slice(-2000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  timings.hostReadyMs = Math.round(performance.now() - started);
  const created = await action("startCodexCliSession", { projectPath: project, text: "Reply exactly STANDALONE FIRST OK. Do not use tools or modify files.", sandboxMode: "danger-full-access", autoApprove: true });
  const sessionId = created.cliSession.id;
  const accepted = performance.now();
  let history;
  const turnDeadline = Date.now() + 120_000;
  do {
    history = await action("getCodexCliSessionMessages", { sessionId, projectPath: project });
    if (["completed", "failed", "cancelled", "disconnected"].includes(history.cliSessionLive?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  } while (Date.now() < turnDeadline);
  assert.equal(history.cliSessionLive?.status, "completed", JSON.stringify(history.cliSessionLive?.error || history.cliSessionMessages?.filter(message => message.kind === "error")));
  assert.ok(history.cliSessionMessages.some(message => message.role === "assistant" && message.text.includes("STANDALONE FIRST OK")));
  timings.firstResponseAfterAcceptMs = Math.round(performance.now() - accepted);
  await action("sendCodexCliSessionMessage", { sessionId, projectPath: project, text: "Reply exactly STANDALONE FOLLOWUP OK. Do not use tools or modify files." });
  history = await action("getCodexCliSessionMessages", { sessionId, projectPath: project });
  assert.ok(history.cliSessionMessages.some(message => message.role === "assistant" && message.text.includes("STANDALONE FOLLOWUP OK")));
  await action("archiveCodexCliSession", { sessionId });
  await action("deleteCodexCliSession", { sessionId, confirmed: true });
  assert.equal((await action("listCodexCliSessions")).cliSessions.some(session => session.id === sessionId), false);
  console.log(JSON.stringify({ passed: true, checks: ["standalone-no-cli-path", "create", "first-response", "follow-up", "archive", "delete"], timings }));
} finally {
  if (child && child.exitCode === null) {
    try { await fetch(`${origin}/shutdown`, { method: "POST", headers: { "X-Codex-Admin": admin }, signal: AbortSignal.timeout(2000) }); }
    catch { child.kill(); }
    await childDone;
  }
  configureSqliteStateStore(undefined); store.close();
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(root, { recursive: true, force: true });
}
