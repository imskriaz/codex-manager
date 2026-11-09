const fs = require("node:fs/promises");
const path = require("node:path");

class Disposable {
  constructor(fn = () => undefined) { this.fn = fn; this.isDisposed = false; }
  dispose() { if (!this.isDisposed) { this.isDisposed = true; this.fn(); } }
  static from(...items) { return new Disposable(() => items.forEach(item => item?.dispose?.())); }
}

class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return new Disposable(() => this.listeners.delete(listener)); }; }
  fire(value) { for (const listener of [...this.listeners]) { try { listener(value); } catch { /* Host callbacks must not stop the Node server. */ } } }
  dispose() { this.listeners.clear(); }
}

class Uri {
  constructor(fsPath) { this.fsPath = path.resolve(fsPath); }
  toString() { return `file://${this.fsPath.replaceAll("\\", "/")}`; }
  static file(value) { return new Uri(value); }
  static parse(value) { return new Uri(new URL(value).pathname); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
}

const configurationChanges = new EventEmitter();
const values = new Map();
const workspace = {
  workspaceFolders: [], workspaceFile: undefined, isTrusted: true,
  onDidChangeConfiguration: configurationChanges.event,
  getConfiguration(section = "") {
    return {
      get(key, fallback) { return values.has(`${section}.${key}`) ? values.get(`${section}.${key}`) : fallback; },
      inspect(key) { return { defaultValue: undefined, globalValue: values.get(`${section}.${key}`) }; },
      async update(key, value) { const full = `${section}.${key}`; if (value === undefined) values.delete(full); else values.set(full, value); configurationChanges.fire({ affectsConfiguration: name => name === section || name === full || full.startsWith(`${name}.`) }); }
    };
  },
  fs: {
    readFile: uri => fs.readFile(uri.fsPath),
    writeFile: (uri, data) => fs.writeFile(uri.fsPath, data)
  },
  openTextDocument: async options => options,
  showTextDocument: async () => undefined
};

const window = {
  activeTextEditor: undefined, activeTerminal: undefined, terminals: [],
  onDidChangeActiveTextEditor: () => new Disposable(), onDidChangeActiveTerminal: () => new Disposable(),
  onDidStartTerminalShellExecution: undefined, onDidEndTerminalShellExecution: undefined,
  onDidCloseTerminal: undefined, onDidChangeTerminalShellIntegration: undefined,
  showInformationMessage: async message => { console.log(`[info] ${message}`); return undefined; },
  showWarningMessage: async message => { console.warn(`[warning] ${message}`); return undefined; },
  showErrorMessage: async message => { console.error(`[error] ${message}`); return undefined; },
  showInputBox: async () => undefined, showQuickPick: async () => undefined, showOpenDialog: async () => undefined,
  withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }),
  createOutputChannel: name => ({ name, appendLine: line => console.log(`[${name}] ${line}`), append: () => undefined, clear: () => undefined, show: () => undefined, dispose: () => undefined }),
  createStatusBarItem: () => ({ text: "", tooltip: "", command: undefined, show: () => undefined, hide: () => undefined, dispose: () => undefined }),
  createTerminal: options => {
    if (!options?.pty) throw new Error("Use a shared workspace terminal in standalone mode.");
    let disposed = false;
    const terminal = {
      name: options.name || "Terminal", creationOptions: options, processId: Promise.resolve(undefined),
      state: { isInteractedWith: false },
      show() { window.activeTerminal = terminal; }, hide() {},
      sendText(text, addNewLine = true) { if (!disposed) options.pty.handleInput?.(text + (addNewLine ? "\r" : "")); },
      dispose() {
        if (disposed) return;
        disposed = true;
        options.pty.close();
        const index = window.terminals.indexOf(terminal);
        if (index >= 0) window.terminals.splice(index, 1);
        if (window.activeTerminal === terminal) window.activeTerminal = undefined;
      }
    };
    window.terminals.push(terminal);
    queueMicrotask(() => { if (!disposed) options.pty.open(undefined); });
    return terminal;
  }, createWebviewPanel: () => { throw new Error("VS Code webviews are unavailable in Node host."); }
};

const commands = new Map();
const commandApi = {
  registerCommand(name, handler) { commands.set(name, handler); return new Disposable(() => commands.delete(name)); },
  async executeCommand(name, ...args) {
    const handler = commands.get(name);
    if (!handler) throw new Error(`This action requires VS Code (${name}). Use its browser equivalent when available.`);
    return handler(...args);
  }
};

module.exports = {
  Disposable, EventEmitter, Uri, workspace, window, commands: commandApi,
  env: { appHost: "node", language: process.env.LANG ?? "en", sessionId: `node-${process.pid}`, appRoot: process.cwd(), shell: process.env.SHELL, openExternal: async () => false, clipboard: { writeText: async () => undefined } },
  extensions: { getExtension: () => undefined },
  authentication: { getSession: async () => undefined },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { Notification: 15 }, ViewColumn: { Beside: 2 }, StatusBarAlignment: { Left: 1, Right: 2 },
  TextEditorRevealType: { InCenter: 2 },
  MarkdownString: class MarkdownString { constructor(value = "") { this.value = value; } appendMarkdown(value) { this.value += value; return this; } },
  RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  l10n: { t: value => value }
};
