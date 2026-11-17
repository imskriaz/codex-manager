#!/usr/bin/env node
/* Install, compile, and restart the standalone host without opening VS Code. */
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const port = Number(process.env.CODEX_MANAGER_PORT ?? 39875);
const args = process.argv.slice(2);
const dataDirArg = args.indexOf("--data-dir");
const configArg = args.indexOf("--config");
const dataDir = path.resolve(dataDirArg >= 0 && args[dataDirArg + 1] ? args[dataDirArg + 1] : process.env.CODEX_MANAGER_STORAGE_ROOT ?? path.join(os.homedir(), ".codex"));
const configPath = path.resolve(configArg >= 0 && args[configArg + 1] ? args[configArg + 1] : path.join(dataDir, "always-online-relay.json"));

if (args.includes("--help")) {
  console.log("Usage: npm run standalone:update -- [--data-dir <path>] [--config <path>]");
  console.log("Installs dependencies, compiles, gracefully restarts the standalone host, and exits.");
  process.exit(0);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
}

function readConfig() {
  try {
    const text = fs.readFileSync(configPath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.name !== "SyntaxError") throw error;
  }
  const databasePath = path.join(path.dirname(configPath), "manager.sqlite");
  if (!fs.existsSync(databasePath)) return undefined;
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 250");
    const record = database.prepare("SELECT value FROM state WHERE namespace = ? AND key = ?").get("files", path.basename(configPath));
    return record ? JSON.parse(record.value).text && JSON.parse(JSON.parse(record.value).text) : undefined;
  } finally {
    database.close();
  }
}

function requestShutdown(adminToken) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/shutdown", method: "POST", headers: { "X-Codex-Admin": String(adminToken) }, timeout: 2_000 }, response => {
      response.resume();
      response.once("end", () => response.statusCode === 200 ? resolve() : reject(new Error(`Standalone shutdown returned HTTP ${response.statusCode}.`)));
    });
    request.once("error", error => error.code === "ECONNREFUSED" ? resolve() : reject(error));
    request.once("timeout", () => { request.destroy(new Error("Standalone shutdown timed out.")); });
    request.end();
  });
}

function portIsOpen() {
  return new Promise(resolve => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(true); });
  });
}

async function waitForPortRelease() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await portIsOpen())) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Standalone host still owns 127.0.0.1:${port} after shutdown.`);
}

async function main() {
  run(npm, ["install"]);
  run(npm, ["run", "compile"]);

  const config = readConfig();
  if (config?.adminToken) {
    await requestShutdown(config.adminToken);
    await waitForPortRelease();
  }

  const startArgs = [path.join(root, "tools", "start-node.cjs"), "--background"];
  if (fs.existsSync(configPath) || fs.existsSync(path.join(path.dirname(configPath), "manager.sqlite"))) startArgs.push("--config", configPath);
  else startArgs.push("--data-dir", dataDir);
  run(process.execPath, startArgs);
  console.log(`Standalone Codex Manager updated and running at http://127.0.0.1:${port}.`);
}

main().catch(error => {
  console.error(`Standalone update failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
