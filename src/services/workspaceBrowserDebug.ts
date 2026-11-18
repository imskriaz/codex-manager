import type { CDPSession, Page } from 'playwright-core';
import type { BrowserDebugEvent, WorkspaceBrowserRequest } from '../domain/workspaceBrowser';
import { browserUrl } from '../domain/workspaceBrowser';
import { waitWithin } from '../utils/concurrency';

const domains = new Set(['Accessibility', 'Animation', 'Audits', 'CSS', 'CacheStorage', 'DOM', 'DOMDebugger', 'DOMSnapshot', 'DOMStorage', 'Debugger', 'Emulation', 'Fetch', 'IndexedDB', 'Input', 'Inspector', 'LayerTree', 'Log', 'Media', 'Network', 'Overlay', 'Page', 'Performance', 'PerformanceTimeline', 'Profiler', 'Runtime', 'Security', 'WebAudio', 'WebAuthn']);
const blocked = new Set(['Page.setDownloadBehavior', 'DOM.setFileInputFiles', 'Network.clearBrowserCache', 'Network.clearBrowserCookies', 'Network.getAllCookies']);
const defaults = ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed', 'Network.webSocketCreated', 'Network.webSocketFrameReceived', 'Network.webSocketFrameSent', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded', 'Page.javascriptDialogOpening', 'Page.frameNavigated', 'DOMStorage.domStorageItemAdded', 'DOMStorage.domStorageItemUpdated', 'DOMStorage.domStorageItemRemoved', 'DOMStorage.domStorageItemsCleared', 'Fetch.requestPaused', 'Fetch.authRequired', 'CSS.styleSheetAdded', 'Debugger.paused', 'Debugger.resumed'];
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
      client.send('Runtime.enable'), client.send('Page.enable'), client.send('DOMStorage.enable'), client.send('Log.enable')
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
  if (r.operation === 'html') {
    if (r.params?.['action'] === 'metrics') { await debug.client.send('Performance.enable'); return debug.client.send('Performance.getMetrics'); }
    if (r.params?.['action'] === 'heap') return debug.client.send('Runtime.getHeapUsage');
    if (r.params?.['action'] === 'response') {
      if (typeof r.params['requestId'] !== 'string') throw new Error('Choose a captured request.');
      return debug.client.send('Network.getResponseBody', { requestId: r.params['requestId'] });
    }
    if (r.params?.['action'] === 'resources') return debug.client.send('Page.getResourceTree');
    if (r.params?.['action'] === 'resource') {
      const { frameId, url } = r.params;
      if (typeof frameId !== 'string' || typeof url !== 'string') throw new Error('Choose a page resource.');
      const { frameTree } = await debug.client.send('Page.getResourceTree');
      const belongs = (tree: typeof frameTree): boolean => tree.frame.id === frameId && (tree.frame.url === url || tree.resources.some(resource => resource.url === url)) || (tree.childFrames ?? []).some(belongs);
      if (!belongs(frameTree)) throw new Error('Choose a resource from this page.');
      return debug.client.send('Page.getResourceContent', { frameId, url });
    }
    return r.selector ? page.locator(r.selector).evaluate(element => element.outerHTML) : page.content();
  }
  if (r.operation === 'styles') {
    const picked = r.x !== undefined && r.y !== undefined ? await page.evaluate(({ x, y }) => {
      let element = document.elementFromPoint(x, y);
      if (!element) throw new Error('No element at this point.');
      const rect = element.getBoundingClientRect();
      const parts: string[] = [];
      while (element) {
        const tag = element.tagName.toLowerCase();
        const siblings = element.parentElement ? Array.from(element.parentElement.children).filter(sibling => sibling.tagName === element!.tagName) : [element];
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(element) + 1})`);
        element = element.parentElement;
      }
      return { selector: parts.join(' > '), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    }, { x: r.x, y: r.y }) : r.selector || 'body';
    const selector = typeof picked === 'string' ? picked : picked.selector;
    if (r.params?.['action'] === 'listeners') {
      const expression = r.params['ancestors'] === true ? `(() => { let element = document.querySelector(${JSON.stringify(selector)}); const targets = []; while (element) { targets.push(element); element = element.parentNode; } targets.push(window); return targets; })()` : `document.querySelector(${JSON.stringify(selector)})`;
      const result = await debug.client.send('Runtime.evaluate', { expression, objectGroup: 'manager-listeners' });
      const objectId = result.result.objectId;
      if (!objectId) throw new Error('The selected element is no longer available. Select it again.');
      try {
        const targets = r.params['ancestors'] === true ? (await debug.client.send('Runtime.getProperties', { objectId, ownProperties: true })).result.filter(property => /^\d+$/.test(property.name) && property.value?.objectId).map(property => property.value!) : [{ objectId, description: selector }];
        const listeners = [];
        for (const target of targets) {
          const result = await debug.client.send('DOMDebugger.getEventListeners', { objectId: target.objectId!, depth: 0, pierce: true });
          listeners.push(...result.listeners.map(listener => ({ target: target.description, type: listener.type, useCapture: listener.useCapture, passive: listener.passive, once: listener.once, lineNumber: listener.lineNumber + 1, columnNumber: listener.columnNumber + 1, scriptId: listener.scriptId, handler: listener.handler?.description })));
        }
        return { selector, listeners };
      } finally { await debug.client.send('Runtime.releaseObjectGroup', { objectGroup: 'manager-listeners' }); }
    }
    const value = await page.locator(selector).evaluate((element, selector) => ({ selector, rect: (() => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })(), html: element.outerHTML, styles: Object.fromEntries(Array.from(getComputedStyle(element), key => [key, getComputedStyle(element).getPropertyValue(key)])) }), selector);
    if (r.params?.['action'] !== 'rules') return value;
    await debug.client.send('DOM.enable');
    await debug.client.send('CSS.enable');
    const documentResult = await debug.client.send('DOM.getDocument');
    const { nodeId } = await debug.client.send('DOM.querySelector', { nodeId: documentResult.root.nodeId, selector });
    const matched = await debug.client.send('CSS.getMatchedStylesForNode', { nodeId });
    return { ...value, rules: [{ selector: 'element.style', declarations: matched.inlineStyle?.cssText ?? '' }, ...(matched.matchedCSSRules ?? []).map(({ rule }) => ({ selector: rule.selectorList.text, declarations: rule.style.cssText ?? rule.style.cssProperties.filter(property => !property.implicit).map(property => `${property.name}: ${property.value}${property.important ? ' !important' : ''};`).join('\n') }))] };
  }
  if (r.operation === 'storage') {
    const action = r.params?.['action'] ?? 'read';
    if (action === 'read') return { cookies: await page.context().cookies(), ...(await page.evaluate(async () => {
      if (location.origin === 'null') return { origin: location.origin, localStorage: {}, sessionStorage: {}, indexedDB: [], cacheStorage: [], serviceWorkers: [] };
      return { origin: location.origin, localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage }, indexedDB: await indexedDB.databases(), cacheStorage: 'caches' in window ? await caches.keys() : [], serviceWorkers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).map(registration => ({ scope: registration.scope, scriptURL: registration.active?.scriptURL, state: registration.active?.state })) : [] };
    })) };
    if (r.confirmed !== true) throw new Error('Storage changes require confirmed=true.');
    if (action === 'setCookies' && Array.isArray(r.params?.['cookies'])) { await page.context().addCookies(r.params['cookies'] as Parameters<ReturnType<Page['context']>['addCookies']>[0]); return { updated: true }; }
    if (action === 'clearCookies') { await page.context().clearCookies(); return { cleared: true }; }
    if (action === 'clearLocalStorage' || action === 'clearSessionStorage') { await page.evaluate(action => { (action === 'clearLocalStorage' ? localStorage : sessionStorage).clear(); }, action); return { cleared: true }; }
    if (action === 'setLocalStorage' || action === 'setSessionStorage' || action === 'removeLocalStorage' || action === 'removeSessionStorage') {
      const { key, value } = r.params ?? {};
      if (typeof key !== 'string' || key.length > 2000 || action.startsWith('set') && typeof value !== 'string') throw new Error('Provide a storage key and string value.');
      await page.evaluate(({ action, key, value }) => { const storage = action.endsWith('LocalStorage') ? localStorage : sessionStorage; if (action.startsWith('remove')) storage.removeItem(key); else storage.setItem(key, value!); }, { action, key, value: value as string | undefined });
      return { updated: true };
    }
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
