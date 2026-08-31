import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import * as vscode from "vscode";
import type { EncryptedSyncManager } from "./encryptedSync";

/** Reuses the normal dashboard port; the detached relay takes over when the
 * VS Code-managed server releases it. */
export const ALWAYS_ONLINE_RELAY_PORT = 39875;
const CONFIG_FILE = "always-online-relay.json";
const PID_FILE = "always-online-relay.pid";
const SECRET_KEY = "codexManager.webDashboard.alwaysOnlineAdminToken.v1";
const STARTUP_FILE = "CodexManagerAlwaysOnline.cmd";

type RelayConfig = { port: number; hostKey: string; adminToken: string; pidPath: string; modulePaths: string[] };
type PreparedRelay = RelayConfig & { configPath: string; scriptTarget: string; previousKey?: string };

export class AlwaysOnlineServer implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private sessionActive = false;
  private preparedRelay: PreparedRelay | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly encryptedSync?: EncryptedSyncManager
  ) {}

  async applyConfiguration(): Promise<"started" | "already-running" | "stopped" | "paused"> {
    const enabled = vscode.workspace
      .getConfiguration("codexManager")
      .get<boolean>("webDashboardAlwaysOnlineEnabled", false);
    if (!enabled) {
      await this.stop();
      return "stopped";
    }
    if (this.sessionActive) {
      // Prepare everything needed for a synchronous detached handoff. VS Code
      // does not await Disposable.dispose(), so beginning this work from
      // dispose() is too late and can leave the shared dashboard port empty.
      await this.prepareRelay();
      return "paused";
    }
    return this.start();
  }

  /** Release the shared port while the VS Code dashboard is active. */
  async prepareForVscodeSession(): Promise<void> {
    this.sessionActive = true;
    const enabled = vscode.workspace.getConfiguration("codexManager").get<boolean>("webDashboardAlwaysOnlineEnabled", false);
    if (!enabled) return;
    try {
      const configPath = path.join(this.context.globalStorageUri.fsPath, CONFIG_FILE);
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Partial<RelayConfig>;
      if (config.adminToken) {
        await waitForRelayShutdown(
          ALWAYS_ONLINE_RELAY_PORT,
          config.adminToken,
          path.join(this.context.globalStorageUri.fsPath, PID_FILE)
        );
      }
    } catch {
      // No previous relay is normal on first activation.
    }
  }

  async start(): Promise<"started" | "already-running"> {
    const prepared = await this.prepareRelay();
    const existingPid = await readLivePid(prepared.pidPath);
    if (existingPid) {
      // A changed encrypted-sync passphrase changes the relay key; restart so
      // peers are not split across two authentication keys.
      if (prepared.previousKey === prepared.hostKey) {
        return "already-running";
      }
      await waitForRelayShutdown(ALWAYS_ONLINE_RELAY_PORT, prepared.adminToken, prepared.pidPath);
    }
    if (await relayIsHealthy(prepared.port)) {
      return "already-running";
    }
    this.spawnPreparedRelay(prepared);
    const ready = await waitForRelay(prepared.port);
    if (!ready && !(await portIsOccupied(prepared.port))) {
      this.child = undefined;
      throw new Error("The detached Node.js relay did not become ready on 127.0.0.1:39875.");
    }
    return "started";
  }

  async stop(): Promise<void> {
    const storage = this.context.globalStorageUri.fsPath;
    const configPath = path.join(storage, CONFIG_FILE);
    let adminToken: string | undefined;
    try {
      adminToken = (JSON.parse(await fs.readFile(configPath, "utf8")) as Partial<RelayConfig>).adminToken;
    } catch {
      // A missing config means the relay was never enabled.
    }
    if (adminToken) {
      await waitForRelayShutdown(ALWAYS_ONLINE_RELAY_PORT, adminToken, path.join(storage, PID_FILE));
    }
    this.child = undefined;
    this.preparedRelay = undefined;
    await removeStartupLauncher(this.context);
  }

  dispose(): void {
    this.sessionActive = false;
    if (
      this.preparedRelay &&
      vscode.workspace.getConfiguration("codexManager").get<boolean>("webDashboardAlwaysOnlineEnabled", false)
    ) {
      // Disposable.dispose() is synchronous. Spawn the already-prepared relay
      // before the extension host exits; it retries the bind until the Web
      // Dashboard releases the shared port.
      this.spawnPreparedRelay(this.preparedRelay);
    }
  }

  private async prepareRelay(): Promise<PreparedRelay> {
    const hostKey = await this.encryptedSync?.getRealtimeRelayKey();
    if (!hostKey) {
      throw new Error("Enable and configure Encrypted Sync first; it supplies the relay's peer authentication key.");
    }
    const storage = this.context.globalStorageUri.fsPath;
    await fs.mkdir(storage, { recursive: true });
    const storedAdminToken = await this.context.secrets.get(SECRET_KEY);
    const adminToken = storedAdminToken ?? cryptoRandomToken();
    if (!storedAdminToken) await this.context.secrets.store(SECRET_KEY, adminToken);
    const { configPath, scriptTarget } = await this.prepareRelayFiles();
    const prepared: PreparedRelay = {
      port: ALWAYS_ONLINE_RELAY_PORT,
      hostKey,
      adminToken,
      pidPath: path.join(storage, PID_FILE),
      modulePaths: [this.context.extensionUri.fsPath, path.join(this.context.extensionUri.fsPath, "node_modules")],
      configPath,
      scriptTarget,
      previousKey: await readPreviousRelayKey(configPath)
    };
    const config: RelayConfig = {
      port: prepared.port,
      hostKey: prepared.hostKey,
      adminToken: prepared.adminToken,
      pidPath: prepared.pidPath,
      modulePaths: prepared.modulePaths
    };
    await fs.writeFile(configPath, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
    await writeStartupLauncher(this.context, configPath, scriptTarget);
    this.preparedRelay = prepared;
    return prepared;
  }

  private spawnPreparedRelay(prepared: PreparedRelay): void {
    const node = resolveNodeExecutable();
    this.child = spawn(node, [prepared.scriptTarget, prepared.configPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: node === process.execPath ? "1" : process.env["ELECTRON_RUN_AS_NODE"] }
    });
    this.child.unref();
  }

  private async prepareRelayFiles(): Promise<{ configPath: string; scriptTarget: string }> {
    const storage = this.context.globalStorageUri.fsPath;
    await fs.mkdir(storage, { recursive: true });
    const scriptSource = path.join(this.context.extensionUri.fsPath, "tools", "always-online-server.js");
    const scriptTarget = path.join(storage, "always-online-server.js");
    await fs.copyFile(scriptSource, scriptTarget);
    return { configPath: path.join(storage, CONFIG_FILE), scriptTarget };
  }
}

async function readPreviousRelayKey(configPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Partial<RelayConfig>;
    return parsed.hostKey;
  } catch {
    return undefined;
  }
}

function cryptoRandomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${os.hostname()}`;
}

function resolveNodeExecutable(): string {
  // A normal Node install is preferred. Electron can execute Node too, which
  // keeps the feature working on machines that only have VS Code installed.
  return process.env["NODE"] ?? process.env["NODE_EXE"] ?? process.execPath;
}

function relayIsHealthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 800 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (body.length <= 4096) body += chunk;
      });
      response.once("end", () => resolve(isAlwaysOnlineRelayHealthResponse(response.statusCode, body)));
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => { request.destroy(); resolve(false); });
  });
}

export function isAlwaysOnlineRelayHealthResponse(statusCode: number | undefined, body: string): boolean {
  if (statusCode !== 200 || body.length > 4096) return false;
  try {
    const payload = JSON.parse(body) as { ok?: unknown; service?: unknown; port?: unknown };
    return payload.ok === true && payload.service === "codex-manager-relay" && payload.port === ALWAYS_ONLINE_RELAY_PORT;
  } catch {
    return false;
  }
}

function portIsOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 500 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on("error", (error: NodeJS.ErrnoException) => resolve(error.code !== "ECONNREFUSED"));
    request.on("timeout", () => { request.destroy(); resolve(true); });
  });
}

function waitForRelay(port: number): Promise<boolean> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const poll = () => {
      relayIsHealthy(port).then((ok) => {
        if (ok) resolve(true);
        else if (Date.now() - startedAt > 8_000) resolve(false);
        else setTimeout(poll, 150);
      }).catch(() => resolve(false));
    };
    poll();
  });
}

function requestShutdown(port: number, token: string): Promise<void> {
  return new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/shutdown", method: "POST", headers: { "X-Codex-Admin": token }, timeout: 1_000 }, (response) => {
      response.resume();
      response.once("end", () => resolve());
    });
    request.on("error", () => resolve());
    request.end();
  });
}

async function writeStartupLauncher(context: vscode.ExtensionContext, configPath: string, scriptPath: string): Promise<void> {
  if (process.platform !== "win32") return;
  const appData = process.env["APPDATA"];
  const startup = appData ? path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup") : undefined;
  if (!startup) return;
  await fs.mkdir(startup, { recursive: true });
  const command = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nstart "Codex Manager relay" /b "${process.execPath}" "${scriptPath}" "${configPath}"\r\n`;
  await fs.writeFile(path.join(startup, STARTUP_FILE), command, { encoding: "utf8", mode: 0o600 });
  void context;
}

async function removeStartupLauncher(context: vscode.ExtensionContext): Promise<void> {
  const appData = process.env["APPDATA"];
  if (process.platform !== "win32" || !appData) return;
  try { await fs.unlink(path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", STARTUP_FILE)); } catch { /* already removed */ }
  void context;
}

async function readLivePid(pidPath: string): Promise<number | undefined> {
  try {
    const value = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);
    if (!Number.isInteger(value) || value <= 0) return undefined;
    process.kill(value, 0);
    return value;
  } catch {
    return undefined;
  }
}

async function waitForRelayShutdown(port: number, token: string, pidPath: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (!(await readLivePid(pidPath))) return;
    await requestShutdown(port, token);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function relayConfigPath(globalStoragePath: string): string {
  return path.join(globalStoragePath, CONFIG_FILE);
}

export function relayPidPath(globalStoragePath: string): string {
  return path.join(globalStoragePath, PID_FILE);
}
