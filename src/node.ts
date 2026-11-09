/* eslint-disable @typescript-eslint/require-await -- Host adapters expose promise APIs over synchronous storage and cleanup. */
import { readFileSync } from "node:fs";
import * as path from "path";
import * as vscode from "vscode";
import { initializeSqliteContextWithRetry } from "./storage/sqliteContext";
import { deleteSqliteStateFile, getSqliteStateStore, readSqliteStateFile, writeSqliteStateFile } from "./storage/sqliteState";
import { AccountsRepository } from "./storage";
import { WebDashboardServer } from "./services/webDashboardServer";
import { configureCrossWindowOperationCoordinator } from "./utils/crossWindowOperations";
import { getCodexManagerStorageRoot } from "./utils/storageRoot";
import { disposePersistentLogging, registerPersistentLogging, recordPersistentEvent } from "./utils/persistentLog";
import { waitWithin } from "./utils/concurrency";
import { registerNodeBackgroundServices } from "./services/nodeBackgroundServices";
import { cancelCodexSessionAutoResume, prepareCodexSessionsForExtensionHostRestart } from "./services/codexSessionAutoResume";
import { disposeSessionRecording } from "./services/sessionRecording";
import { EncryptedSyncManager } from "./services/encryptedSync";
import { getCodexManagerConfiguration } from "./infrastructure/config/extensionSettings";
import { initializeCodexProxyEnvironment, disposeCodexProxyEnvironment } from "./infrastructure/config/proxyEnvironment";

function createMemento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, value); }
  };
}

function createContext(): vscode.ExtensionContext {
  const extensionRoot = path.resolve(__dirname, "..");
  const uri = vscode.Uri.file(extensionRoot);
  const packageJSON = JSON.parse(readFileSync(path.join(extensionRoot, "package.json"), "utf8")) as Record<string, unknown>;
  return {
    extensionUri: uri,
    extension: { packageJSON, extensionUri: uri },
    extensionPath: extensionRoot,
    storageUri: vscode.Uri.file(process.env["CODEX_MANAGER_WORKSPACE_STORAGE"] ?? process.env["CODEX_MANAGER_STORAGE_ROOT"] ?? extensionRoot),
    globalState: createMemento(),
    workspaceState: createMemento(),
    secrets: undefined,
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

export async function startNodeHost(): Promise<void> {
  const context = await initializeSqliteContextWithRetry(createContext());
  const repo = new AccountsRepository(context);
  const sync = new EncryptedSyncManager(context, repo);
  repo.setAccountSwitchCoordinator(sync);
  const dashboard = new WebDashboardServer(context, repo, sync, { failOnAddressInUse: true });
  const pidFile = process.env["CODEX_MANAGER_PID_FILE"];
  let ownsDashboard = false;
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => closing ??= (async () => {
    recordPersistentEvent("info", "node-host", "Standalone shutdown started", { pid: process.pid });
    dashboard.prepareForShutdown();
    cancelCodexSessionAutoResume("Standalone is shutting down.");
    if (ownsDashboard) {
      const controller = new AbortController();
      try {
        await waitWithin(prepareCodexSessionsForExtensionHostRestart(context, true, undefined, undefined, controller.signal),
          5_000, "Standalone recovery capture timed out. The previous snapshot was retained.", controller.signal);
        recordPersistentEvent("info", "node-host", "Standalone shutdown recovery saved");
      } catch (error) {
        recordPersistentEvent("warning", "node-host", "Standalone shutdown recovery could not be confirmed; previous snapshot retained", undefined, error);
      } finally { controller.abort(); }
    }
    await dashboard.stop();
    dashboard.dispose();
    sync.dispose();
    disposeCodexProxyEnvironment();
    for (const subscription of context.subscriptions) subscription.dispose();
    disposeSessionRecording();
    repo.dispose();
    if (pidFile) {
      try { if (readSqliteStateFile(pidFile) === String(process.pid)) deleteSqliteStateFile(pidFile); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await disposePersistentLogging(true);
    getSqliteStateStore()?.close();
  })();
  const exit = (): void => { void shutdown().then(() => process.exit(0), error => { console.error("[codexManager] Node shutdown failed", error); process.exit(1); }); };
  process.once("SIGINT", exit);
  process.once("SIGTERM", exit);
  try {
    await waitWithin(registerPersistentLogging(context), 2_000, "Standalone diagnostics initialization timed out.").catch(error => console.warn("[codexManager] standalone diagnostics unavailable", error));
    recordPersistentEvent("info", "node-host", "Standalone startup started", { pid: process.pid });
    await configureCrossWindowOperationCoordinator(getCodexManagerStorageRoot());
    await initializeCodexProxyEnvironment().catch(error => console.warn("[codexManager] standalone provider connection settings failed:", error));
    await repo.init();
    const deadline = Date.now() + (process.env["CODEX_MANAGER_HANDOFF"] === "1" ? 8_000 : 0);
    let waitingForPort = false;
    for (;;) {
      try { await dashboard.start(); ownsDashboard = true; break; }
      catch (error) {
        if (closing || Date.now() >= deadline || !(error instanceof Error) || !error.message.includes("already owned by another host")) throw error;
        if (!waitingForPort) recordPersistentEvent("info", "node-host", "Waiting for the current dashboard host to release the port", { pid: process.pid });
        waitingForPort = true;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    let syncReady = false;
    const syncStartup = sync.start().then(() => { syncReady = true; dashboard.publishLocalStateChange(); })
      .catch(error => console.warn("[codexManager] standalone account claims could not initialize:", error));
    await waitWithin(syncStartup, 2_000, "Standalone claims are still loading.").catch(error => console.warn("[codexManager]", error));
    registerNodeBackgroundServices(context, repo, dashboard, id =>
      !getCodexManagerConfiguration().get<boolean>("encryptedSyncEnabled", false) || syncReady && sync.canAutomateAccount(id));
    if (pidFile) writeSqliteStateFile(pidFile, String(process.pid));
    recordPersistentEvent("info", "node-host", "Standalone ready", { pid: process.pid, url: dashboard.getUrl(), version: (context.extension.packageJSON as { version: string }).version });
  } catch (error) {
    recordPersistentEvent("error", "node-host", "Standalone startup failed", { pid: process.pid }, error);
    await shutdown();
    process.removeListener("SIGINT", exit);
    process.removeListener("SIGTERM", exit);
    throw error;
  }
  console.log(`Codex Manager Node host listening at ${dashboard.getUrl()}`);
  if (process.send) process.send({ type: "codex-manager-ready", url: dashboard.getUrl() });
}

if (require.main === module) {
  startNodeHost().catch((error) => {
    console.error(`[codexManager] Node host failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
