/* Remove only Codex Manager's detached relay integration on extension uninstall. */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const appData = process.env.APPDATA;
const startupLauncher = appData
  ? path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CodexManagerAlwaysOnline.cmd")
  : undefined;
const storage = process.env.CODEX_MANAGER_STORAGE_ROOT?.trim()
  ? path.resolve(process.env.CODEX_MANAGER_STORAGE_ROOT.trim()) : path.join(os.homedir(), ".codex");

function hasReplacementInstallation() {
  const extensionRoot = path.resolve(__dirname, "..");
  const extensionsRoot = path.dirname(extensionRoot);
  let entries;
  try { entries = JSON.parse(fs.readFileSync(path.join(extensionsRoot, "extensions.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!Array.isArray(entries)) throw new Error("Extension registration could not be verified; shared host cleanup was skipped.");
  return entries.some(entry => {
    if (entry.identifier?.id?.toLowerCase() !== "imskriaz.codex-manager") return false;
    const registeredPath = entry.relativeLocation
      ? path.resolve(extensionsRoot, entry.relativeLocation)
      : entry.location?.scheme === "file" && entry.location.path?.replace(/^\/([a-zA-Z]:[\\/])/, "$1");
    if (!registeredPath) throw new Error("Registered Manager installation path is unavailable; shared host cleanup was skipped.");
    const candidate = path.resolve(registeredPath);
    const same = process.platform === "win32" ? candidate.toLowerCase() === extensionRoot.toLowerCase() : candidate === extensionRoot;
    return !same && fs.existsSync(path.join(candidate, "package.json"));
  });
}

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
  const port = Number(config.port ?? 39875);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Saved host port is invalid; shutdown was skipped.');
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/shutdown",
        method: "POST",
        headers: { "X-Codex-Admin": String(config.adminToken), "X-Codex-Shutdown-Reason": "extension-uninstall" },
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
  // VS Code also runs this hook while deleting superseded extension versions.
  if (hasReplacementInstallation()) {
    console.log("[codex-manager] A replacement extension is installed; preserving the shared standalone host and startup settings.");
    return;
  }
  // Remove the boot trigger first, so a failed best-effort shutdown cannot
  // resurrect the relay at the next Windows sign-in.
  removeFile(startupLauncher);
  removeFile(startupLauncher?.replace(/\.cmd$/, ".vbs"));
  removeFile(path.join(storage, "always-online-relay-start.cmd"));
  if (process.platform === "win32") {
    const { execFileSync } = require("node:child_process");
    let bootTaskExists = true;
    try { execFileSync("schtasks.exe", ["/Query", "/TN", "CodexManagerAlwaysOnline"], { windowsHide: true, timeout: 3_000, stdio: "pipe" }); }
    catch (error) { if (error.status !== 1) throw error; bootTaskExists = false; }
    if (bootTaskExists) execFileSync("schtasks.exe", ["/Delete", "/TN", "CodexManagerAlwaysOnline", "/F"], { windowsHide: true, timeout: 3_000, stdio: "pipe" });
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
