import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { getSqliteStateStore } from "../storage/sqliteState";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { resolveNodeExecutable } from "../utils/relayStartup";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";
import { recordPersistentEvent } from "../utils/persistentLog";

export function bundledCodexCli(extensionRoot: string, platform = process.platform, arch = process.arch): string {
  const directory = platform === "win32" ? arch === "arm64" ? "windows-arm64" : "windows-x86_64"
    : platform === "darwin" ? arch === "arm64" ? "macos-aarch64" : "macos-x86_64"
      : arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
  return path.join(extensionRoot, "bin", directory, platform === "win32" ? "codex.exe" : "codex");
}

export async function discoverBundledCodexCli(roots = [
  process.env["VSCODE_EXTENSIONS"],
  process.env["VSCODE_PORTABLE"] ? path.join(process.env["VSCODE_PORTABLE"], "extensions") : undefined,
  path.resolve(__dirname, "../../.."),
  ...[".vscode", ".vscode-insiders", ".vscode-server", ".vscode-server-insiders"].map(directory => path.join(os.homedir(), directory, "extensions"))
].filter((root): root is string => Boolean(root))): Promise<string[]> {
  const candidates: string[] = [];
  for (const root of new Set(roots)) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code ?? "")) return [];
      throw error;
    });
    for (const entry of entries.filter(entry => entry.isDirectory() && /^openai\.chatgpt-\d/i.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))) {
      candidates.push(bundledCodexCli(path.join(root, entry.name)));
    }
  }
  return candidates;
}

export function managedCodexCli(): string | undefined {
  const root = getCodexManagerStorageRoot();
  return getSqliteStateStore()?.get("runtime", "codex-cli-ready") === true
    ? path.join(root, "runtime", "codex-cli", "node_modules", "@openai", "codex", "bin", "codex.js") : undefined;
}

function run(executable: string, args: string[], timeout: number, cwd: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => execFile(executable, args, {
    cwd, windowsHide: true, timeout, signal, maxBuffer: 128 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  }, error => error ? reject(error instanceof Error ? error : new Error("Codex CLI process failed.", { cause: error })) : resolve()));
}

// Install only for an explicit turn, never for background model/session discovery.
const installations = new Map<string, Promise<string>>();
export function installManagedCodexCli(): Promise<string> {
  const root = getCodexManagerStorageRoot();
  const pending = installations.get(root);
  if (pending) return pending;
  const installation = runCrossWindowExclusive("runtime:codex-cli-install", "Codex CLI installation", async signal => {
    const store = getSqliteStateStore();
    if (!store) throw new Error("Codex CLI installation requires the shared SQLite store.");
    const node = await resolveNodeExecutable();
    const installed = managedCodexCli();
    if (installed) {
      try { await run(node, [installed, "--version"], 10_000, root, signal); return installed; }
      catch { signal.throwIfAborted(); }
    }
    const npm = [process.env["npm_execpath"], path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js"),
      path.resolve(path.dirname(node), "../lib/node_modules/npm/bin/npm-cli.js")];
    const npmScript = (await Promise.all(npm.map(async candidate => candidate && await fs.stat(candidate).then(stat => stat.isFile()).catch(() => false) ? candidate : undefined))).find(Boolean);
    if (!npmScript) throw new Error("Codex CLI was not found. Install Node.js with npm, run npm install -g @openai/codex, or set CODEX_CLI_PATH.");
    const prefix = path.join(root, "runtime", "codex-cli");
    const script = path.join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
    await fs.mkdir(prefix, { recursive: true });
    store.set("runtime", "codex-cli-ready", undefined);
    recordPersistentEvent("info", "codex-cli", "Installing the official Codex CLI");
    try {
      await run(node, [npmScript, "install", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts", "--include=optional", "--registry=https://registry.npmjs.org", "--fetch-retries=0", "--fetch-timeout=30000", "@openai/codex"], 60_000, prefix, signal);
      await run(node, [script, "--version"], 10_000, prefix, signal);
      signal.throwIfAborted();
      store.set("runtime", "codex-cli-ready", true);
      recordPersistentEvent("info", "codex-cli", "Official Codex CLI installation completed");
      return script;
    } catch (error) {
      recordPersistentEvent("error", "codex-cli", "Official Codex CLI installation failed", undefined, error);
      throw new Error("Codex CLI could not be installed or verified. Check network access and free disk space, then retry; or install it with npm install -g @openai/codex and set CODEX_CLI_PATH.", { cause: error });
    }
  }, { waitMs: 2_000 }).finally(() => { installations.delete(root); });
  installations.set(root, installation);
  return installation;
}
