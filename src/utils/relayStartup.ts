import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

const REGISTRY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE = "CodexManagerAlwaysOnline";
const TASK = "CodexManagerAlwaysOnline";
const LAUNCHER = "always-online-relay-start.cmd";

type CommandError = NodeJS.ErrnoException & { code?: number | string };

function command(executable: string, args: string[], timeout = 5_000): Promise<void> {
  return new Promise((resolve, reject) => execFile(executable, args, { windowsHide: true, timeout }, error => error ? reject(error instanceof Error ? error : new Error(`${executable} failed.`)) : resolve()));
}

function legacyLauncher(): string | undefined {
  const appData = process.env["APPDATA"];
  return appData ? path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CodexManagerAlwaysOnline.cmd") : undefined;
}

function launcherPath(configPath: string): string {
  return path.join(path.dirname(configPath), LAUNCHER);
}

function batchLiteral(value: string): string {
  return value.replaceAll("%", "%%");
}

async function removeLegacyLauncher(): Promise<void> {
  const file = legacyLauncher();
  if (file) await fs.unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

async function removeLegacyRegistryEntry(): Promise<void> {
  try { await command("reg.exe", ["query", REGISTRY, "/v", VALUE], 2_000); }
  catch (error) {
    if (String((error as CommandError).code) === "1") return;
    throw error;
  }
  await command("reg.exe", ["delete", REGISTRY, "/v", VALUE, "/f"], 2_000);
}

async function removeBootTask(): Promise<void> {
  try { await command("schtasks.exe", ["/Query", "/TN", TASK], 3_000); }
  catch (error) {
    if (String((error as CommandError).code) === "1") return;
    throw error;
  }
  await command("schtasks.exe", ["/Delete", "/TN", TASK, "/F"], 3_000);
}

async function writeBootLauncher(configPath: string, scriptPath: string, executable: string): Promise<string> {
  const file = launcherPath(configPath);
  const log = path.join(path.dirname(configPath), "always-online-relay-startup.log");
  const content = [
    "@echo off",
    "set \"ELECTRON_RUN_AS_NODE=1\"",
    `set \"CODEX_MANAGER_STARTUP_LOG=${batchLiteral(log)}\"`,
    `>>\"${batchLiteral(log)}\" echo [%date% %time%] Windows boot task triggered`,
    `start \"\" /b \"${batchLiteral(executable)}\" \"${batchLiteral(scriptPath)}\" \"${batchLiteral(configPath)}\"`,
    `>>\"${batchLiteral(log)}\" echo [%date% %time%] Node host launch requested`,
    ""
  ].join("\r\n");
  await fs.writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  return file;
}

export async function resolveNodeExecutable(): Promise<string> {
  for (const candidate of [...new Set([process.env["NODE"], process.env["NODE_EXE"], "node", process.execPath].filter((value): value is string => !!value))]) {
    const executable = await new Promise<string | undefined>(resolve => execFile(candidate, ["-p", "JSON.stringify({version:process.versions.node,executable:process.execPath})"], {
      windowsHide: true, timeout: 1_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      try {
        const result = JSON.parse(String(stdout)) as { version: string; executable: string };
        const version = /^(\d+)\.(\d+)\./.exec(result.version);
        resolve(version && typeof result.executable === "string" && path.isAbsolute(result.executable) &&
          (Number(version[1]) > 22 || Number(version[1]) === 22 && Number(version[2]) >= 13) ? result.executable : undefined);
      } catch { resolve(undefined); }
    }));
    if (executable) return executable;
  }
  throw new Error("Always Active requires Node.js 22.13 or newer, or a compatible VS Code runtime.");
}

/** Register a pre-login Windows boot task. The task runs as SYSTEM so it does
 * not depend on an interactive account session being present. */
export async function installRelayStartup(configPath: string, scriptPath: string, executable = process.execPath, enabled = true): Promise<void> {
  if (process.platform !== "win32") return;
  if (!enabled) {
    await removeRelayStartup();
    return;
  }
  const launcher = await writeBootLauncher(configPath, scriptPath, executable);
  const taskAction = `cmd.exe /d /c \"\\\"${launcher}\\\"\"`;
  await command("schtasks.exe", ["/Create", "/TN", TASK, "/SC", "ONSTART", "/RU", "SYSTEM", "/RL", "HIGHEST", "/TR", taskAction, "/F"]);
  // Confirm the scheduler accepted the task before removing older login-only
  // registrations. This also leaves a useful failure in the persistent log.
  await command("schtasks.exe", ["/Query", "/TN", TASK], 3_000);
  await removeLegacyRegistryEntry();
  await removeLegacyLauncher();
}

export async function removeRelayStartup(): Promise<void> {
  if (process.platform !== "win32") return;
  await removeBootTask();
  await removeLegacyRegistryEntry();
  await removeLegacyLauncher();
}

export async function migrateRelayStartup(storageRoot: string, extensionRoot: string): Promise<void> {
  if (process.platform !== "win32") return;
  const file = legacyLauncher();
  const exists = file && await fs.stat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (exists) await installRelayStartup(path.join(storageRoot, "always-online-relay.json"), path.join(extensionRoot, "tools", "start-node.cjs"));
}
