#!/usr/bin/env node
const path = require("node:path");
const fileSystem = require("node:fs");
const Module = require("node:module");

const args = process.argv.slice(2);
let configPath;

function startupLog(message, error) {
  if (!configPath) return;
  try {
    const logPath = path.join(path.dirname(configPath), "always-online-relay-startup.log");
    const detail = error ? ` ${error instanceof Error ? error.stack || error.message : String(error)}` : "";
    fileSystem.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}${detail}\n`, { encoding: "utf8" });
  } catch {
    // Diagnostics must never prevent the host from starting.
  }
}

if (args[0] === "mcp") {
  void import(require('node:url').pathToFileURL(path.join(__dirname, 'codex-manager-mcp.mjs')).href).catch(error => {
    console.error(`MCP startup failed: ${error.message}`);
    process.exitCode = 1;
  });
  return;
}

function waitForStorage(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readConfigText(databasePath, configPath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const fileSystem = require("node:fs");
      if (fileSystem.existsSync(databasePath)) {
        const { DatabaseSync } = require("node:sqlite");
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          database.exec("PRAGMA busy_timeout = 250");
          const record = database.prepare("SELECT value FROM state WHERE namespace = ? AND key = ?").get("files", path.basename(configPath));
          if (record) return JSON.parse(record.value).text;
        } finally { database.close(); }
        if (!fileSystem.existsSync(configPath)) {
          const missing = new Error("Node host configuration is not committed yet.");
          missing.code = "SQLITE_BUSY";
          throw missing;
        }
      }
      return fileSystem.readFileSync(configPath, "utf8");
    } catch (error) {
      const code = error?.code;
      if (!/SQLITE_BUSY|SQLITE_LOCKED|EAGAIN|EACCES|EPERM|EIO/.test(`${code ?? ""} ${error?.message ?? ""}`) || attempt === 4) throw error;
      waitForStorage(250 * (attempt + 1));
    }
  }
  throw new Error("Node host configuration could not be read.");
}

for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === "--data-dir" && args[index + 1]) process.env.CODEX_MANAGER_STORAGE_ROOT = path.resolve(args[++index]);
  else if (value === "--port" && args[index + 1]) process.env.CODEX_MANAGER_PORT = args[++index];
  else if (value === "--host" && args[index + 1]) process.env.CODEX_MANAGER_HOST = args[++index];
  else if (value === "--admin-token" && args[index + 1]) process.env.CODEX_MANAGER_ADMIN_TOKEN = args[++index];
  else if (value === "--pid-file" && args[index + 1]) process.env.CODEX_MANAGER_PID_FILE = path.resolve(args[++index]);
  else if (value === "--config" && args[index + 1]) configPath = path.resolve(args[++index]);
}
if (!configPath && args[0] && !args[0].startsWith("--")) configPath = path.resolve(args[0]);

// Direct launches retain credentials for later authenticated standalone restarts.
if (!configPath && !process.env.CODEX_MANAGER_ADMIN_TOKEN) {
  const storage = process.env.CODEX_MANAGER_STORAGE_ROOT || path.join(require('node:os').homedir(), '.codex');
  configPath = path.join(storage, 'always-online-relay.json');
  require('./standalone-config.cjs').createConfig(configPath, {
    port: Number(process.env.CODEX_MANAGER_PORT || 39875)
  });
}

if (configPath) {
  startupLog("Node host process started");
  const databasePath = path.join(path.dirname(configPath), "manager.sqlite");
  try {
    const config = JSON.parse(readConfigText(databasePath, configPath));
    if (!process.env.CODEX_MANAGER_STORAGE_ROOT) process.env.CODEX_MANAGER_STORAGE_ROOT = path.dirname(configPath);
    // A boot task runs as SYSTEM, so os.homedir() would otherwise resolve to
    // the SYSTEM profile instead of the user's Codex home. Keep the detached
    // host pointed at the same account data that created the configuration.
    if (!process.env.CODEX_HOME) process.env.CODEX_HOME = path.dirname(configPath);
    if (!process.env.CODEX_MANAGER_PORT && Number.isInteger(config.port)) process.env.CODEX_MANAGER_PORT = String(config.port);
    if (!process.env.CODEX_MANAGER_ADMIN_TOKEN && config.adminToken) process.env.CODEX_MANAGER_ADMIN_TOKEN = String(config.adminToken);
    if (!process.env.CODEX_MANAGER_PID_FILE && config.pidPath) process.env.CODEX_MANAGER_PID_FILE = path.resolve(String(config.pidPath));
    if (config.workspaceStoragePath) process.env.CODEX_MANAGER_WORKSPACE_STORAGE = String(config.workspaceStoragePath);
    if (config.mode === "node") process.env.CODEX_MANAGER_HANDOFF = "1";
    startupLog("Node host configuration loaded");
  } catch (error) {
    startupLog("Node host configuration could not be read", error);
    console.error(`[codexManager] Node host config could not be read: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (args.includes("--background")) {
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, [__filename, ...args.filter(value => value !== "--background")], {
    detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env
  });
  let ready = false;
  let startupError;
  const timer = setTimeout(() => {
    console.error("Codex Manager background startup timed out. Run without --background to inspect the failure.");
    child.kill();
    process.exitCode = 1;
  }, 15_000);
  child.once("error", error => { clearTimeout(timer); console.error(`Background startup failed: ${error.message}`); process.exitCode = 1; });
  child.once("exit", code => {
    clearTimeout(timer);
    if (!ready) { console.error(`Background host exited before becoming ready (${code}). ${startupError || 'Run without --background for details.'}`); process.exitCode = 1; }
  });
  child.on("message", message => {
    if (message?.type === 'codex-manager-startup-error') { startupError = message.error; return; }
    if (message?.type !== "codex-manager-ready" || ready) return;
    ready = true;
    clearTimeout(timer);
    console.log(`Codex Manager running in background at ${message.url} (PID ${child.pid}).`);
    child.disconnect();
    child.unref();
  });
  return;
}

const shim = path.join(__dirname, "node-vscode-shim");
process.env.NODE_PATH = [shim, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const entry = path.join(__dirname, "..", "out", "node.js");
try {
  const host = require(entry);
  if (typeof host.startNodeHost !== "function") throw new Error("The compiled Node host does not export startNodeHost().");
  void host.startNodeHost().catch(error => {
    startupLog("Node host failed", error);
    console.error(`[codexManager] Node host failed: ${error instanceof Error ? error.message : String(error)}`);
    if (process.connected) process.send({ type: 'codex-manager-startup-error', error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
} catch (error) {
  console.error("Codex Manager Node host is not built. Run `npm run compile` first.");
  throw error;
}
