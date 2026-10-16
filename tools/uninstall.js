/* Remove only Codex Manager's detached relay integration on extension uninstall. */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const appData = process.env.APPDATA;
const startupLauncher = appData
  ? path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CodexManagerAlwaysOnline.cmd")
  : undefined;
const storage = path.join(os.homedir(), ".codex");

function removeFile(target) {
  if (!target) return;
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function requestRelayShutdown(config) {
  if (!config?.adminToken) return Promise.resolve();
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: 39875,
        path: "/shutdown",
        method: "POST",
        headers: { "X-Codex-Admin": String(config.adminToken) },
        timeout: 1_000
      },
      (response) => {
        response.resume();
        response.once("end", resolve);
      }
    );
    request.once("error", resolve);
    request.once("timeout", () => {
      request.destroy();
      resolve();
    });
    request.end();
  });
}

async function main() {
  // Remove the boot trigger first, so a failed best-effort shutdown cannot
  // resurrect the relay at the next Windows sign-in.
  removeFile(startupLauncher);
  if (process.platform === "win32") {
    const { execFileSync } = require("node:child_process");
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    try {
      execFileSync("reg.exe", ["query", key, "/v", "CodexManagerAlwaysOnline"], { windowsHide: true, timeout: 1_000, stdio: "pipe" });
    } catch (error) {
      if (error.status !== 1) throw error;
      return stopRelay();
    }
    execFileSync("reg.exe", ["delete", key, "/v", "CodexManagerAlwaysOnline", "/f"], { windowsHide: true, timeout: 1_000, stdio: "pipe" });
  }
  return stopRelay();
}

async function stopRelay() {
  let config;
  const configPath = path.join(storage, "always-online-relay.json");
  const databasePath = path.join(storage, "manager.sqlite");
  try {
    let raw;
    if (fs.existsSync(databasePath)) {
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const record = database.prepare("SELECT value FROM state WHERE namespace = ? AND key = ?").get("files", path.basename(configPath));
        if (record) raw = JSON.parse(record.value).text;
      } finally { database.close(); }
    }
    if (raw === null) return;
    config = JSON.parse(raw === undefined ? fs.readFileSync(configPath, "utf8") : raw);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return;
  }
  await requestRelayShutdown(config);
}

main().catch((error) => {
  console.error(`[codex-manager] uninstall cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
