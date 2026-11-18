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

it('reads only resources belonging to the selected page and frame', async () => {
  const { page, debug, client } = await fixture();
  client.send.mockImplementation(async (method: string) => method === 'Page.getResourceTree' ? { frameTree: { frame: { id: 'frame', url: 'https://example.com/' }, resources: [{ url: 'https://example.com/app.js' }] } } as any : { content: 'console.log(1)' });
  expect(await browserDebugCommand(page, debug, { operation: 'html', params: { action: 'resource', frameId: 'frame', url: 'https://example.com/app.js' } })).toEqual({ content: 'console.log(1)' });
  for (const [frameId, url] of [['other', 'https://example.com/app.js'], ['frame', 'file:///private'], ['frame', 'https://other.example/private']]) await expect(browserDebugCommand(page, debug, { operation: 'html', params: { action: 'resource', frameId, url } })).rejects.toThrow('this page');
});

it('reads actual listeners and releases remote objects after success and failure', async () => {
  const { page, debug, client } = await fixture();
  client.send.mockImplementation(async (method: string) => {
    if (method === 'Runtime.evaluate') return { result: { objectId: 'selected' } } as any;
    if (method === 'DOMDebugger.getEventListeners') return { listeners: [{ type: 'click', useCapture: false, passive: true, once: false, lineNumber: 3, columnNumber: 0, scriptId: 'script', handler: { description: 'function click() {}' } }] } as any;
    return {} as any;
  });
  expect(await browserDebugCommand(page, debug, { operation: 'styles', selector: '#save', params: { action: 'listeners' } })).toMatchObject({ selector: '#save', listeners: [expect.objectContaining({ type: 'click', lineNumber: 4, handler: 'function click() {}' })] });
  expect(client.send).toHaveBeenLastCalledWith('Runtime.releaseObjectGroup', { objectGroup: 'manager-listeners' });
  client.send.mockImplementation(async (method: string) => { if (method === 'Runtime.evaluate') return { result: { objectId: 'selected' } } as any; if (method === 'DOMDebugger.getEventListeners') throw new Error('Target closed'); return {} as any; });
  await expect(browserDebugCommand(page, debug, { operation: 'styles', params: { action: 'listeners' } })).rejects.toThrow('Target closed');
  expect(client.send).toHaveBeenLastCalledWith('Runtime.releaseObjectGroup', { objectGroup: 'manager-listeners' });
});

it('requires confirmation before changing origin storage and preserves evaluation errors', async () => {
  const { page, debug } = await fixture();
  page.evaluate = vi.fn(async () => { throw new Error('Storage denied'); });
  await expect(browserDebugCommand(page, debug, { operation: 'storage', params: { action: 'clearLocalStorage' } })).rejects.toThrow('confirmed');
  expect(page.evaluate).not.toHaveBeenCalled();
  await expect(browserDebugCommand(page, debug, { operation: 'storage', confirmed: true, params: { action: 'clearLocalStorage' } })).rejects.toThrow('Storage denied');
  await expect(browserDebugCommand(page, debug, { operation: 'storage', confirmed: true, params: { action: 'setLocalStorage', key: 1, value: 'x' } })).rejects.toThrow('storage key');
});
