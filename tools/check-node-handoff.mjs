import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

// Disposable storage and port: never stop the user's running dashboard.
const root = await mkdtemp(path.join(os.tmpdir(), "manager-node-handoff-"));
const project = path.resolve(import.meta.dirname, "..");
process.env.CODEX_MANAGER_STORAGE_ROOT = root;
process.env.CODEX_HOME = root;
process.env.NODE_PATH = path.join(project, "tools", "node-vscode-shim");
const require = createRequire(import.meta.url);
require("node:module").Module._initPaths();
const { SqliteStateStore, configureSqliteStateStore, writeSqliteStateFile, readSqliteStateFile } = require("../out/storage/sqliteState.js");
const { DashboardAuth, DASHBOARD_PASSPHRASE_KEY } = require("../out/services/dashboardAuth.js");
const { configureCrossWindowOperationCoordinator } = require("../out/utils/crossWindowOperations.js");
const store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
configureSqliteStateStore(store);
await configureCrossWindowOperationCoordinator(root);
const password = randomBytes(24).toString("hex");
const legacyToken = randomBytes(32).toString("hex");
const { createHash } = require("node:crypto");
const secrets = new Map([
  [DASHBOARD_PASSPHRASE_KEY, password],
  ["codexManager.webDashboard.sessions.v1", JSON.stringify([{ fingerprint: createHash("sha256").update(legacyToken).digest("hex"), expiresAt: Date.now() + 60_000 }])]
]);
const auth = new DashboardAuth({ get: async key => secrets.get(key) }, {});
await auth.refresh();
const placeholder = net.createServer(socket => socket.destroy());
await new Promise(resolve => placeholder.listen(0, "127.0.0.1", resolve));
const port = placeholder.address().port;
const origin = `http://127.0.0.1:${port}`;
const pidPath = path.join(root, "always-online-relay.pid");
const configPath = path.join(root, "always-online-relay.json");
const adminToken = randomBytes(32).toString("hex");
writeSqliteStateFile(configPath, JSON.stringify({ mode: "node", port, pidPath, adminToken, workspaceStoragePath: root }));
store.set(`settings:${createHash("sha256").update(root).digest("hex")}`, "cloudflaredDomain", "https://dashboard.example");
const children = new Set();
function launch(args) {
  const child = spawn(process.execPath, [path.join(project, "tools", "start-node.cjs"), ...args], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: process.env
  });
  children.add(child);
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => { children.delete(child); resolve({ code, output }); });
  });
  return { child, done };
}
async function ready() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${origin}/login`, { signal: AbortSignal.timeout(1_000) })).status === 200) return; }
    catch { /* Port handoff is expected until the owner releases it. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Standalone did not become ready.");
}
const remote = (url, options = {}) => fetch(`${origin}${url}`, {
  ...options, redirect: "manual", signal: AbortSignal.timeout(5_000),
  headers: { host: "dashboard.example", "x-forwarded-proto": "https", ...options.headers }
});
async function stop() {
  await fetch(`${origin}/shutdown`, { method: "POST", headers: { "X-Codex-Admin": adminToken }, signal: AbortSignal.timeout(2_000) });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { readSqliteStateFile(pidPath); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Standalone did not release its SQLite PID.");
}
const timings = {};
try {
  const started = performance.now();
  const first = launch(["--config", configPath]);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(first.child.exitCode, null, "handoff must wait while the old owner holds the port");
  await new Promise(resolve => placeholder.close(resolve));
  await ready();
  timings.handoffReadyMs = Math.round(performance.now() - started);
  assert.equal(readSqliteStateFile(pidPath), String(first.child.pid));
  let response = await remote("/api/state", { headers: { cookie: `codex_dashboard_session=${legacyToken}` } });
  assert.equal(response.status, 200, "existing browser login must survive VS Code -> Node");
  response = await remote("/login");
  assert.ok((await response.text()).includes('type="password"'), "standalone must show the password form");
  response = await remote("/login", { method: "POST", body: "password=wrong", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(response.status, 401);
  const loginStarted = performance.now();
  response = await remote("/login", { method: "POST", body: new URLSearchParams({ password }), headers: { "content-type": "application/x-www-form-urlencoded" } });
  timings.loginMs = Math.round(performance.now() - loginStarted);
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal((await remote("/api/state", { headers: { cookie } })).status, 200);
  const competing = await launch(["--data-dir", root, "--port", String(port)]).done;
  assert.equal(competing.code, 1, "a competing host must fail");
  assert.match(competing.output, /already owned by another host/);
  assert.equal(readSqliteStateFile(pidPath), String(first.child.pid), "competing launch must not remove the owner's PID");
  await stop();
  assert.equal((await first.done).code, 0);
  const background = await launch(["--background", "--config", configPath]).done;
  assert.equal(background.code, 0, background.output);
  assert.match(background.output, /running in background/);
  await ready();
  assert.equal((await remote("/api/state", { headers: { cookie } })).status, 200, "login must survive background restart");
  const logout = await remote("/logout", { method: "POST", headers: { cookie, origin: "https://dashboard.example" } });
  assert.equal(logout.status, 303);
  await auth.refresh();
  assert.ok(!JSON.parse(await auth.readSessions()).some(session => session.fingerprint === createHash("sha256").update(cookie.split("=")[1]).digest("hex")), "VS Code must see Node logout");
  assert.equal((await remote("/api/state", { headers: { cookie } })).status, 401);
  await stop();
  console.log(JSON.stringify({ passed: true, checks: ["handoff", "same-password", "existing-cookie", "fresh-login", "wrong-password", "exclusive-port-owner", "sqlite-pid", "hidden-background", "restart-cookie", "shared-logout"], timings }));
} finally {
  if (placeholder.listening) await new Promise(resolve => placeholder.close(resolve));
  try { await stop(); } catch { /* The host may already be stopped or not yet started. */ }
  for (const child of children) child.kill();
  await Promise.allSettled([...children].map(child => new Promise(resolve => child.once("exit", resolve))));
  configureSqliteStateStore(undefined);
  store.close();
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(root, { recursive: true, force: true });
}
