#!/usr/bin/env node
const path = require("node:path");
const Module = require("node:module");

const args = process.argv.slice(2);
let configPath;

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

if (configPath) {
  const databasePath = path.join(path.dirname(configPath), "manager.sqlite");
  try {
    const config = JSON.parse(readConfigText(databasePath, configPath));
    if (!process.env.CODEX_MANAGER_STORAGE_ROOT) process.env.CODEX_MANAGER_STORAGE_ROOT = path.dirname(configPath);
    if (!process.env.CODEX_MANAGER_PORT && Number.isInteger(config.port)) process.env.CODEX_MANAGER_PORT = String(config.port);
    if (!process.env.CODEX_MANAGER_ADMIN_TOKEN && config.adminToken) process.env.CODEX_MANAGER_ADMIN_TOKEN = String(config.adminToken);
    if (!process.env.CODEX_MANAGER_PID_FILE && config.pidPath) process.env.CODEX_MANAGER_PID_FILE = path.resolve(String(config.pidPath));
  } catch (error) {
    console.error(`[codexManager] Node host config could not be read: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const shim = path.join(__dirname, "node-vscode-shim");
process.env.NODE_PATH = [shim, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const entry = path.join(__dirname, "..", "out", "node.js");
try {
  const host = require(entry);
  if (typeof host.startNodeHost !== "function") throw new Error("The compiled Node host does not export startNodeHost().");
  void host.startNodeHost().catch(error => {
    console.error(`[codexManager] Node host failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
} catch (error) {
  console.error("Codex Manager Node host is not built. Run `npm run compile` first.");
  throw error;
}
