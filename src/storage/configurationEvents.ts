import * as vscode from "vscode";

const listeners = new Set<(event: vscode.ConfigurationChangeEvent) => unknown>();

export function onDidChangeConfiguration(listener: (event: vscode.ConfigurationChangeEvent) => unknown): vscode.Disposable {
  listeners.add(listener);
  const native = vscode.workspace.onDidChangeConfiguration(listener);
  return { dispose: () => { listeners.delete(listener); native?.dispose(); } };
}

export function fireSqliteConfigurationChanges(keys: string[]): void {
  if (!keys.length) return;
  const names = keys.map(key => `codexManager.${key}`);
  const event = { affectsConfiguration: (section: string) => names.some(name => name === section || name.startsWith(`${section}.`)) } as vscode.ConfigurationChangeEvent;
  for (const listener of listeners) {
    try { listener(event); } catch (error) { console.error("[codexManager] settings change listener failed", error); }
  }
}
