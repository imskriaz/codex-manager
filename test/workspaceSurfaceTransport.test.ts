import { expect, it, vi } from 'vitest';
import { WebDashboardServer } from '../src/services/webDashboardServer';
import { workspaceSurface, removeWorkspaceSurface } from '../src/services/workspaceSurfaces';
import type { WorkspaceSurfaceState } from '../src/domain/workspaceSurface';

it('registers and acknowledges a surface through the authenticated browser socket handler', async () => {
  const server = new WebDashboardServer({ extensionUri: { fsPath: process.cwd() } } as never, {} as never);
  const internal = server as any;
  const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
  const state: WorkspaceSurfaceState = { surfaceId: 'phone-transport', host: 'browser', viewport: { width: 390, height: 844 }, projectPath: 'D:/transport', sessionId: 'chat', visible: true, panelOpen: false, activeTab: 'env', tabs: [{ id: 'env', kind: 'env', title: 'Env' }], terminals: [], browserPages: [] };
  try {
    await internal.handleBrowserSocketMessage(JSON.stringify({ type: 'dashboard:workspace-surface', state }), socket);
    expect((await workspaceSurface(state.projectPath, { operation: 'list' })).surfaces).toEqual([state]);
    const command = workspaceSurface(state.projectPath, { operation: 'select', surfaceId: state.surfaceId, sessionId: state.sessionId, tab: 'env' });
    const message = JSON.parse(socket.send.mock.calls[0]![0]);
    expect(message.type).toBe('dashboard:workspace-command');
    await internal.handleBrowserSocketMessage(JSON.stringify({ type: 'dashboard:workspace-command-result', requestId: message.requestId, state: { ...state, panelOpen: true } }), socket);
    expect((await command).surfaces[0]?.panelOpen).toBe(true);
    await internal.handleBrowserSocketMessage(JSON.stringify({ type: 'dashboard:workspace-surface' }), socket);
    expect((await workspaceSurface(state.projectPath, { operation: 'list' })).surfaces).toEqual([]);
  } finally { removeWorkspaceSurface(socket); await server.stop(); server.dispose(); }
});
