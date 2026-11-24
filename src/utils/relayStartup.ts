import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { getCodexManagerStorageRoot } from "./storageRoot";

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

function loginLauncher(): string | undefined {
  return legacyLauncher()?.replace(/\.cmd$/, ".vbs");
}

function launcherPath(configPath: string): string {
  return path.join(path.dirname(configPath), LAUNCHER);
}

function batchLiteral(value: string): string {
  return value.replaceAll("%", "%%");
}

async function removeLegacyLauncher(): Promise<void> {
  for (const file of [legacyLauncher(), loginLauncher()]) {
    if (file) await fs.unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
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

async function writeBootLauncher(configPath: string, scriptPath: string, executable: string, destination = launcherPath(configPath)): Promise<string> {
  const file = destination;
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
  const deadline = Date.now() + 5_000;
  const systemNodes = process.platform === "win32" ? await new Promise<string[]>(resolve => {
    execFile("where.exe", ["node"], { windowsHide: true, timeout: 1_000 }, (error, stdout) => {
      resolve(error ? [] : String(stdout).split(/\r?\n/).map(value => value.trim()).filter(value => path.isAbsolute(value)));
    });
  }) : [];
  const failures: string[] = [];
  for (const candidate of [...new Set([process.env["NODE"], process.env["NODE_EXE"], ...systemNodes, "node", process.execPath].filter((value): value is string => !!value))]) {
    const timeout = Math.min(1_000, deadline - Date.now());
    if (timeout <= 0) { failures.push("Runtime discovery exceeded its 5 second deadline"); break; }
    const executable = await new Promise<string | undefined>(resolve => execFile(candidate, ["-p", "JSON.stringify({version:process.versions.node,executable:process.execPath})"], {
      windowsHide: true, timeout, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    }, (error, stdout) => {
      if (error) { failures.push(`${candidate}: ${error.killed ? "probe timed out" : error.code ?? error.message}`); resolve(undefined); return; }
      try {
        const result = JSON.parse(String(stdout)) as { version: string; executable: string };
        const version = /^(\d+)\.(\d+)\./.exec(result.version);
        resolve(version && typeof result.executable === "string" && path.isAbsolute(result.executable) &&
          (Number(version[1]) > 22 || Number(version[1]) === 22 && Number(version[2]) >= 13) ? result.executable : undefined);
      } catch { resolve(undefined); }
    }));
    if (executable) return executable;
  }
  throw new Error(`Always Active could not verify Node.js 22.13 or newer from PATH or the VS Code runtime. ${failures.join("; ")}`);
}

/** Register a pre-login Windows boot task. The task runs as SYSTEM so it does
 * not depend on an interactive account session being present. */
export async function installRelayStartup(configPath: string, scriptPath: string, executable = process.execPath, enabled = true): Promise<void> {
  if (process.platform !== "win32") return;
  if (!enabled) {
    await removeRelayStartup(configPath);
    return;
  }
  const launcher = await writeBootLauncher(configPath, scriptPath, executable);
  const taskAction = `cmd.exe /d /s /c ""${launcher}""`;
  let schedulerRegistered = true;
  let usingLegacyLauncher = false;
  try {
    await command("schtasks.exe", ["/Create", "/TN", TASK, "/SC", "ONSTART", "/RU", "SYSTEM", "/RL", "HIGHEST", "/TR", taskAction, "/F"]);
  } catch (error) {
    // A non-admin desktop can still keep the host alive across login. Use the
    // current user's logon task when Windows refuses the pre-login SYSTEM task.
    try {
      await command("schtasks.exe", ["/Create", "/TN", TASK, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", taskAction, "/F"]);
    } catch {
      // Some managed Windows profiles disallow task creation entirely. The
      // user's Startup folder is the last verified, non-admin fallback.
      const loginFile = loginLauncher();
      if (!loginFile) throw error;
      const invocation = [executable, scriptPath, configPath].map(value => `"${value}"`).join(" ");
      const content = `Set shell = CreateObject("WScript.Shell")\r\nshell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"\r\nshell.Run "${invocation.replaceAll('"', '""')}", 0, False\r\n`;
      await fs.writeFile(loginFile, content, { encoding: "utf8", mode: 0o600 }).catch(() => { throw error; });
      const oldLoginFile = legacyLauncher();
      if (oldLoginFile) await fs.unlink(oldLoginFile).catch((unlinkError: NodeJS.ErrnoException) => { if (unlinkError.code !== "ENOENT") throw unlinkError; });
      schedulerRegistered = false;
      usingLegacyLauncher = true;
    }
  }
  // Confirm the scheduler accepted the task before removing older login-only
  // registrations. This also leaves a useful failure in the persistent log.
  if (schedulerRegistered) await command("schtasks.exe", ["/Query", "/TN", TASK], 3_000);
  else {
    const loginFile = loginLauncher();
    if (!loginFile || !(await fs.stat(loginFile).catch(() => undefined))?.isFile()) throw new Error("The per-user Windows startup launcher could not be verified.");
  }
  await removeLegacyRegistryEntry();
  if (!usingLegacyLauncher) await removeLegacyLauncher();
}

export async function removeRelayStartup(configPath = path.join(getCodexManagerStorageRoot(), "always-online-relay.json")): Promise<void> {
  if (process.platform !== "win32") return;
  await removeBootTask();
  await removeLegacyRegistryEntry();
  await removeLegacyLauncher();
  await fs.unlink(launcherPath(configPath)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

export async function migrateRelayStartup(storageRoot: string, extensionRoot: string): Promise<void> {
  if (process.platform !== "win32") return;
  for (const file of [legacyLauncher(), loginLauncher()]) {
    const exists = file && await fs.stat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (exists) {
      await installRelayStartup(path.join(storageRoot, "always-online-relay.json"), path.join(extensionRoot, "tools", "start-node.cjs"));
      return;
    }
  }
}
