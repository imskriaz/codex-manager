import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// The local UI is intercepted; shells and writes use disposable fixture storage only.
const origin = 'http://127.0.0.1:39875';
const root = await mkdtemp(path.join(tmpdir(), 'manager-standalone-terminal-'));
const output = path.resolve('output/standalone-terminal');
await mkdir(output, { recursive: true });
process.env.CODEX_MANAGER_STORAGE_ROOT = root;
process.env.NODE_PATH = path.resolve('tools/node-vscode-shim');
const require = createRequire(import.meta.url);
require('node:module').Module._initPaths();
const { SqliteStateStore, configureSqliteStateStore } = require('../out/storage/sqliteState.js');
const { readCodexCliComposerConfig } = require('../out/services/codexSessionResume.js');
const { workspaceTerminal, disposeSharedTerminals } = require('../out/services/workspaceTerminalPty.js');
const { listWorkspaceTerminals } = require('../out/services/workspaceTools.js');
const { subscribeDashboardRealtime } = require('../out/services/dashboardRealtime.js');
const store = await SqliteStateStore.open(path.join(root, 'manager.sqlite'));
configureSqliteStateStore(store);
let browser;
try {
  const config = await readCodexCliComposerConfig(root);
  assert.equal(config.standalone, true);
  assert.equal(config.terminalSupported, true);
  config.projects = [{ id: 'fixture', label: 'Terminal fixture', path: root }];
  const compiled = await build({ stdin: { contents: `
    import { render } from 'preact';
    import { CliSessionsPage } from './webview-src/dashboard/cliSessionsModal';
    const config = ${JSON.stringify(config)}, noop = () => {};
    const session = { id: 'terminal-fixture', title: 'Terminal fixture', status: 'idle', projectPath: config.projects[0].path };
    render(<CliSessionsPage {...Object.fromEntries(['onDashboard','onSettings','onSwitchAccount','onRefresh','onStart','onBackToList','onRefreshMessages','onRefreshEnvironment','onRunTerminal','onListTerminals','onCreateTerminal','onFocusTerminal','onCloseTerminal','onCancelTerminal','onCommitWorkspace','onPushWorkspace','onClearTerminal','onListFiles','onReadFile','onClearFile','onDeleteFile','onSaveFile','onSend','onStop','onResume','onAutoResume','onQueue','onRename','onFork','onCopyLink','onShare','onArchive','onOpenInCodex','onUnarchive','onDelete','onActionFeedback','onSelect'].map(key => [key, noop]))}
      browser connected standalone={config.standalone} privacyMode={false} autoResumeEnabled={false}
      selectedPeerId="local" peers={[{ id: 'local', local: true, name: 'This PC', connected: true }]}
      sessions={[session]} selectedSession={session} composerConfig={config} messages={[]} terminalResults={[]} terminalLiveOutputs={[]}
      workspaceTerminals={[]} workspaceFiles={[]} workspaceFilesByPath={{}}
    />, document.querySelector('#app'));
  `, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, loader: { '.css': 'text' }, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    let rejectCreate = false;
    let rejectClose = false;
    let listReads = 0, screenReads = 0;
    await page.exposeFunction('terminalAction', async message => {
      const payload = message.payload ?? {};
      try {
        let result = {};
        if (message.action === 'listWorkspaceTerminals') { listReads++; result = { workspaceTerminals: listWorkspaceTerminals() }; }
        else if (message.action === 'workspaceTerminal') {
          if (rejectCreate && payload.terminalRequest.operation === 'create') throw new Error('Fixture terminal backend unavailable');
          if (rejectClose && payload.terminalRequest.operation === 'close') throw new Error('Fixture terminal close refused');
          if (payload.terminalRequest.operation === 'read') screenReads++;
          result = await workspaceTerminal(root, payload.terminalId, payload.terminalRequest, payload.terminalProfile, payload.terminalName);
          result.workspaceTerminals = listWorkspaceTerminals();
        }
        return { type: 'dashboard:action-result', requestId: message.requestId, status: 'completed', payload: result };
      } catch (error) {
        return { type: 'dashboard:action-result', requestId: message.requestId, status: 'failed', error: error.message };
      }
    });
    const subscription = subscribeDashboardRealtime(message => { void page.evaluate(message => window.postMessage(message, '*'), message).catch(() => {}); });
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: message => { void window.terminalAction(message).then(reply => window.postMessage(reply, '*')); } }); });
    await page.route(origin + '/__terminal-ui', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-theme="dark"><body><main id="app"></main><script type="module" src="/__terminal-ui.js"></script></body></html>' }));
    await page.route(origin + '/__terminal-ui.js', route => route.fulfill({ contentType: 'text/javascript', body: compiled.outputFiles[0].text }));
    const started = Date.now();
    await page.goto(origin + '/__terminal-ui');
    await page.addStyleTag({ content: await readFile('media/webview/shared.css', 'utf8') });
    await page.addStyleTag({ content: await readFile('media/webview/quotaSummary.css', 'utf8') });
    await page.locator('.cli-workspace').waitFor();
    const show = page.getByRole('button', { name: 'Show workspace tools', exact: true });
    if (await show.isVisible()) await show.click();
    await page.getByRole('button', { name: 'Add workspace tool', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Terminal', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `add-menu-${width}.png`) });
    await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
    const terminal = page.getByRole('region', { name: 'Interactive terminal', exact: true });
    await terminal.getByRole('button', { name: 'New terminal', exact: true }).click();
    await terminal.getByRole('status').filter({ hasText: 'Terminal ready.' }).waitFor();
    const input = terminal.locator('.xterm-helper-textarea');
    await input.waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.querySelector('.workspace-terminal-screen') && !document.querySelector('.workspace-terminal-status'));
    await input.focus();
    await page.keyboard.type('node -e "console.log(\'STANDALONE_\'+\'TERMINAL_OK\')"');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('STANDALONE_TERMINAL_OK'));
    assert.equal(listWorkspaceTerminals().length, 1);
    const toolbar = terminal.locator(':scope > .workspace-tool-toolbar');
    assert.equal(await terminal.locator('.workspace-terminal-caption').count(), 0, 'No duplicate title/action row');
    assert.equal(await terminal.getByRole('button', { name: /Refresh terminals|Reconnect terminal screen/ }).count(), 1, 'Only one refresh control');
    const bounds = await toolbar.locator(':scope > button, :scope > select, :scope > .workspace-tool-menu').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
    assert.ok(bounds.every(box => Math.abs(box.y - bounds[0].y) < 3), 'All terminal controls stay on one row');
    assert.ok(await toolbar.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Toolbar fits its panel');
    await toolbar.getByRole('button', { name: 'Copy terminal selection', exact: true }).click();
    await terminal.getByRole('status').filter({ hasText: 'Select terminal text to copy.' }).waitFor();
    await toolbar.getByRole('button', { name: 'Find in terminal', exact: true }).click();
    await terminal.getByRole('textbox', { name: 'Find terminal text', exact: true }).fill('STANDALONE_TERMINAL_OK');
    await terminal.getByRole('button', { name: 'Close terminal search', exact: true }).click();
    const beforeList = listReads, beforeScreen = screenReads;
    await toolbar.getByRole('button', { name: 'Refresh terminals', exact: true }).click();
    await terminal.getByRole('status').filter({ hasText: 'Terminal list refreshed.' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.workspace-terminal-status'));
    assert.equal(listReads, beforeList + 1, 'Refresh reads the terminal list once');
    assert.equal(screenReads, beforeScreen + 1, 'The same refresh reconnects the current shell screen');
    await page.waitForFunction(() => document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('STANDALONE_TERMINAL_OK'));
    await page.screenshot({ path: path.join(output, `terminal-${width}.png`) });
    await terminal.getByRole('button', { name: 'Terminal actions', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Show in VS Code', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Rename terminal', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'Rename terminal', exact: true });
    await rename.getByLabel('Terminal name').fill('Standalone shell');
    await rename.getByRole('button', { name: 'Save name', exact: true }).click();
    await terminal.getByRole('status').filter({ hasText: 'Terminal renamed.' }).waitFor();
    assert.equal(listWorkspaceTerminals()[0].name, 'Standalone shell');
    await toolbar.getByRole('button', { name: 'Close terminal', exact: true }).click();
    const close = page.getByRole('dialog', { name: 'Close terminal?', exact: true });
    await close.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(listWorkspaceTerminals().length, 1);
    await toolbar.getByRole('button', { name: 'Close terminal', exact: true }).click();
    rejectClose = true;
    await close.getByRole('button', { name: 'Close terminal', exact: true }).click();
    await terminal.getByRole('status').filter({ hasText: 'Fixture terminal close refused' }).waitFor();
    await close.getByRole('alert').filter({ hasText: 'Fixture terminal close refused' }).waitFor();
    assert.equal(listWorkspaceTerminals().length, 1, 'A refused close keeps the terminal available');
    assert.equal(await close.isVisible(), true, 'Close failures keep confirmation available for retry');
    rejectClose = false;
    await close.getByRole('button', { name: 'Close terminal', exact: true }).click();
    await terminal.getByRole('status').filter({ hasText: 'Terminal closed.' }).waitFor();
    assert.equal(listWorkspaceTerminals().length, 0);
    rejectCreate = true;
    await terminal.getByRole('button', { name: 'New terminal', exact: true }).click();
    await terminal.getByRole('status').filter({ hasText: 'Fixture terminal backend unavailable' }).waitFor();
    await terminal.getByRole('button', { name: 'Refresh terminals', exact: true }).click();
    await terminal.getByRole('status').filter({ hasText: 'Terminal list refreshed.' }).waitFor();
    assert.equal(await terminal.getByRole('button', { name: 'New terminal', exact: true }).isEnabled(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    assert.deepEqual(errors, []);
    subscription();
    await context.close();
    console.log(JSON.stringify({ width, elapsedMs: Date.now() - started, checks: 'add menu, real shell input/output, single toolbar, find/copy, combined refresh, rename, cancel close, refused close and retry, startup failure and refresh recovery' }));
  }
} finally {
  await browser?.close();
  disposeSharedTerminals();
  configureSqliteStateStore(undefined); store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
