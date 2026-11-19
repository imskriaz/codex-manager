import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, cleanups: [] as Array<() => void>,
  request: vi.fn(), click: vi.fn(), link: {} as any
}));
vi.mock("preact/hooks", () => ({
  useState(initial: unknown) {
    const index = fixture.cursor++;
    fixture.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
    return [fixture.slots[index].value, (next: any) => { fixture.slots[index].value = typeof next === "function" ? next(fixture.slots[index].value) : next; }];
  },
  useRef(initial: unknown) { return fixture.slots[fixture.cursor++] ??= { current: initial }; },
  useEffect(setup: () => void | (() => void), deps: unknown[]) {
    const index = fixture.cursor++, previous = fixture.slots[index];
    if (!previous || deps.some((value, i) => value !== previous[i])) {
      fixture.slots[index] = deps;
      fixture.effects.push(() => { const cleanup = setup(); if (cleanup) fixture.cleanups.push(cleanup); });
    }
  }
}));
vi.mock("../webview-src/dashboard/workspaceRequest", () => ({ useWorkspaceRequest: () => fixture.request }));
import WorkspaceBrowser, { normalizeBrowserInput } from "../webview-src/dashboard/workspaceBrowser";

const page = { id: "download-page", url: "about:blank", title: "", revision: "download-revision" };
const browserState = { pages: [page], pageId: page.id, revision: page.revision, feedback: [] };
const target = "https://example.test/release/theme.zip";
const onFeedback = vi.fn();
function render(overrides: Partial<Parameters<typeof WorkspaceBrowser>[0]> = {}) {
  fixture.cursor = 0;
  const tree = WorkspaceBrowser({ projectPath: "D:/download", connected: true, downloadUrl: target, actionNonce: 1, onFeedback, ...overrides });
  fixture.effects.splice(0).forEach(effect => effect());
  return tree;
}
beforeEach(() => {
  fixture.slots = []; fixture.effects = []; fixture.cleanups = []; fixture.request.mockReset(); fixture.click.mockReset(); onFeedback.mockReset();
  fixture.link = { click: fixture.click, remove: vi.fn() };
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-download');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal("document", { visibilityState: "visible", body: { append: vi.fn() }, createElement: () => fixture.link });
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { fixture.cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

it("downloads a link through a blank page once, then reports the saved filename", async () => {
  fixture.request.mockImplementation(async (_action, { browserRequest: request }) => ({ workspaceBrowser: {
    ...browserState, ...(request.operation === "download" ? { fileDownload: { filename: "theme.zip", mimeType: "application/zip", data: "emlw" } } : {})
  } }));
  render();
  await vi.waitFor(() => { render(); expect(fixture.click).toHaveBeenCalledOnce(); });
  const requests = fixture.request.mock.calls.map(([, payload]) => payload.browserRequest);
  expect(requests.map(request => request.operation)).toEqual(["open", "download"]);
  expect(requests[0].url).toBeUndefined();
  expect(requests[1]).toMatchObject({ pageId: page.id, revision: page.revision, url: target });
  expect(fixture.link).toMatchObject({ download: "theme.zip", href: "blob:test-download" });
  expect(JSON.stringify(render())).toContain("theme.zip: download started in this viewer.");
  expect(onFeedback).not.toHaveBeenCalled();
  expect(fixture.request).toHaveBeenCalledTimes(2);
});

it("preserves download failures in the panel and dashboard feedback without replaying the link", async () => {
  fixture.request.mockImplementation(async (_action, { browserRequest: request }) => {
    if (request.operation === "download") throw new Error("The remote download was not saved. Retry the link.");
    return { workspaceBrowser: browserState };
  });
  render();
  await vi.waitFor(() => expect(JSON.stringify(render())).toContain("The remote download was not saved. Retry the link."));
  expect(JSON.stringify(render())).toContain("The remote download was not saved. Retry the link.");
  expect(fixture.click).not.toHaveBeenCalled();
  expect(fixture.request.mock.calls.filter(([, payload]) => payload.browserRequest.operation === 'download')).toHaveLength(1);
  expect(fixture.request.mock.calls.map(([, payload]) => payload.browserRequest.operation)).toEqual(['open', 'download', 'screenshot']);
});

it('opens a separate blank page per add request and preserves the blank URL on submission', async () => {
  fixture.request.mockResolvedValue({ workspaceBrowser: browserState });
  const props = { downloadUrl: undefined, openPageNonce: 1 };
  render(props);
  await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
  render(props);
  expect(fixture.request.mock.calls[0][1].browserRequest).toMatchObject({ operation: 'open', url: 'about:blank' });
  props.openPageNonce = 2;
  render(props);
  await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2));
  const first = fixture.request.mock.calls[0][1].browserRequest;
  const second = fixture.request.mock.calls[1][1].browserRequest;
  expect(second.pageId).toBeUndefined();
  expect(second.operationId).not.toBe(first.operationId);
  expect(normalizeBrowserInput('about:blank')).toBe('about:blank');
});

it('keeps an undispatched page intent until the host reconnects', async () => {
  fixture.request.mockResolvedValue({ workspaceBrowser: browserState });
  render({ downloadUrl: undefined, openPageNonce: 1, connected: false });
  expect(fixture.request).not.toHaveBeenCalled();
  render({ downloadUrl: undefined, openPageNonce: 1, connected: true });
  await vi.waitFor(() => expect(fixture.request.mock.calls.some(([, payload]) => payload.browserRequest.operation === 'open')).toBe(true));
  render({ downloadUrl: undefined, openPageNonce: 1, connected: true });
  expect(fixture.request.mock.calls.filter(([, payload]) => payload.browserRequest.operation === 'open')).toHaveLength(1);
});

it('consumes a page-open intent before dispatch so a remount cannot replay it', async () => {
  fixture.request.mockResolvedValue({ workspaceBrowser: browserState });
  let pending = 1;
  const onOpenPageHandled = vi.fn(() => { pending = 0; });
  render({downloadUrl:undefined,openPageNonce:pending,onOpenPageHandled});
  expect(onOpenPageHandled).toHaveBeenCalledWith(1);
  await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
  fixture.cleanups.splice(0).forEach(cleanup => cleanup()); fixture.slots=[];
  render({downloadUrl:undefined,openPageNonce:pending,onOpenPageHandled});
  expect(fixture.request.mock.calls.filter(([,payload])=>payload.browserRequest.operation === 'open')).toHaveLength(1);
});
