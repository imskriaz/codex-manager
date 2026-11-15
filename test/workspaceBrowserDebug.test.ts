import { afterEach, expect, it, vi } from 'vitest';
import { browserDebugCommand, createBrowserDebugger, validateDebugMethod } from '../src/services/workspaceBrowserDebug';

afterEach(() => vi.useRealTimers());
const fixture = async () => {
  const handlers = new Map<string, (value: unknown) => void>();
  const client = { on: (name: string, handler: (value: unknown) => void) => handlers.set(name, handler), send: vi.fn(async () => ({ ok: true })), detach: vi.fn(async () => undefined) };
  const page = { context: () => ({ newCDPSession: async () => client }) } as any;
  return { page, client, handlers, debug: await createBrowserDebugger(page) };
};

it('fences DevTools commands to the selected project page and requires confirmation', async () => {
  const { page, debug, client } = await fixture();
  for (const method of ['Browser.close', 'Target.attachToTarget', 'DOM.setFileInputFiles', 'Network.clearBrowserCookies']) expect(() => validateDebugMethod(method)).toThrow();
  await expect(browserDebugCommand(page, debug, { operation: 'cdp', method: 'Runtime.evaluate' })).rejects.toThrow('confirmed');
  for (const params of [{ browserContextId: 'other' }, { nested: { targetId: 'other' } }, { url: 'file:///private' }]) await expect(browserDebugCommand(page, debug, { operation: 'cdp', confirmed: true, method: 'Page.navigate', params })).rejects.toThrow();
  const params = { requestId: 'response-one' };
  expect(await browserDebugCommand(page, debug, { operation: 'cdp', confirmed: true, method: 'Network.getResponseBody', params })).toEqual({ ok: true });
  expect(client.send).toHaveBeenLastCalledWith('Network.getResponseBody', params);
});

it('bounds diagnostic history and reports truncated events while preserving cursors', async () => {
  const { debug, handlers } = await fixture();
  for (let i = 0; i < 101; i++) handlers.get('Network.responseReceived')!({ requestId: String(i) });
  expect(debug.events).toHaveLength(100);
  expect(debug.events[0]?.sequence).toBe(2);
  handlers.get('Runtime.consoleAPICalled')!({ text: 'x'.repeat(9000) });
  expect(debug.events.at(-1)).toMatchObject({ sequence: 102, truncated: true });
});

it('releases abandoned network interception after its bounded wait', async () => {
  vi.useFakeTimers();
  const { handlers, client } = await fixture();
  handlers.get('Fetch.requestPaused')!({ requestId: 'pending-one' });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(client.send).toHaveBeenLastCalledWith('Fetch.continueRequest', { requestId: 'pending-one' });
});
