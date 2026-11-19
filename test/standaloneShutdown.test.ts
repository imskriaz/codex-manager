import { afterEach, expect, it, vi } from 'vitest';
import { WebDashboardServer } from '../src/services/webDashboardServer';
import * as diagnostics from '../src/utils/persistentLog';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each(['standalone-restart', 'extension-uninstall', 'vscode-host-control', 'untrusted-reason'])('logs the authenticated shutdown source (%s) before closing', async requestedReason => {
  vi.useFakeTimers();
  vi.stubEnv('CODEX_MANAGER_ADMIN_TOKEN', 'test-admin');
  const log = vi.spyOn(diagnostics, 'recordPersistentEvent').mockImplementation(() => undefined);
  const server = Object.assign(Object.create(WebDashboardServer.prototype), {getUrl: () => 'http://127.0.0.1:39875'}) as any;
  const response = {end:vi.fn(),statusCode:200};
  await server.handle({method:'POST',url:'/shutdown',headers:{'x-codex-admin':'test-admin','x-codex-shutdown-reason':requestedReason}},response);
  expect(log).toHaveBeenCalledWith('info','node-host','Authenticated standalone shutdown requested',{
    pid:process.pid,reason:requestedReason === 'untrusted-reason' ? 'external-admin' : requestedReason
  });
  expect(response.end).toHaveBeenCalledWith('Shutting down');
  expect(vi.getTimerCount()).toBe(1);
});

it('rejects unauthenticated shutdown without recording a trusted reason or stopping the host', async () => {
  vi.useFakeTimers();
  vi.stubEnv('CODEX_MANAGER_ADMIN_TOKEN', 'test-admin');
  const log = vi.spyOn(diagnostics, 'recordPersistentEvent').mockImplementation(() => undefined);
  const server = Object.assign(Object.create(WebDashboardServer.prototype), {getUrl: () => 'http://127.0.0.1:39875'}) as any;
  const response = {end:vi.fn(),statusCode:200};
  await server.handle({method:'POST',url:'/shutdown',headers:{'x-codex-admin':'wrong','x-codex-shutdown-reason':'standalone-restart'}},response);
  expect(response.statusCode).toBe(403);
  expect(log).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
