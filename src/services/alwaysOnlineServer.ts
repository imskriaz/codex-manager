import { installRelayStartup, removeRelayStartup } from "../utils/relayStartup";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as http from "http";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import * as vscode from "vscode";
import type { EncryptedSyncManager } from "./encryptedSync";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";
import { readSqliteStateFile, sqliteStoreForFile, writeSqliteStateFile } from "../storage/sqliteState";

/** Reuses the normal dashboard port; the detached relay takes over when the
 * VS Code-managed server releases it. */
export const ALWAYS_ONLINE_RELAY_PORT = 39875;
const CONFIG_FILE = "always-online-relay.json";
const PID_FILE = "always-online-relay.pid";
const SECRET_KEY = "codexManager.webDashboard.alwaysOnlineAdminToken.v1";

type RelayConfig = { port: number; hostKey: string; adminToken: string; pidPath: string; modulePaths: string[]; claimRegistryPath?: string };
type PreparedRelay = RelayConfig & {
  configPath: string;
  scriptTarget: string;
  previousKey?: string;
  previousAdminToken?: string;
};
type RelayConfigurationResult = "started" | "already-running" | "stopped" | "paused" | "waiting-for-configuration";

export class AlwaysOnlineServer implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private childLaunchError: Error | undefined;
  private sessionActive = false;
  private preparedRelay: PreparedRelay | undefined;
  private waitingForConfiguration = false;
  private verifiedConfiguration: string | undefined;
  private applying: Promise<RelayConfigurationResult> | undefined;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly encryptedSync?: EncryptedSyncManager,
    private readonly isConfiguredHostLocal: () => Promise<boolean> = () => Promise.resolve(false)
  ) {}

  applyConfiguration(): Promise<RelayConfigurationResult> {
    if (this.disposed) return Promise.resolve("stopped");
    if (this.applying) return this.applying;
    const task = (async () => {
      for (;;) {
        const configuration = this.configurationKey();
        try {
          const result = await this.applyConfigurationInternal();
          if (this.disposed || configuration === this.configurationKey()) return result;
        } catch (error) {
          if (this.disposed || configuration === this.configurationKey()) throw error;
        }
      }
    })().finally(() => { if (this.applying === task) this.applying = undefined; });
    this.applying = task;
    return task;
  }

  private async applyConfigurationInternal(): Promise<RelayConfigurationResult> {
    const configuration = this.configurationKey();
    let enabled = false;
    try { enabled = !!configuration && await this.isConfiguredHostLocal(); }
    catch (error) { console.debug("[codexManager] tunnel host check deferred", error); }
    if (this.disposed || configuration !== this.configurationKey()) { this.verifiedConfiguration = undefined; await this.stop(); return "stopped"; }
    this.verifiedConfiguration = enabled ? configuration : undefined;
    if (!enabled) {
      this.waitingForConfiguration = false;
      await this.stop();
      return "stopped";
    }
    const hostKey = await this.encryptedSync?.getRealtimeRelayKey();
    if (this.disposed || configuration !== this.configurationKey()) { this.verifiedConfiguration = undefined; await this.stop(); return "stopped"; }
    if (!hostKey) {
      // This is a prerequisite state, not a relay failure. In particular, an
      // old prepared relay must not be launched from dispose() after the user
      // disables encrypted sync. Keep the preference armed so configuring the
      // shared password can make it ready without asking the user to opt in a
      // second time.
      await this.stop();
      this.waitingForConfiguration = true;
      return "waiting-for-configuration";
    }
    this.waitingForConfiguration = false;
    if (this.sessionActive) {
      // Prepare everything needed for a synchronous detached handoff. VS Code
      // does not await Disposable.dispose(), so beginning this work from
      // dispose() is too late and can leave the shared dashboard port empty.
      await this.prepareRelay(hostKey);
      if (this.disposed || configuration !== this.configurationKey()) { await this.stop(); return "stopped"; }
      return "paused";
    }
    return this.start(hostKey);
  }

  isWaitingForConfiguration(): boolean {
    return this.waitingForConfiguration;
  }

  /** Release the shared port while the VS Code dashboard is active. */
  async prepareForVscodeSession(): Promise<void> {
    this.sessionActive = true;
    try {
      const storage = getCodexManagerStorageRoot();
      const configPath = path.join(storage, CONFIG_FILE);
      const config = JSON.parse(sqliteStoreForFile(configPath) ? readSqliteStateFile(configPath) : await fs.readFile(configPath, "utf8")) as Partial<RelayConfig>;
      if (config.adminToken) {
        await waitForRelayShutdown(ALWAYS_ONLINE_RELAY_PORT, config.adminToken, path.join(storage, PID_FILE));
      }
    } catch (error) {
      if (sqliteStoreForFile(path.join(getCodexManagerStorageRoot(), CONFIG_FILE)) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // No previous relay is normal on first activation.
    }
  }

  async start(hostKey?: string): Promise<"started" | "already-running"> {
    const prepared = await this.prepareRelay(hostKey);
    if (this.disposed) { await this.stop(); throw new Error("Relay preparation stopped because this window closed."); }
    const existingPid = await readLivePid(prepared.pidPath);
    if (existingPid) {
      // A changed encrypted-sync passphrase changes the relay key; restart so
      // peers are not split across two authentication keys.
      if (prepared.previousKey === prepared.hostKey && prepared.previousAdminToken === prepared.adminToken && await relayIsHealthy(prepared.port)) {
        return "already-running";
      }
      await waitForRelayShutdown(
        ALWAYS_ONLINE_RELAY_PORT,
        prepared.previousAdminToken ?? prepared.adminToken,
        prepared.pidPath
      );
    }
    if (await relayIsHealthy(prepared.port)) {
      return "already-running";
    }
    if (this.disposed) { await this.stop(); throw new Error("Relay preparation stopped because this window closed."); }
    this.spawnPreparedRelay(prepared);
    const ready = await waitForRelay(prepared.port);
    if (!ready) {
      this.child = undefined;
      if (this.childLaunchError) throw this.childLaunchError;
      if (await portIsOccupied(prepared.port)) throw new Error("The detached relay could not become ready because the dashboard port is occupied. Close the other host and retry.");
      throw new Error("The detached Node.js relay did not become ready on 127.0.0.1:39875.");
    }
    return "started";
  }

  async stop(): Promise<void> {
    const storage = getCodexManagerStorageRoot();
    const configPath = path.join(storage, CONFIG_FILE);
    let adminToken: string | undefined;
    try {
      adminToken = (JSON.parse(sqliteStoreForFile(configPath) ? readSqliteStateFile(configPath) : await fs.readFile(configPath, "utf8")) as Partial<RelayConfig>).adminToken;
    } catch (error) {
      if (sqliteStoreForFile(configPath) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A missing config means the relay was never enabled.
    }
    const pidPath = path.join(storage, PID_FILE);
    const shutdownTokens = new Set(
      [adminToken, this.preparedRelay?.previousAdminToken].filter((value): value is string => !!value)
    );
    for (const token of shutdownTokens) {
      await waitForRelayShutdown(ALWAYS_ONLINE_RELAY_PORT, token, pidPath);
      if (!(await readLivePid(pidPath)) && !(await relayIsHealthy(ALWAYS_ONLINE_RELAY_PORT))) {
        break;
      }
    }
    this.child = undefined;
    this.preparedRelay = undefined;
    await removeStartupLauncher(this.context);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sessionActive = false;
    if (
      this.preparedRelay &&
      this.verifiedConfiguration !== undefined && this.verifiedConfiguration === this.configurationKey()
    ) {
      // Disposable.dispose() is synchronous. Spawn the already-prepared relay
      // before the extension host exits; it retries the bind until the Web
      // Dashboard releases the shared port.
      this.spawnPreparedRelay(this.preparedRelay);
    }
  }

  private configurationKey(): string | undefined {
    const config = getCodexManagerConfiguration();
    const domain = config.get<string>("cloudflaredDomain", "").trim();
    return config.get<boolean>("webDashboardEnabled", false) && config.get<boolean>("webSocketServerEnabled", true) && domain ? domain : undefined;
  }

  private async prepareRelay(preparedHostKey?: string): Promise<PreparedRelay> {
    const hostKey = preparedHostKey ?? (await this.encryptedSync?.getRealtimeRelayKey());
    if (!hostKey) {
      throw new Error("Configure the shared dashboard password and enable WS Cross System before starting the relay.");
    }
    const storage = getCodexManagerStorageRoot();
    await fs.mkdir(storage, { recursive: true });
    const previousConfig = await readPreviousRelayConfig(path.join(storage, CONFIG_FILE));
    const storedAdminToken = await this.context.secrets.get(SECRET_KEY);
    let adminToken = storedAdminToken;
    if (!adminToken || isLegacyRelayAdminToken(adminToken)) {
      const replacement = createRelayAdminToken();
      try {
        await this.context.secrets.store(SECRET_KEY, replacement);
        adminToken = replacement;
      } catch (error) {
        if (!adminToken) {
          throw error;
        }
        // Keep an existing relay usable if Secret Storage cannot persist the
        // rotation. Retry on the next preparation instead of losing the key.
        console.warn("[codexManager] relay admin token rotation failed", error);
        void vscode.window.showWarningMessage(
          "The relay admin token could not be rotated. Retry after Secret Storage is available."
        );
      }
    }
    const pidPath = path.join(storage, PID_FILE);
    if (previousConfig?.adminToken && previousConfig.adminToken !== adminToken) {
      // Keep the old config on disk until the old process has exited. If the
      // host crashes after Secret Storage rotates, the next startup can still
      // authenticate shutdown with the previous config token.
      await waitForRelayShutdown(ALWAYS_ONLINE_RELAY_PORT, previousConfig.adminToken, pidPath);
      if ((await readLivePid(pidPath)) || (await relayIsHealthy(ALWAYS_ONLINE_RELAY_PORT))) {
        throw new Error("The previous relay did not stop; its admin token was not rotated on disk.");
      }
    }
    const { configPath, scriptTarget } = await this.prepareRelayFiles();
    const prepared: PreparedRelay = {
      port: ALWAYS_ONLINE_RELAY_PORT,
      hostKey,
      adminToken,
      pidPath,
      modulePaths: [this.context.extensionUri.fsPath, path.join(this.context.extensionUri.fsPath, "node_modules")],
      configPath,
      scriptTarget,
      previousKey: previousConfig?.hostKey,
      previousAdminToken: previousConfig?.adminToken
    };
    const config: RelayConfig = {
      port: prepared.port,
      hostKey: prepared.hostKey,
      adminToken: prepared.adminToken,
      pidPath: prepared.pidPath,
      modulePaths: prepared.modulePaths,
      claimRegistryPath: path.join(storage, "account-claim-authority.json")
    };
    if (sqliteStoreForFile(configPath)) writeSqliteStateFile(configPath, JSON.stringify(config));
    else await fs.writeFile(configPath, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
    await writeStartupLauncher(this.context, configPath, scriptTarget);
    this.preparedRelay = prepared;
    return prepared;
  }

  private spawnPreparedRelay(prepared: PreparedRelay): void {
    const node = resolveNodeExecutable();
    this.childLaunchError = undefined;
    this.child = spawn(node, [prepared.scriptTarget, prepared.configPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: node === process.execPath ? "1" : process.env["ELECTRON_RUN_AS_NODE"]
      }
    });
    this.child.on("error", (error) => {
      this.childLaunchError = error;
      console.warn("[codexManager] detached relay could not launch", error);
    });
    this.child.unref();
  }

  private async prepareRelayFiles(): Promise<{ configPath: string; scriptTarget: string }> {
    const storage = getCodexManagerStorageRoot();
    await fs.mkdir(storage, { recursive: true });
    const scriptTarget = path.join(this.context.extensionUri.fsPath, "tools", "always-online-server.js");
    return { configPath: path.join(storage, CONFIG_FILE), scriptTarget };
  }
}

async function readPreviousRelayConfig(configPath: string): Promise<Partial<RelayConfig> | undefined> {
  try {
    return JSON.parse(sqliteStoreForFile(configPath) ? readSqliteStateFile(configPath) : await fs.readFile(configPath, "utf8")) as Partial<RelayConfig>;
  } catch (error) {
    if (sqliteStoreForFile(configPath) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

export function createRelayAdminToken(): string {
  let token: string;
  // Random hyphens can resemble the old timestamp/random/hostname format.
  do { token = crypto.randomBytes(32).toString("base64url"); } while (isLegacyRelayAdminToken(token));
  return token;
}

export function isLegacyRelayAdminToken(token: string): boolean {
  return token.length < 43 || /^[0-9a-z]{7,12}-[0-9a-z]{4,13}-.+$/i.test(token);
}

function resolveNodeExecutable(): string {
  // A normal Node install is preferred. Electron can execute Node too, which
  // keeps the feature working on machines that only have VS Code installed.
  return process.env["NODE"] ?? process.env["NODE_EXE"] ?? process.execPath;
}

function relayIsHealthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (healthy: boolean): void => { clearTimeout(deadline); resolve(healthy); };
    const deadline = setTimeout(() => { request.destroy(); finish(false); }, 800);
    const request = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 800 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (body.length <= 4096) body += chunk;
      });
      response.once("end", () => finish(isAlwaysOnlineRelayHealthResponse(response.statusCode, body)));
      response.once("error", () => finish(false));
      response.once("aborted", () => finish(false));
    });
    request.on("error", () => finish(false));
    request.on("timeout", () => {
      request.destroy();
      finish(false);
    });
  });
}

export function isAlwaysOnlineRelayHealthResponse(statusCode: number | undefined, body: string): boolean {
  if (statusCode !== 200 || body.length > 4096) return false;
  try {
    const payload = JSON.parse(body) as { ok?: unknown; service?: unknown; port?: unknown };
    return (
      payload.ok === true && payload.service === "codex-manager-relay" && payload.port === ALWAYS_ONLINE_RELAY_PORT
    );
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
    request.on("timeout", () => {
      request.destroy();
      resolve(true);
    });
  });
}

function waitForRelay(port: number): Promise<boolean> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const poll = () => {
      relayIsHealthy(port)
        .then((ok) => {
          if (ok) resolve(true);
          else if (Date.now() - startedAt > 8_000) resolve(false);
          else setTimeout(poll, 150);
        })
        .catch(() => resolve(false));
    };
    poll();
  });
}

function requestShutdown(port: number, token: string): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => { clearTimeout(deadline); resolve(); };
    const deadline = setTimeout(() => { request.destroy(); finish(); }, 1_000);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/shutdown",
        method: "POST",
        headers: { "X-Codex-Admin": token },
        timeout: 1_000
      },
      (response) => {
        response.resume();
        response.once("end", finish);
        response.once("error", finish);
        response.once("aborted", finish);
      }
    );
    request.on("error", finish);
    request.on("timeout", () => {
      request.destroy();
      finish();
    });
    request.end();
  });
}

async function writeStartupLauncher(context: vscode.ExtensionContext, configPath: string, scriptPath: string): Promise<void> {
  await installRelayStartup(configPath, scriptPath);
  void context;
}

async function removeStartupLauncher(context: vscode.ExtensionContext): Promise<void> {
  await removeRelayStartup();
  void context;
}

async function readLivePid(pidPath: string): Promise<number | undefined> {
  try {
    const text = sqliteStoreForFile(pidPath) ? readSqliteStateFile(pidPath) : await fs.readFile(pidPath, "utf8");
    const value = Number(text.trim());
    if (!Number.isInteger(value) || value <= 0) return undefined;
    process.kill(value, 0);
    return value;
  } catch (error) {
    if (sqliteStoreForFile(pidPath) && (error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return undefined;
  }
}

async function waitForRelayShutdown(port: number, token: string, pidPath: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const [pid, healthy] = await Promise.all([readLivePid(pidPath), relayIsHealthy(port)]);
    if (!pid && !healthy) {
      return;
    }
    await requestShutdown(port, token);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The detached relay did not confirm shutdown. Check the running relay before retrying.");
}
