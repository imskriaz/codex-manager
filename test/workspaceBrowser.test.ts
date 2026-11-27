import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserUrl, validateBrowserRequest } from "../src/domain/workspaceBrowser";
vi.mock('../src/services/workspaceBrowserDebug', () => ({ createBrowserDebugger: async () => ({ events: [], sequence: 0 }), browserDebugCommand: vi.fn(async () => 'document') }));
import { browserDebugCommand } from '../src/services/workspaceBrowserDebug';
import { chromium } from 'playwright-core';
const m = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  failStorage: false,
  contexts: [] as any[],
  browser: undefined as any
}));
vi.mock("../src/storage/sqliteState", () => ({
  getSqliteStateStore: () => ({
    get: (_: string, key: string) => m.values.get(key),
    set: (_: string, key: string, value: unknown) => {
      if (m.failStorage) throw new Error("disk full");
      m.values.set(key, value);
    }
  })
}));
vi.mock("playwright-core", () => ({
  chromium: {
    launch: vi.fn(async () => {
      let connected = true;
      const instance = {
        isConnected: () => connected,
        on: vi.fn(),
        close: vi.fn(async () => {
          connected = false;
        }),
        newContext: vi.fn(async () => {
          const handlers = new Map<string, (value: any) => void>();
          const context = {
            route: vi.fn(async()=>{}),
            routeWebSocket: vi.fn(async()=>{}),
            addInitScript: vi.fn(async()=>{}),
            setDefaultTimeout: vi.fn(),
            setDefaultNavigationTimeout: vi.fn(),
            on: (name: string, fn: any) => handlers.set(name, fn),
            close: vi.fn(async () => undefined),
            newPage: vi.fn(async () => {
              const events = new Map<string, (value?: any) => void>();
              let url = "about:blank";
              let closed = false;
              const page = {
                on: (name: string, fn: any) => events.set(name, fn),
                off: (name: string) => events.delete(name),
                mainFrame: () => page,
                url: () => url,
                title: async () => "Development",
                goto: vi.fn(async (value: string) => {
                  url = value;
                  events.get("framenavigated")?.(page);
                }),
                screenshot: vi.fn(async () => Buffer.from("image")),
                isClosed: () => closed,
                close: vi.fn(async () => {
                  closed = true;
                  events.get("close")?.();
                }),
                locator: () => ({ count: async () => 1, ariaSnapshot: async () => '- button "Save"', click: vi.fn(async () => undefined), hover: vi.fn(async () => undefined), scrollIntoViewIfNeeded: vi.fn(async () => undefined), boundingBox: async () => ({ x: 10, y: 20, width: 80, height: 40 }) }),
                mouse: { click: vi.fn(async () => undefined), move: vi.fn(async () => undefined) },
                keyboard: { insertText: vi.fn(async () => undefined) }
              };
              handlers.get("page")?.(page);
              return page;
            })
          };
          m.contexts.push(context);
          return context;
        })
      };
      m.browser = instance;
      return instance;
    })
  }
}));
import { workspaceBrowser, disposeWorkspaceBrowsers } from "../src/services/workspaceBrowser";
const project = "C:/project-browser";
const open = (id = "open-one") =>
  workspaceBrowser(project, { operation: "open", operationId: id, url: "http://localhost:3000" });
beforeEach(() => {
  m.values.clear();
  m.contexts.length = 0;
  m.failStorage = false;
});
afterEach(async () => {
  await disposeWorkspaceBrowsers();
  vi.unstubAllEnvs();
});

it.runIf(process.platform === 'win32')('falls back to Chromium when Windows Edge exits during startup', async () => {
  vi.stubEnv('CODEX_MANAGER_BROWSER', undefined);
  const launch = vi.mocked(chromium.launch);
  launch.mockClear();
  launch.mockRejectedValueOnce(new Error('Target page, context or browser has been closed\nBrowser logs: large diagnostics'));
  const result = await open('edge-fallback');
  expect(launch.mock.calls.map(([options]) => options?.channel)).toEqual(['msedge', undefined]);
  expect(result.pages).toEqual([expect.objectContaining({ url: 'http://localhost:3000/' })]);
});

it('reports a concise launch error when the configured browser fails', async () => {
  vi.stubEnv('CODEX_MANAGER_BROWSER', 'msedge');
  const launch = vi.mocked(chromium.launch);
  launch.mockClear();
  launch.mockRejectedValueOnce(new Error('Target page, context or browser has been closed\nBrowser logs: large diagnostics'));
  await expect(open('configured-edge-error')).rejects.toThrow(/^Workspace Browser could not start\. msedge: Target page, context or browser has been closed$/);
  expect(launch).toHaveBeenCalledTimes(1);
});

it("validates browser URLs and untrusted feedback before execution", () => {
  expect(browserUrl("http://localhost:3000")).toBe("http://localhost:3000/");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "http://user:secret@example.com"])
    expect(() => browserUrl(url)).toThrow();
  expect(() => validateBrowserRequest({ operation: "feedback", feedback: {} })).toThrow();
  expect(() => validateBrowserRequest({ operation: "feedback", feedback: { kind: "comment", text: "Missing identifiers", points: [{ x: 1, y: 1 }] } })).toThrow();
  expect(() => browserUrl(["https://example.com"] as any)).toThrow();
  expect(() => validateBrowserRequest({ operation: "click", x: NaN })).toThrow();
});
it("opens a blank download page without requiring a development server or diagnostics", async () => {
  const request = { operation: "open", operationId: "download-page" };
  const first = await workspaceBrowser(project, request);
  const page = await m.contexts[0].newPage.mock.results[0].value;
  expect(first.pages).toEqual([expect.objectContaining({ id: first.pageId, url: "about:blank" })]);
  expect(first.revision).toBeTruthy();
  expect(first.image).toBeUndefined();
  expect(page.goto).not.toHaveBeenCalled();
  expect((await workspaceBrowser(project, request)).pageId).toBe(first.pageId);
  expect(m.contexts[0].newPage).toHaveBeenCalledTimes(1);
  const explicit = await workspaceBrowser(project, { operation: "open", operationId: "blank-page", url: "about:blank" });
  expect(explicit.pages.find(item => item.id === explicit.pageId)?.url).toBe("about:blank");
  for (const url of ["file:///private", "javascript:alert(1)", "about:config", ""]) {
    await expect(workspaceBrowser(project, { operation: "open", operationId: `invalid-${url.length}`, url })).rejects.toThrow();
  }
  expect(m.contexts[0].newPage).toHaveBeenCalledTimes(2);
});
it("shares pages, rejects stale writes, and never repeats an operation ID", async () => {
  const first = await open();
  expect(first.pages).toHaveLength(1);
  expect((await open()).pageId).toBe(first.pageId);
  expect(m.contexts[0].newPage).toHaveBeenCalledTimes(1);
  await expect(
    workspaceBrowser(project, { operation: "open", operationId: "open-one", url: "https://example.com" })
  ).rejects.toThrow("different operation");
  await expect(
    workspaceBrowser(project, {
      operation: "click",
      operationId: "click-one",
      pageId: first.pageId,
      revision: "stale",
      x: 2,
      y: 2
    })
  ).rejects.toThrow("changed");
  const snapshot = await workspaceBrowser(project, { operation: "snapshot", pageId: first.pageId });
  expect(snapshot.text).toContain("Save");
  expect((await workspaceBrowser("C:/other-project", { operation: "list" })).pages).toHaveLength(0);
});
it('lists user and AI tabs together and preserves provenance when either client operates on them', async () => {
  const user = await open('manual-tab');
  const ai = await workspaceBrowser(project, { operation: 'open', operationId: 'ai-tab', openedBy: 'ai', url: 'http://localhost:3000' });
  expect(ai.pages).toEqual(expect.arrayContaining([expect.objectContaining({ id: user.pageId }), expect.objectContaining({ id: ai.pageId, openedBy: 'ai' })]));
  const clicked = await workspaceBrowser(project, { operation: 'click', operationId: 'ai-clicks-user-tab', openedBy: 'ai', pageId: user.pageId, revision: user.revision, x: 1, y: 1 });
  expect(clicked.pageId).toBe(user.pageId);
  expect(clicked.pages.find(page => page.id === user.pageId)?.openedBy).toBeUndefined();
  expect((await workspaceBrowser(project, { operation: 'list' })).pages.find(page => page.id === ai.pageId)?.openedBy).toBe('ai');
  expect(() => validateBrowserRequest({ operation: 'open', openedBy: 'unknown' })).toThrow('origin');
});
it('keeps browser tabs isolated by session while sharing them within that session', async () => {
  const first = await workspaceBrowser(project, { operation: 'open', operationId: 'session-a-open', sessionId: 'session-a', url: 'http://localhost:3000' });
  const second = await workspaceBrowser(project, { operation: 'open', operationId: 'session-b-open', sessionId: 'session-b', url: 'http://localhost:3000' });
  expect((await workspaceBrowser(project, { operation: 'list', sessionId: 'session-a' })).pages.map(page => page.id)).toEqual([first.pageId]);
  expect((await workspaceBrowser(project, { operation: 'list', sessionId: 'session-b' })).pages.map(page => page.id)).toEqual([second.pageId]);
  expect(first.pageId).not.toBe(second.pageId);
  expect((await workspaceBrowser(project, { operation: 'list' })).pages).toHaveLength(0);
});
it("stores feedback before acknowledging it, reports disk failures, and preserves feedback after browser reboot", async () => {
  const page = await open();
  const feedback = {
    id: "feedback-one",
    pageId: page.pageId,
    revision: page.revision,
    kind: "area",
    points: [
      { x: 10, y: 10 },
      { x: 50, y: 60 }
    ],
    text: "Make this wider",
    referenceUrl: "https://example.com"
  };
  const request = {
    operation: "feedback",
    operationId: "feedback-save",
    pageId: page.pageId,
    revision: page.revision,
    feedback
  };
  m.failStorage = true;
  await expect(workspaceBrowser(project, request)).rejects.toThrow("disk full");
  m.failStorage = false;
  const saved = await workspaceBrowser(project, { ...request, operationId: "feedback-retry" });
  expect(saved.feedback[0]?.text).toBe("Make this wider");
  expect(saved.feedback[0]?.image).toBeUndefined();
  expect(
    (await workspaceBrowser(project, { operation: "readFeedback", feedbackId: feedback.id })).feedbackImage
  ).toMatch(/^data:image\/jpeg;base64,/);
  await disposeWorkspaceBrowsers();
  const restored = await workspaceBrowser(project, { operation: "list" });
  expect(restored.feedback).toHaveLength(1);
  expect(restored.pages).toHaveLength(0);
  expect(
    (await workspaceBrowser(project, { operation: "readFeedback", feedbackId: feedback.id })).feedbackImage
  ).toBeDefined();
  await expect(workspaceBrowser(project, { operation: "screenshot", pageId: page.pageId })).rejects.toThrow(
    "no longer open"
  );
});
it("bounds page count and rejects concurrent work instead of queuing manual actions", async () => {
  const pending = open();
  await expect(open("open-two")).rejects.toThrow("running");
  await pending;
  for (let i = 1; i < 8; i++) await open(`page-${i}`);
  await expect(open("ninth-page")).rejects.toThrow("Eight");
  expect((await workspaceBrowser(project, { operation: "list" })).pages).toHaveLength(8);
});

it('releases project capacity when the last page closes itself', async () => {
  await open();
  for (let index = 1; index < 4; index++) await workspaceBrowser(`C:/browser-${index}`, { operation: 'open', operationId: `open-${index}`, url: 'http://localhost:3000' });
  await expect(workspaceBrowser('C:/browser-five', { operation: 'open', operationId: 'too-many', url: 'http://localhost:3000' })).rejects.toThrow('Four browser sessions');
  const page = await m.contexts[0].newPage.mock.results[0].value;
  await page.close();
  expect((await workspaceBrowser('C:/browser-five', { operation: 'open', operationId: 'after-close', url: 'http://localhost:3000' })).pages).toHaveLength(1);
});

it('never labels HTML from an earlier navigation with the current page revision', async () => {
  const first = await open();
  vi.mocked(browserDebugCommand).mockImplementationOnce(async () => {
    await workspaceBrowser(project, { operation: 'navigate', operationId: 'inspection-nav', pageId: first.pageId, revision: first.revision, url: 'https://example.com/new-page' });
    return 'earlier document';
  });
  await expect(workspaceBrowser(project, { operation: 'html', pageId: first.pageId })).rejects.toThrow('changed during inspection');
});

it('returns the opened tab and a warning when navigation changes during preview capture', async () => {
  const first = await open();
  const page = await m.contexts[0].newPage.mock.results[0].value;
  page.screenshot.mockImplementationOnce(async () => { await page.goto('https://example.com/login'); return Buffer.from('old'); });
  const result = await workspaceBrowser(project, { operation: 'navigate', operationId: 'redirect', pageId: first.pageId, revision: first.revision, url: 'https://example.com' });
  expect(result.pageId).toBe(first.pageId);
  expect(result.pages[0]?.url).toBe('https://example.com/login');
  expect(result.image).toBeUndefined();
  expect(result.warning).toContain('action completed');
  expect(page.goto).toHaveBeenCalledTimes(3);
  expect((await workspaceBrowser(project, { operation: 'snapshot', pageId: first.pageId })).image).toBeDefined();
});

it('keeps successful clicks visible when screenshot capture fails without replaying the click', async () => {
  const first = await open();
  const page = await m.contexts[0].newPage.mock.results[0].value;
  page.screenshot.mockRejectedValueOnce(new Error('Capture timed out'));
  const result = await workspaceBrowser(project, { operation: 'click', operationId: 'capture-failure', pageId: first.pageId, revision: first.revision, x: 22, y: 33 });
  expect(result.warning).toContain('Capture timed out');
  expect(result.pageId).toBe(first.pageId);
  expect(page.mouse.click).toHaveBeenCalledOnce();
});

it('shares only AI pointer coordinates and operation names, clears them on navigation and human input', async () => {
  const first = await open();
  const hovered = await workspaceBrowser(project, { operation: 'hover', operationId: 'agent-hover', openedBy: 'ai', pageId: first.pageId, revision: first.revision, selector: 'button' });
  expect(hovered.agentPointer).toEqual({ x: 50, y: 40, action: 'hover', updatedAt: expect.any(Number) });
  expect((await workspaceBrowser(project, { operation: 'screenshot', pageId: first.pageId })).agentPointer).toEqual(hovered.agentPointer);
  expect((await workspaceBrowser(project, { operation: 'screenshot', pageId: first.pageId })).agentActivity).toEqual(hovered.agentActivity);
  const capturedPage = await m.contexts[0].newPage.mock.results[0].value;
  expect(capturedPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({ caret: 'initial' }));
  const moved = await workspaceBrowser(project, { operation: 'hover', operationId: 'coordinate-hover', openedBy: 'ai', pageId: first.pageId, revision: hovered.revision, x: 8, y: 9 });
  expect(moved.agentPointer).toMatchObject({ x: 8, y: 9, action: 'hover' });
  const human = await workspaceBrowser(project, { operation: 'click', operationId: 'human-click', pageId: first.pageId, revision: moved.revision, x: 2, y: 3 });
  expect(human.agentPointer).toBeUndefined();
  expect(human.agentActivity).toBeUndefined();
  const agent = await workspaceBrowser(project, { operation: 'click', operationId: 'agent-click', openedBy: 'ai', pageId: first.pageId, revision: human.revision, x: 2, y: 3 });
  const nav = await workspaceBrowser(project, { operation: 'navigate', operationId: 'pointer-nav', pageId: first.pageId, revision: agent.revision, url: 'https://example.com/new' });
  expect(nav.agentPointer).toBeUndefined();
});

it('reports live AI activity and pointer while a click is pending without allowing concurrent mutations', async () => {
  const first = await open();
  const page = await m.contexts[0].newPage.mock.results[0].value;
  let complete!: () => void;
  page.mouse.click.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const click = workspaceBrowser(project, { operation: 'click', operationId: 'live-click', openedBy: 'ai', pageId: first.pageId, revision: first.revision, x: 12, y: 34 });
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  const live = await workspaceBrowser(project, { operation: 'list', pageId: first.pageId });
  expect(live.agentActivity).toMatchObject({ operation: 'click', status: 'running' });
  expect(live.agentPointer).toMatchObject({ x: 12, y: 34 });
  await expect(workspaceBrowser(project, { operation: 'close', operationId: 'conflict', pageId: first.pageId, revision: first.revision })).rejects.toThrow('running');
  complete();
  expect((await click).agentActivity?.status).toBe('completed');
});

it('shows AI inspection activity without clearing it during a human preview read', async () => {
  const first = await open();
  const result = await workspaceBrowser(project, { operation: 'snapshot', openedBy: 'ai', pageId: first.pageId });
  expect(result.agentActivity).toMatchObject({ operation: 'snapshot', status: 'completed' });
  const mirrored = await workspaceBrowser(project, { operation: 'screenshot', pageId: first.pageId });
  expect(mirrored.agentActivity).toEqual(result.agentActivity);
});

it('moves and resizes saved marks with revision and concurrent-edit protection', async () => {
  const first = await open();
  const feedback = { id: 'editable-mark', pageId: first.pageId!, revision: first.revision!, kind: 'area' as const, points: [{ x: 10, y: 10 }, { x: 50, y: 50 }], text: 'Original' };
  const saved = await workspaceBrowser(project, { operation: 'feedback', operationId: 'save-editable', pageId: first.pageId, revision: first.revision, feedback });
  const mark = saved.feedback[0]!;
  const expected = JSON.stringify([mark.id, mark.createdAt, mark.text, mark.points, mark.referenceUrl ?? '']);
  const changed = { ...feedback, points: [{ x: 20, y: 30 }, { x: 120, y: 130 }] };
  const updated = await workspaceBrowser(project, { operation: 'updateFeedback', operationId: 'move-editable', pageId: first.pageId, revision: first.revision, feedback: changed, params: { expected } });
  expect(updated.feedback[0]?.points).toEqual(changed.points);
  await expect(workspaceBrowser(project, { operation: 'updateFeedback', operationId: 'stale-edit', pageId: first.pageId, revision: first.revision, feedback, params: { expected } })).rejects.toThrow('edited elsewhere');
  expect((await workspaceBrowser(project, { operation: 'list' })).feedback[0]?.points).toEqual(changed.points);
});

it('isolates user pages, feedback, routing and browser contexts from the master and another user',async()=>{
 const route=vi.fn(async()=>{});
 const first=await workspaceBrowser(project,{operation:'open',operationId:'same-id',url:'about:blank'},{owner:'alex',route});
 const other=await workspaceBrowser(project,{operation:'list'},{owner:'sam',route});
 const master=await workspaceBrowser(project,{operation:'list'});
 expect(first.pages).toHaveLength(1);expect(other.pages).toEqual([]);expect(master.pages).toEqual([]);
 expect(m.contexts[0].route).toHaveBeenCalledWith('**/*',route);expect(m.contexts[0].routeWebSocket).toHaveBeenCalled();expect(m.contexts[0].addInitScript).toHaveBeenCalled();
 await expect(workspaceBrowser(project,{operation:'snapshot',pageId:first.pageId},{owner:'sam',route})).rejects.toThrow('no longer open');
});

it('keeps user browser capacity separate from the master browser allowance',async()=>{
 const route=vi.fn(async()=>{});
 for(let index=0;index<4;index++)await workspaceBrowser(project+index,{operation:'open',operationId:'user-'+index,url:'about:blank'},{owner:'alex',route});
 const master=await workspaceBrowser(project,{operation:'open',operationId:'master',url:'about:blank'});expect(master.pages).toHaveLength(1);
 await expect(workspaceBrowser(project+'extra',{operation:'open',operationId:'extra',url:'about:blank'},{owner:'alex',route})).rejects.toThrow('capacity');
});
