import assert from 'node:assert/strict';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { acknowledgeWorkspaceSurface, removeWorkspaceSurface, updateWorkspaceSurface, workspaceSurface } from '../out/services/workspaceSurfaces.js';

// All commands target disposable fixture dashboards, using a real WebSocket for surface state and acknowledgements.
export async function checkWorkspaceSurfaceUi(page, { origin, width, output }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  server.on('connection', socket => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'dashboard:workspace-surface') {
        if (message.state) updateWorkspaceSurface(socket, message.state, command => socket.send(JSON.stringify(command)));
        else removeWorkspaceSurface(socket);
      }
      if (message.type === 'dashboard:workspace-command-result') acknowledgeWorkspaceSurface(socket, message.requestId, message.state, message.error, message.content);
    });
    socket.once('close', () => removeWorkspaceSurface(socket));
  });
  try {
    await page.addInitScript(endpoint => {
      window.__systemFixture = true;
      const socket = window.__fixtureSurfaceSocket = new WebSocket(endpoint);
      socket.addEventListener('message', event => window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(event.data) })));
    }, `ws://127.0.0.1:${server.address().port}`);
    const sessionId = '44444444-4444-4444-8444-444444444444', projectPath = 'E:/remote-project';
    await page.goto(`${origin}/workspace/${sessionId}?device=fixture-system`);
    await page.getByRole('textbox', { name: 'Message Codex', exact: true }).waitFor();
    let surface;
    for (let attempt = 0; attempt < 50; attempt++) {
      surface = (await workspaceSurface(projectPath, { operation: 'list' })).surfaces[0];
      if (surface) break;
      await page.waitForTimeout(100);
    }
    assert.ok(surface, 'The remote workspace registers its own surface over WebSocket.');
    assert.equal(surface.sessionId, sessionId);
    assert.equal(surface.targetDeviceId, 'fixture-system');
    assert.equal(surface.viewport.width, width);
    const command = request => workspaceSurface(projectPath, { ...request, surfaceId: surface.surfaceId, sessionId });
    await command({ operation: 'hide' });
    let result = await command({ operation: 'open', tab: 'browser', url: 'https://example.test/first' });
    assert.equal(result.surfaces[0].panelOpen, true);
    const first = result.surfaces[0].activeTab;
    await page.getByRole('complementary', { name: 'Workspace tools', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Browser URL"]')?.value === 'https://example.test/first');
    assert.equal(await page.getByRole('textbox', { name: 'Browser URL', exact: true }).inputValue(), 'https://example.test/first');
    result = await command({ operation: 'open', tab: 'browser', url: 'https://example.test/second' });
    assert.equal(result.surfaces[0].browserPages.length, 2);
    assert.notEqual(result.surfaces[0].activeTab, first);
    await command({ operation: 'select', tab: first });
    result = await command({ operation: 'read' });
    assert.match(result.content.text, /First fixture page/);
    await command({ operation: 'open', tab: 'terminal' });
    await page.getByRole('button', { name: 'New terminal', exact: true }).click();
    await page.getByRole('combobox', { name: 'Select terminal', exact: true }).locator('option').filter({ hasText: 'Project terminal' }).waitFor({ state: 'attached' });
    result = await command({ operation: 'read' });
    assert.match(result.content.terminalSnapshot.content, /PS fixture>/);
    for (const tab of ['files', 'git', 'reviews', 'agents', 'env']) {
      result = await command({ operation: 'open', tab });
      assert.equal(result.surfaces[0].activeTab, tab);
    }
    const actions = await page.evaluate(() => window.__uiActions.filter(message => ['workspaceBrowser', 'workspaceTerminal'].includes(message.action)));
    assert.ok(actions.length > 0);
    assert.ok(actions.every(message => message.payload.targetDeviceId === 'fixture-system'), 'No browser or terminal operation falls back to the local PC.');
    await command({ operation: 'select', tab: first });
    await page.screenshot({ path: path.join(output, `workspace-surface-${width}.png`) });
    await assert.rejects(workspaceSurface(projectPath, { operation: 'open', surfaceId: surface.surfaceId, sessionId: 'wrong-session', tab: 'browser' }), /surfaceId/);
    console.log(`PASS ${width}px: exact remote surface, WebSocket acknowledgement, open/read/select browser and terminal, all tool tabs, no local fallback.`);
  } finally {
    for (const socket of server.clients) { removeWorkspaceSurface(socket); socket.terminate(); }
    await new Promise(resolve => server.close(resolve));
  }
}
