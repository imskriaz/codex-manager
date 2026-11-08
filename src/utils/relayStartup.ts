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

export async function installRelayStartup(configPath: string, scriptPath: string, executable = process.execPath): Promise<void> {
  if (process.platform !== "win32") return;
  const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const script = `$env:ELECTRON_RUN_AS_NODE='1'; Start-Process -WindowStyle Hidden -FilePath ${literal(executable)} -ArgumentList ${literal(`"${scriptPath}" "${configPath}"`)}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const command = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`;
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
