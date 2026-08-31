/* Remove only Codex Manager's detached relay integration on extension uninstall. */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const appData = process.env.APPDATA;
const startupLauncher = appData
  ? path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CodexManagerAlwaysOnline.cmd")
  : undefined;
const storage = appData
  ? path.join(appData, "Code", "User", "globalStorage", "imskriaz.codex-manager")
  : undefined;

function removeFile(target) {
  if (!target) return;
  try { fs.unlinkSync(target); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function requestRelayShutdown(config) {
  if (!config?.adminToken) return Promise.resolve();
  return new Promise((resolve) => {
    const request = http.request({
      host: "127.0.0.1",
      port: 39875,
      path: "/shutdown",
      method: "POST",
      headers: { "X-Codex-Admin": String(config.adminToken) },
      timeout: 1_000
    }, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.once("error", resolve);
    request.once("timeout", () => { request.destroy(); resolve(); });
    request.end();
  });
}

async function main() {
  // Remove the boot trigger first, so a failed best-effort shutdown cannot
  // resurrect the relay at the next Windows sign-in.
  removeFile(startupLauncher);
  if (!storage) return;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(storage, "always-online-relay.json"), "utf8"));
  } catch {
    return;
  }
  await requestRelayShutdown(config);
}

main().catch((error) => {
  console.error(`[codex-manager] uninstall cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
