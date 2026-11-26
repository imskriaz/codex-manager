import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createRequire } from "node:module";
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

export function managedClaudeCli(): string | undefined {
  return getSqliteStateStore()?.get('runtime', 'claude-cli-ready') === true
    ? path.join(getCodexManagerStorageRoot(), 'runtime', 'claude-cli', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : undefined;
}

/** The npm wrapper spawns its native child without windowsHide on Windows. */
export async function resolveCodexNpmBinary(script: string): Promise<string> {
  if (process.platform !== 'win32' || path.basename(script).toLowerCase() !== 'codex.js') return script;
  const root = path.dirname(path.dirname(script));
  const manifest = await fs.readFile(path.join(root, 'package.json'), 'utf8').then(text => JSON.parse(text) as {name?: string}).catch(() => undefined);
  if (manifest?.name !== '@openai/codex') return script;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const target = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`;
  const vendorRoots = [path.join(root, 'vendor')];
  try { vendorRoots.unshift(path.join(path.dirname(createRequire(path.resolve(script)).resolve(`@openai/codex-win32-${arch}/package.json`)), 'vendor')); }
  catch { /* Older CLI packages bundle vendor files directly. */ }
  for (const vendor of vendorRoots) {
    for (const directory of ['bin', 'codex']) {
      const binary = path.join(vendor, target, directory, 'codex.exe');
      if (await fs.stat(binary).then(stat => stat.isFile()).catch(() => false)) return binary;
    }
  }
  throw new Error('The installed Codex npm package has no native Windows executable. Reinstall @openai/codex before retrying.');
}

async function run(executable: string, args: string[], timeout: number, cwd: string, signal?: AbortSignal): Promise<void> {
  if (args[0]?.endsWith('codex.js')) {
    const native = await resolveCodexNpmBinary(args[0]);
    if (native !== args[0]) { executable = native; args = args.slice(1); }
  }
  return new Promise((resolve, reject) => execFile(executable, args, {
    cwd, windowsHide: true, timeout, signal, maxBuffer: 128 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  }, error => error ? reject(error instanceof Error ? error : new Error("Codex CLI process failed.", { cause: error })) : resolve()));
}

// Install only from explicit module setup, never from discovery or a chat send.
const installations = new Map<string, Promise<string>>();
export function installManagedCodexCli(): Promise<string> {
  return installManagedCli('codex');
}
export function installManagedClaudeCli(): Promise<string> {
  return installManagedCli('claude');
}
function installManagedCli(provider: 'codex' | 'claude'): Promise<string> {
  const root = getCodexManagerStorageRoot();
  const key = `${root}:${provider}`, label = provider === 'codex' ? 'Codex' : 'Claude Code';
  const packageName = provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  const pending = installations.get(key);
  if (pending) return pending;
  const installation = runCrossWindowExclusive(`runtime:${provider}-cli-install`, `${label} installation`, async signal => {
    const store = getSqliteStateStore();
    if (!store) throw new Error(`${label} installation requires the shared SQLite store.`);
    const node = await resolveNodeExecutable();
    const launch = (script: string, cwd: string) => provider === 'codex' ? run(node, [script, '--version'], 10_000, cwd, signal) : run(script, ['--version'], 10_000, cwd, signal);
    const installed = provider === 'codex' ? managedCodexCli() : managedClaudeCli();
    if (installed) {
      try { await launch(installed, root); return installed; }
      catch { signal.throwIfAborted(); }
    }
    const npm = [process.env["npm_execpath"], path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js"),
      path.resolve(path.dirname(node), "../lib/node_modules/npm/bin/npm-cli.js")];
    const npmScript = (await Promise.all(npm.map(async candidate => candidate && await fs.stat(candidate).then(stat => stat.isFile()).catch(() => false) ? candidate : undefined))).find(Boolean);
    if (!npmScript) throw new Error(`Install Node.js with npm on this host, then retry or run npm install -g ${packageName}.`);
    const prefix = path.join(root, 'runtime', `${provider}-cli`);
    const packageRoot = path.join(prefix, 'node_modules', ...packageName.split('/'));
    const script = path.join(packageRoot, 'bin', provider === 'codex' ? 'codex.js' : 'claude.exe');
    await fs.mkdir(prefix, { recursive: true });
    store.set('runtime', `${provider}-cli-ready`, undefined);
    recordPersistentEvent('info', `${provider}-cli`, `Installing the official ${label} runtime`);
    try {
      await run(node, [npmScript, "install", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts", "--include=optional", "--registry=https://registry.npmjs.org", "--fetch-retries=0", "--fetch-timeout=30000", packageName], 60_000, prefix, signal);
      // The official Claude installer links its platform dependency into bin/claude.exe.
      if (provider === 'claude') await run(node, [path.join(packageRoot, 'install.cjs')], 10_000, prefix, signal);
      await launch(script, prefix);
      signal.throwIfAborted();
      store.set('runtime', `${provider}-cli-ready`, true);
      recordPersistentEvent('info', `${provider}-cli`, `Official ${label} installation completed`);
      return script;
    } catch (error) {
      recordPersistentEvent('error', `${provider}-cli`, `Official ${label} installation failed`, undefined, error);
      throw new Error(`${label} could not be installed or verified. Check network access and free disk space, then retry; or install it with npm install -g ${packageName}. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }, { waitMs: 2_000 }).finally(() => { installations.delete(key); });
  installations.set(key, installation);
  return installation;
}
