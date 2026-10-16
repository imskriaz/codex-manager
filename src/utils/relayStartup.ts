import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

const REGISTRY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE = "CodexManagerAlwaysOnline";

function reg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile("reg.exe", args, { windowsHide: true, timeout: 2_000 }, error => error ? reject(error instanceof Error ? error : new Error("Windows startup registry operation failed.")) : resolve()));
}

function legacyLauncher(): string | undefined {
  const appData = process.env["APPDATA"];
  return appData ? path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CodexManagerAlwaysOnline.cmd") : undefined;
}

async function removeLegacyLauncher(): Promise<void> {
  const file = legacyLauncher();
  if (file) await fs.unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

export async function installRelayStartup(configPath: string, scriptPath: string): Promise<void> {
  if (process.platform !== "win32") return;
  const command = `"${process.env["ComSpec"] ?? "cmd.exe"}" /d /c "set ELECTRON_RUN_AS_NODE=1&&"${process.execPath}" "${scriptPath}" "${configPath}""`;
  await reg(["add", REGISTRY, "/v", VALUE, "/t", "REG_SZ", "/d", command, "/f"]);
  await removeLegacyLauncher();
}

export async function removeRelayStartup(): Promise<void> {
  if (process.platform !== "win32") return;
  try { await reg(["query", REGISTRY, "/v", VALUE]); }
  catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
    await removeLegacyLauncher();
    return;
  }
  await reg(["delete", REGISTRY, "/v", VALUE, "/f"]);
  await removeLegacyLauncher();
}

export async function migrateRelayStartup(storageRoot: string, extensionRoot: string): Promise<void> {
  if (process.platform !== "win32") return;
  const file = legacyLauncher();
  const exists = file && await fs.stat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (exists) await installRelayStartup(path.join(storageRoot, "always-online-relay.json"), path.join(extensionRoot, "tools", "always-online-server.js"));
}
