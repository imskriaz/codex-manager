import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserUrl, validateBrowserRequest } from "../src/domain/workspaceBrowser";
vi.mock('../src/services/workspaceBrowserDebug', () => ({ createBrowserDebugger: async () => ({ events: [], sequence: 0 }), browserDebugCommand: vi.fn(async () => 'document') }));
import { browserDebugCommand } from '../src/services/workspaceBrowserDebug';
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
                mainFrame: () => page,
                url: () => url,
                title: async () => "Development",
                goto: vi.fn(async (value: string) => {
                  url = value;
                  events.get("framenavigated")?.(page);
                }),
                screenshot: async () => Buffer.from("image"),
                isClosed: () => closed,
                close: vi.fn(async () => {
                  closed = true;
                  events.get("close")?.();
                }),
                locator: () => ({ ariaSnapshot: async () => '- button "Save"', click: vi.fn(async () => undefined) }),
                mouse: { click: vi.fn(async () => undefined) },
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
  await expect(workspaceBrowser('C:/browser-five', { operation: 'open', operationId: 'too-many', url: 'http://localhost:3000' })).rejects.toThrow('Four projects');
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
