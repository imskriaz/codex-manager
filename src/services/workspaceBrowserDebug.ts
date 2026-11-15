import type { CDPSession, Page } from 'playwright-core';
import type { BrowserDebugEvent, WorkspaceBrowserRequest } from '../domain/workspaceBrowser';
import { browserUrl } from '../domain/workspaceBrowser';
import { waitWithin } from '../utils/concurrency';

const domains = new Set(['Accessibility', 'Animation', 'Audits', 'CSS', 'CacheStorage', 'DOM', 'DOMDebugger', 'DOMSnapshot', 'DOMStorage', 'Debugger', 'Emulation', 'Fetch', 'IndexedDB', 'Input', 'Inspector', 'LayerTree', 'Log', 'Media', 'Network', 'Overlay', 'Page', 'Performance', 'PerformanceTimeline', 'Profiler', 'Runtime', 'Security', 'WebAudio', 'WebAuthn']);
const blocked = new Set(['Page.setDownloadBehavior', 'DOM.setFileInputFiles', 'Network.clearBrowserCache', 'Network.clearBrowserCookies', 'Network.getAllCookies']);
const defaults = ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed', 'Network.webSocketCreated', 'Network.webSocketFrameReceived', 'Network.webSocketFrameSent', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Page.javascriptDialogOpening', 'Page.frameNavigated', 'DOMStorage.domStorageItemAdded', 'DOMStorage.domStorageItemUpdated', 'DOMStorage.domStorageItemRemoved', 'DOMStorage.domStorageItemsCleared', 'Fetch.requestPaused', 'Fetch.authRequired', 'CSS.styleSheetAdded', 'Debugger.paused'];
export type BrowserDebugger = { client: CDPSession; events: BrowserDebugEvent[]; sequence: number; subscribed: Set<string> };

export function validateDebugMethod(method: string): void {
  if (!domains.has(method.split('.')[0]!) || blocked.has(method)) throw new Error('This command is outside the project page DevTools scope. Use Manager file APIs for host files and storage for context cookies.');
}

export async function createBrowserDebugger(page: Page): Promise<BrowserDebugger> {
  const client = await page.context().newCDPSession(page);
  const debug: BrowserDebugger = { client, events: [], sequence: 0, subscribed: new Set() };
  subscribe(debug, defaults);
  try {
    await waitWithin(Promise.all([
      client.send('Network.enable', { maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024, maxPostDataSize: 64 * 1024 }),
      client.send('Runtime.enable'), client.send('Page.enable'), client.send('DOMStorage.enable')
    ]), 5000, 'Browser diagnostics startup timed out.');
    return debug;
  } catch (error) { await client.detach().catch(() => undefined); throw error; }
}

function subscribe(debug: BrowserDebugger, names: string[]): void {
  for (const name of names) validateDebugMethod(name);
  if (new Set([...debug.subscribed, ...names]).size > 64) throw new Error('Browser event subscription capacity reached (64). Close and reopen the page.');
  for (const name of names) {
    if (debug.subscribed.has(name)) continue;
    debug.subscribed.add(name);
    debug.client.on(name as Parameters<CDPSession['on']>[0], (params: unknown) => {
      const encoded = JSON.stringify(params) ?? 'null';
      debug.events.push({ sequence: ++debug.sequence, timestamp: Date.now(), method: name, params: encoded.length > 8000 ? { preview: encoded.slice(0, 8000) } : params, ...(encoded.length > 8000 ? { truncated: true } : {}) });
      if (debug.events.length > 100) debug.events.shift();
      // Abandoned interception/breakpoints must not leave the shared page frozen.
      if (name === 'Debugger.paused') { const timer = setTimeout(() => { void debug.client.send('Debugger.resume').catch(() => undefined); }, 15_000); timer.unref(); }
      const requestId = (params as { requestId?: string })?.requestId;
      if ((name === 'Fetch.requestPaused' || name === 'Fetch.authRequired') && requestId) {
        const timer = setTimeout(() => {
          const resume = name === 'Fetch.authRequired'
            ? debug.client.send('Fetch.continueWithAuth', { requestId, authChallengeResponse: { response: 'CancelAuth' } })
            : debug.client.send('Fetch.continueRequest', { requestId });
          void resume.catch(() => undefined);
        }, 15_000);
        timer.unref();
      }
    });
  }
}

export async function browserDebugCommand(page: Page, debug: BrowserDebugger, r: WorkspaceBrowserRequest): Promise<unknown> {
  if (r.operation === 'html') return r.selector ? page.locator(r.selector).evaluate(element => element.outerHTML) : page.content();
  if (r.operation === 'styles') return page.locator(r.selector || 'body').evaluate(element => ({ html: element.outerHTML, styles: Object.fromEntries(Array.from(getComputedStyle(element), key => [key, getComputedStyle(element).getPropertyValue(key)])) }));
  if (r.operation === 'storage') {
    const action = r.params?.['action'] ?? 'read';
    if (action === 'read') return { cookies: await page.context().cookies(), ...(await page.evaluate(() => ({ origin: location.origin, localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } }))) };
    if (r.confirmed !== true) throw new Error('Storage changes require confirmed=true.');
    if (action === 'setCookies' && Array.isArray(r.params?.['cookies'])) { await page.context().addCookies(r.params['cookies'] as Parameters<ReturnType<Page['context']>['addCookies']>[0]); return { updated: true }; }
    if (action === 'clearCookies') { await page.context().clearCookies(); return { cleared: true }; }
    throw new Error('Use storage action read, setCookies, or clearCookies. Change local/session storage with evaluate and IndexedDB/cache with DevTools.');
  }
  if (r.operation !== 'cdp' || !r.method) throw new Error('Choose a DevTools method.');
  if (r.confirmed !== true) throw new Error('DevTools execution requires confirmed=true.');
  validateDebugMethod(r.method);
  // Page commands cannot select another project context or route to another target.
  const check = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (['browserContextId', 'targetId', 'sessionId'].includes(key)) throw new Error('Cross-target DevTools parameters are not permitted.');
      if (key === 'url') browserUrl(nested as string);
      check(nested);
    }
  };
  check(r.params);
  subscribe(debug, r.eventNames ?? []);
  return waitWithin(debug.client.send(r.method as Parameters<CDPSession['send']>[0], r.params), 5000, 'DevTools outcome is unknown. Read events and state before retrying.');
}
