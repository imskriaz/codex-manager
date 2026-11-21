import type * as vscode from 'vscode';
import { getSqliteStateStore } from '../storage/sqliteState';
import { maintainManagerDatabases } from '../storage/storageCleanup';
import { maintainAttachmentStorage } from './projectTaskAttachments';
import { runCrossWindowExclusive, CrossWindowOperationBusyError } from '../utils/crossWindowOperations';
import { retryDeletedSessionFileCleanup } from './codexSessionStorageDelete';
import { resolveCodexHome } from './codexSessionResume';

/** Both hosts maintain the same shared storage without delaying startup or manual work. */
export function registerStorageMaintenance(context: vscode.ExtensionContext): void {
  let disposed = false, running = false;
  const controller = new AbortController();
  const cleanup = () => {
    if (disposed || running) return;
    running = true;
    void runCrossWindowExclusive('background:storage-cleanup', 'Storage cleanup', async signal => {
      const store = getSqliteStateStore();
      if (!store || disposed) return;
      const combined = AbortSignal.any([signal, controller.signal]);
      for (const work of [() => retryDeletedSessionFileCleanup(resolveCodexHome(), combined), () => maintainAttachmentStorage(store, combined), () => maintainManagerDatabases(store)]) {
        if (disposed || signal.aborted || getSqliteStateStore() !== store) break;
        try { await work(); }
        catch (error) { console.warn('[codexManager] storage cleanup phase postponed', error); }
      }
    }, { background: true }).catch(error => {
      if (!(error instanceof CrossWindowOperationBusyError)) console.warn('[codexManager] storage cleanup postponed', error);
    }).finally(() => { running = false; });
  };
  const startup = setTimeout(cleanup, 30_000), interval = setInterval(cleanup, 30 * 60_000);
  startup.unref?.(); interval.unref?.();
  context.subscriptions.push({ dispose() { disposed = true; controller.abort(); clearTimeout(startup); clearInterval(interval); } });
}
