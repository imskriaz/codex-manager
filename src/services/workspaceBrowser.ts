import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Browser, BrowserContext, Page, Download, Route } from "playwright-core";
import {
  browserUrl,
  validateBrowserRequest,
  type BrowserFeedback,
  type WorkspaceBrowserRequest,
  type WorkspaceBrowserState
} from "../domain/workspaceBrowser";
import { getSqliteStateStore } from "../storage/sqliteState";
import { projectTaskKey } from "./projectTasks";
import { waitWithin } from "../utils/concurrency";
import { browserDebugCommand, createBrowserDebugger, type BrowserDebugger } from './workspaceBrowserDebug';
import { publishDashboardRealtime } from './dashboardRealtime';
import { browserCredentials, fillBrowserCredential, redactBrowserCredentials } from './browserCredentials';

type ManagedPage = { mobile?: boolean; desktopUserAgent?: string; page: Page; revision: string; logs: string[]; openedBy?: 'ai' | 'user'; agentPointer?: WorkspaceBrowserState['agentPointer']; agentActivity?: WorkspaceBrowserState['agentActivity']; debug?: Promise<BrowserDebugger>; capture?: Promise<Buffer> };
type Session = { context: BrowserContext; pages: Map<string, ManagedPage>; projectPath: string; sessionId?: string; scope: string; owner?: string };
const sessions = new Map<string, Session>();
const busy = new Set<string>();
const attempts = new Map<string, { fingerprint: string; promise: Promise<string | undefined> }>();
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let generation = 0;

async function engine(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!launching)
    launching = (async () => {
      const started = generation;
      const { chromium } = await import("playwright-core");
      const channel = process.env["CODEX_MANAGER_BROWSER"] ?? (process.platform === "win32" ? "msedge" : "chromium");
      const instance = await chromium.launch({
        ...(channel === "chromium" ? {} : { channel }),
        headless: true,
        ignoreDefaultArgs: ['--hide-scrollbars'],
        timeout: 15_000
      });
      if (started !== generation) {
        await instance.close();
        throw new Error("Browser startup was cancelled by host shutdown.");
      }
      instance.on("disconnected", () => {
        if (browser === instance) {
          browser = undefined;
          sessions.clear();
        }
      });
      browser = instance;
      return instance;
    })().finally(() => {
      launching = undefined;
    });
  return launching;
}

function feedbackFor(project: string): BrowserFeedback[] {
  const store = getSqliteStateStore();
  if (!store) throw new Error("Browser feedback storage is unavailable. Reconnect the host; no feedback was changed.");
  const rows = store.get<BrowserFeedback[]>("browser-feedback", project) ?? [];
  if (!Array.isArray(rows) || rows.length > 100)
    throw new Error("Saved browser feedback cannot be read. Existing data was preserved.");
  try {
    for (const row of rows) {
      validateBrowserRequest({ operation: 'feedback', pageId: row?.pageId, revision: row?.revision, feedback: row });
      browserUrl(row.url);
      if (!Number.isFinite(row.createdAt) || (row.image !== undefined && (typeof row.image !== 'string' || row.image.length > 700_000 || !row.image.startsWith('data:image/jpeg;base64,')))) throw new Error('Invalid saved feedback.');
    }
  } catch { throw new Error('Saved browser feedback cannot be read. Existing data was preserved.'); }
  return rows;
}
function saveFeedback(project: string, rows: BrowserFeedback[]): void {
  if (Buffer.byteLength(JSON.stringify(rows)) > 16 * 1024 * 1024)
    throw new Error("Browser feedback storage is full (16 MiB per project). Delete old feedback first.");
  getSqliteStateStore()!.set("browser-feedback", project, rows);
}

async function state(project: string, pageId?: string, image = false): Promise<WorkspaceBrowserState> {
  const session = sessions.get(project);
  const pages = await Promise.all(
    [...(session?.pages ?? [])].map(async ([id, item]) => ({
      id,
      url: item.page.url(),
      title: await waitWithin(item.page.title(), 3000, "Page title is unavailable.").catch(() => "Unavailable"),
      revision: item.revision,
      ...(item.openedBy ? { openedBy: item.openedBy } : {})
    }))
  );
  const item = pageId ? session?.pages.get(pageId) : undefined;
  const revision = item?.revision;
  // Concurrent mirrors share the same in-flight capture; no old frame is cached.
  const screenshot = image && item ? await (item.capture ??= item.page.screenshot({ type: "jpeg", quality: 65, caret: 'initial', timeout: 5000 }).finally(() => { item.capture = undefined; })) : undefined;
  if (screenshot && screenshot.length > 2 * 1024 * 1024)
    throw new Error("Browser image exceeded 2 MiB. Reduce the viewport.");
  if (item && item.revision !== revision)
    throw new Error("The page navigated during capture. Refresh the browser view.");
  return {
    pages,
    pageId,
    revision,
    image: screenshot ? `data:image/jpeg;base64,${screenshot.toString("base64")}` : undefined,
    feedback: feedbackFor(project).map(({ image: _image, ...feedback }) => feedback),
    logs: item?.logs,
    agentPointer: item?.agentPointer,
    agentActivity: item?.agentActivity
  };
}

async function actionState(project: string, pageId: string): Promise<WorkspaceBrowserState> {
  try { return await state(project, pageId, true); }
  catch (error) {
    // The action already ran; a preview failure must not hide its page or invite a replay.
    return { ...(await state(project, pageId)), warning: `Browser action completed, but the preview is unavailable: ${error instanceof Error ? error.message : String(error)} Read a fresh snapshot before interacting.` };
  }
}

export function workspaceBrowser(projectPath: string, raw: unknown, isolated?: {owner:string;route:(route:Route)=>Promise<void>}): Promise<WorkspaceBrowserState> {
  const request = validateBrowserRequest(raw),
    project = isolated ? JSON.stringify(['user',isolated.owner,projectTaskKey(projectPath),request.sessionId??'']) : request.sessionId ? JSON.stringify([projectTaskKey(projectPath), request.sessionId]) : projectTaskKey(projectPath);
  const read = ["list", "snapshot", "screenshot", "readFeedback", "html", "styles", "events", "cursor"].includes(request.operation) || request.operation === 'credentials' && (!request.params?.['action'] || request.params['action'] === 'list') || (request.operation === 'storage' && (!request.params?.['action'] || request.params['action'] === 'read'));
  if (!read && !request.operationId) return Promise.reject(new Error("A unique browser operationId is required."));
  const key = `${project}:${request.operationId ?? ""}`;
  const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const existing = !read ? attempts.get(key) : undefined;
  if (existing)
    return existing.fingerprint === fingerprint
      ? existing.promise.then((pageId) => state(project, pageId)).then(redactBrowserCredentials)
      : Promise.reject(new Error("This browser operationId was already used for a different operation."));
  if (busy.has(project) && request.operation !== 'list')
    return Promise.reject(
      new Error("A browser operation is running. Wait for its result, then refresh; nothing was queued.")
    );
  if (!read && attempts.size >= 1024)
    return Promise.reject(
      new Error("Browser operation history is full. Restart the host after checking pending work.")
    );
  if (!read) busy.add(project);
  const activity: WorkspaceBrowserState['agentActivity'] = request.operation !== 'list' && request.openedBy === 'ai' ? { operation: request.operation, status: 'running', updatedAt: Date.now() } : undefined;
  const promise = run(project, request, projectPath, activity, read, isolated).then(value => {
    if (activity) { activity.status = 'completed'; activity.updatedAt = Date.now(); }
    return redactBrowserCredentials(value);
  }, error => {
    if (activity) { activity.status = 'failed'; activity.updatedAt = Date.now(); }
    throw new Error(redactBrowserCredentials(error instanceof Error ? error.message : String(error)));
  }).finally(() => {
    if (!read) busy.delete(project);
    if (!read || activity) publishDashboardRealtime({ type: 'dashboard:browser-changed', projectPath, sessionId: request.sessionId });
  });
  if (!read) {
    const remembered = promise.then((value) => value.pageId);
    void remembered.catch(() => undefined);
    attempts.set(key, { fingerprint, promise: remembered });
  }
  return promise;
}

async function run(project: string, r: WorkspaceBrowserRequest, projectPath: string, activity?: WorkspaceBrowserState['agentActivity'], read = false, isolated?: {owner:string;route:(route:Route)=>Promise<void>}): Promise<WorkspaceBrowserState> {
  // Verify durable storage before launching or modifying a page.
  feedbackFor(project);
  let session = sessions.get(project);
  if (r.operation === 'credentials' && r.params?.['action'] !== 'fill') return { ...(await state(project)), value: await browserCredentials(isolated ? project : projectTaskKey(projectPath), r) };
  if (r.operation === "list") return state(project, r.pageId);
  const startActivity = (item: ManagedPage) => {
    item.agentActivity = activity;
    if (activity) publishDashboardRealtime({ type: 'dashboard:browser-changed', projectPath, sessionId: r.sessionId });
  };
  if (r.operation === "readFeedback") {
    const feedback = feedbackFor(project).find((row) => row.id === r.feedbackId);
    if (!feedback) throw new Error("This feedback was deleted. Refresh the feedback list.");
    return { ...(await state(project)), feedbackImage: feedback.image };
  }
  if (r.operation === "deleteFeedback") {
    if (!r.feedbackId) throw new Error("Choose feedback to delete.");
    saveFeedback(
      project,
      feedbackFor(project).filter((f) => f.id !== r.feedbackId)
    );
    return state(project);
  }
  if (r.operation === "open") {
    const url = r.url === undefined || r.url === "about:blank" ? "about:blank" : browserUrl(r.url);
    if (!session) {
      const full = () => [...sessions.values()].filter(value=>value.owner===isolated?.owner).length >= 4 || !!isolated && [...sessions.values()].filter(value=>value.owner).length >= 16;
      if (full()) throw new Error(isolated ? "Browser capacity reached. Close an unused browser session first." : "Four browser sessions are already open. Close their pages first.");
      const instance = await engine();
      // Recheck after launch because other projects can start concurrently.
      if (full()) throw new Error("Browser session capacity reached. Close another session.");
      const context = await instance.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, ...(isolated?{serviceWorkers:'block' as const}: {}) });
      if (isolated) {
        await context.route('**/*', isolated.route);
        await context.routeWebSocket('**/*', socket=>socket.close());
        await context.addInitScript(() => { Object.defineProperty(globalThis,'RTCPeerConnection',{value:undefined,configurable:false}); Object.defineProperty(globalThis,'webkitRTCPeerConnection',{value:undefined,configurable:false}); });
      }
      if (full() || browser !== instance) {
        await context.close();
        throw new Error("Browser capacity or host changed. Refresh before retrying.");
      }
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(15_000);
      session = { context, pages: new Map(), projectPath, sessionId: r.sessionId, scope: project, ...(isolated?{owner:isolated.owner}:{}) };
      sessions.set(project, session);
      context.on("page", (page) => {
        if (session!.pages.size >= 8) {
          void page.close().catch(() => undefined);
          return;
        }
        register(session!, page);
      });
    }
    if (session.pages.size >= 8) throw new Error("Eight pages are open. Close a page before opening another.");
    let page: Page;
    try { page = await session.context.newPage(); }
    catch (error) { if (!session.pages.size) { sessions.delete(project); await session.context.close().catch(() => undefined); } throw error; }
    const id = [...session.pages].find(([, item]) => item.page === page)?.[0] ?? register(session, page);
    session.pages.get(id)!.openedBy = r.openedBy;
    startActivity(session.pages.get(id)!);
    if (url !== "about:blank") {
      try {
        await debuggerFor(session.pages.get(id)!);
        await page.goto(url, { waitUntil: "domcontentloaded" });
      } catch (error) {
        throw new Error(
          `Page ${id} opened, but navigation was not confirmed: ${error instanceof Error ? error.message : String(error)}. Refresh its state before retrying.`
        );
      }
    }
    return url === 'about:blank' ? state(project, id) : actionState(project, id);
  }
  const item = r.pageId ? session?.pages.get(r.pageId) : undefined;
  if (!item || item.page.isClosed())
    throw new Error("This browser page is no longer open, or the host restarted. Refresh the page list.");
  const page = item.page;
  if (read && activity) startActivity(item);
  if (r.operation === 'events') {
    const debug = await debuggerFor(item);
    return { ...(await state(project, r.pageId)), events: debug.events.filter(event => event.sequence > (r.after ?? 0)), eventSequence: debug.sequence,
      ...((r.after ?? 0) < (debug.events[0]?.sequence ?? 1) - 1 ? { warning: 'Older browser events were evicted from the 100-event buffer. Capture events more frequently.' } : {}) };
  }
  if (['html', 'styles', 'cursor'].includes(r.operation) || (r.operation === 'storage' && (!r.params?.['action'] || r.params['action'] === 'read'))) {
    const inspectionRevision = item.revision;
    const value = await boundedDebug(page, await debuggerFor(item), r);
    const inspected = await state(project, r.pageId);
    if (inspected.revision !== inspectionRevision) throw new Error('This page changed during inspection. Read it again before interacting.');
    return { ...inspected, value };
  }
  if (["screenshot", "snapshot"].includes(r.operation)) {
    const response = await state(project, r.pageId, true);
    if (r.operation === "snapshot")
      response.text = (await page.locator("body").ariaSnapshot({ timeout: 5000 })).slice(0, 100_000);
    return response;
  }
  if (r.revision !== item.revision)
    throw new Error("This page changed. Refresh the preview before interacting; no action was started.");
  startActivity(item);
  if (r.operation === 'credentials') {
    const value = await fillBrowserCredential(isolated ? project : projectTaskKey(projectPath), page, r);
    item.revision = randomUUID();
    return { ...(await actionState(project, r.pageId!)), value };
  }
  if (['cdp', 'storage'].includes(r.operation)) {
    item.revision = randomUUID();
    const value = await boundedDebug(page, await debuggerFor(item), r);
    return { ...(await state(project, r.pageId)), value };
  }
  if (r.operation === "download") {
    const url = browserUrl(r.url);
    const download = await waitWithin(
      Promise.all([
        page.waitForEvent("download", { timeout: 15_000 }),
        page.evaluate((href) => {
          const link = document.createElement("a");
          link.href = href;
          link.download = "";
          link.hidden = true;
          document.body.append(link);
          link.click();
          link.remove();
        }, url)
      ]).then(([item]) => item),
      20_000,
      "The remote download did not start. Check the link and retry."
    );
    return {
      ...(await state(project, r.pageId)),
      fileDownload: await browserDownload(download)
    };
  }
  if (r.operation === "feedback" || r.operation === 'updateFeedback') {
    const rows = feedbackFor(project),
      f = r.feedback!;
    const previous = rows.find((row) => row.id === f.id);
    if (r.operation === 'updateFeedback') {
      if (!previous || previous.pageId !== r.pageId || previous.revision !== r.revision) throw new Error('This mark is no longer available on this page revision. Refresh before editing.');
      if (r.params?.['expected'] !== JSON.stringify([previous.id, previous.createdAt, previous.text, previous.points, previous.referenceUrl ?? ''])) throw new Error('This mark was edited elsewhere. Cancel your edit and review the current mark.');
      const image = await page.screenshot({ type: 'jpeg', quality: 45, timeout: 5000 });
      if (image.length > 512 * 1024 || r.revision !== item.revision) throw new Error('The edited mark could not be captured. Your saved mark was preserved.');
      saveFeedback(project, rows.map(row => row.id === f.id ? { ...row, kind: f.kind, text: f.text, points: f.points, referenceUrl: f.referenceUrl, image: `data:image/jpeg;base64,${image.toString('base64')}` } : row));
      return state(project, r.pageId);
    }
    if (
      previous &&
      (previous.text !== f.text ||
        previous.pageId !== f.pageId ||
        previous.revision !== f.revision ||
        previous.kind !== f.kind ||
        previous.referenceUrl !== f.referenceUrl ||
        JSON.stringify(previous.points) !== JSON.stringify(f.points))
    )
      throw new Error("This feedback ID already exists. Use a new ID for different feedback.");
    if (!rows.some((row) => row.id === f.id)) {
      if (rows.length >= 100)
        throw new Error("Browser feedback storage is full (100 items). Delete an old item before adding another.");
      const image = await page.screenshot({ type: "jpeg", quality: 45, timeout: 5000 });
      if (image.byteLength > 512 * 1024)
        throw new Error("Feedback screenshot exceeds 512 KiB. Reduce the viewport and save again.");
      if (r.revision !== item.revision)
        throw new Error("The page navigated while saving feedback. Your mark was not saved; refresh and review it.");
      saveFeedback(project, [
        ...rows,
        {
          id: f.id,
          pageId: f.pageId,
          revision: f.revision,
          kind: f.kind,
          points: f.points,
          text: f.text,
          referenceUrl: f.referenceUrl,
          url: page.url(),
          createdAt: Date.now(),
          image: `data:image/jpeg;base64,${image.toString("base64")}`
        }
      ]);
    }
    return state(project, r.pageId);
  }
  if (r.operation === "close") {
    await page.close();
    if (!session!.pages.size) {
      await session!.context.close();
      sessions.delete(project);
    }
    return state(project);
  }
  if (['navigate', 'reload', 'back', 'forward', 'resize', 'scroll'].includes(r.operation)) item.agentPointer = undefined;
  if (['click', 'hover', 'fill', 'select', 'press', 'type', 'drag'].includes(r.operation)) {
    item.agentPointer = undefined;
    if (r.openedBy === 'ai') {
      let point = r.x !== undefined && r.y !== undefined ? { x: r.x, y: r.y } : undefined;
      if (r.selector || ['press', 'type'].includes(r.operation)) {
        const locator = page.locator(r.selector ?? ':focus');
        if (r.selector) await locator.scrollIntoViewIfNeeded();
        const rect = r.selector || await locator.count() ? await locator.boundingBox() : null;
        if (rect) point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
      if (point) {
        item.agentPointer = { ...point, action: r.operation, updatedAt: Date.now() };
        publishDashboardRealtime({ type: 'dashboard:browser-changed', projectPath, sessionId: r.sessionId });
      }
    }
  }
  let fileDownload: WorkspaceBrowserState['fileDownload'];
  const interact = async (action: () => Promise<unknown>) => {
    let download: Download | undefined;
    let announce!: () => void;
    const started = new Promise<void>(resolve => { announce = resolve; });
    const capture = (value: Download) => { download = value; announce(); };
    page.on('download', capture);
    try {
      await action();
      // Native download events can arrive after the input acknowledgement.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([started, new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]);
      clearTimeout(timer);
      if (download) fileDownload = await browserDownload(download);
    }
    finally { page.off('download', capture); }
  };
  if (r.operation === "navigate") await page.goto(browserUrl(r.url), { waitUntil: "domcontentloaded" });
  else if (r.operation === "reload") await page.reload({ waitUntil: "domcontentloaded" });
  else if (r.operation === "back") await page.goBack({ waitUntil: "domcontentloaded" });
  else if (r.operation === "forward") await page.goForward({ waitUntil: "domcontentloaded" });
  else if (r.operation === "resize") {
    if (
      !Number.isInteger(r.width) ||
      !Number.isInteger(r.height) ||
      r.width! < 320 ||
      r.width! > 3840 ||
      r.height! < 240 ||
      r.height! > 2160
    )
      throw new Error("Use a viewport of 320–3840 × 240–2160 pixels.");
    await page.setViewportSize({ width: r.width!, height: r.height! });
    const debug = await debuggerFor(item);
    const mobile = r.width! < 768;
    item.desktopUserAgent ??= await page.evaluate(() => navigator.userAgent);
    const chromeVersion = item.desktopUserAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '130.0.0.0';
    await debug.client.send('Emulation.setUserAgentOverride', {
      userAgent: mobile ? `Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36` : item.desktopUserAgent,
      platform: mobile ? 'Linux armv8l' : process.platform === 'win32' ? 'Win32' : process.platform
    });
    await debug.client.send('Emulation.setDeviceMetricsOverride', { width: r.width!, height: r.height!, deviceScaleFactor: 1, mobile: r.width! < 768 });
    await debug.client.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 1 });
    if (mobile !== (item.mobile ?? false)) {
      item.mobile = mobile;
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
  } else if (r.operation === "evaluate") {
    if (r.confirmed !== true || !r.text)
      throw new Error(
        "JavaScript execution needs confirmed=true and text. It has access to the page and its logged-in session."
      );
    item.revision = randomUUID();
    const value: unknown = await waitWithin(
      page.evaluate(r.text),
      5000,
      "Evaluation outcome is unknown. Close the page to stop pending JavaScript before retrying."
    );
    if (Buffer.byteLength(JSON.stringify(value) ?? "") > 100_000)
      throw new Error("Evaluation completed, but its result exceeded 100 KB.");
    return { ...(await state(project, r.pageId)), value };
  } else if (r.operation === "scroll") await page.mouse.wheel(r.x ?? 0, r.y ?? 500);
  else if (r.operation === "type") await page.keyboard.insertText(r.text ?? "");
  else if (r.operation === "press" && !r.selector) await interact(() => page.keyboard.press(r.key ?? "Enter"));
  else if (r.operation === 'drag') {
    const toX = r.params?.['toX'], toY = r.params?.['toY'];
    if (r.x === undefined || r.y === undefined || typeof toX !== 'number' || typeof toY !== 'number' || !Number.isFinite(toX) || !Number.isFinite(toY) || toX < 0 || toY < 0 || toX > 3840 || toY > 2160) throw new Error('Choose drag start coordinates and params.toX/toY in viewport pixels.');
    await page.mouse.move(r.x, r.y);
    await page.mouse.down();
    try { await page.mouse.move(toX, toY, { steps: 8 }); }
    finally { await page.mouse.up(); }
    if (r.openedBy === 'ai') item.agentPointer = { x: toX, y: toY, action: 'drag', updatedAt: Date.now() };
  }
  else if ((r.operation === "click" || r.operation === 'hover') && !r.selector) {
    if (r.x === undefined || r.y === undefined) throw new Error("Choose a selector or click coordinates.");
    if (r.operation === 'hover') await page.mouse.move(r.x, r.y);
    else await interact(() => page.mouse.click(r.x!, r.y!));
  } else {
    if (!r.selector) throw new Error("Choose a browser selector.");
    const locator = page.locator(r.selector);
    if (r.operation === "click") await interact(() => locator.click());
    else if (r.operation === "fill") await locator.fill(r.text ?? "");
    else if (r.operation === "press") await interact(() => locator.press(r.key ?? "Enter"));
    else if (r.operation === "hover") await locator.hover();
    else if (r.operation === "select") await locator.selectOption(r.text ?? "");
    else if (r.operation === "wait") await locator.waitFor({ state: "visible" });
  }
  item.revision = randomUUID();
  return { ...(await actionState(project, r.pageId!)), ...(fileDownload ? { fileDownload } : {}) };
}

async function browserDownload(download: Download): Promise<NonNullable<WorkspaceBrowserState['fileDownload']>> {
  const path = await waitWithin(download.path(), 5000, 'The remote download path was unavailable. Check the browser before retrying.');
  if (!path) throw new Error('The remote download was not saved.');
  const file = await readFile(path);
  if (file.byteLength > 16 * 1024 * 1024) throw new Error('The remote download is larger than 16 MiB.');
  return { filename: download.suggestedFilename().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || 'download', mimeType: 'application/octet-stream', data: file.toString('base64') };
}

async function debuggerFor(item: ManagedPage): Promise<BrowserDebugger> {
  if (!item.debug) item.debug = createBrowserDebugger(item.page).catch(error => { item.debug = undefined; throw error; });
  return item.debug;
}
async function boundedDebug(page: Page, debug: BrowserDebugger, request: WorkspaceBrowserRequest): Promise<unknown> {
  const value = await waitWithin(browserDebugCommand(page, debug, request), 5000, 'Browser inspection timed out. Inspect state before retrying.');
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 1024 * 1024) throw new Error('Browser inspection result exceeds 1 MiB. Select a smaller element or resource.');
  return value;
}

function register(session: Session, page: Page): string {
  const id = randomUUID(),
    item: ManagedPage = { page, revision: randomUUID(), logs: [] };
  session.pages.set(id, item);
  const changed = () => {
    if (!busy.has(session.scope)) publishDashboardRealtime({ type: 'dashboard:browser-changed', projectPath: session.projectPath, sessionId: session.sessionId });
  };
  if (typeof page.opener === 'function') void page.opener().then(opener => {
    if (opener && !item.openedBy) item.openedBy = [...session.pages.values()].find(parent => parent.page === opener)?.openedBy;
  }).catch(() => undefined);
  page.on("close", () => {
    session.pages.delete(id);
    if (!session.pages.size) {
      for (const [project, current] of sessions) if (current === session) sessions.delete(project);
      void session.context.close().catch(() => undefined);
    }
    changed();
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) { item.revision = randomUUID(); item.agentPointer = undefined; changed(); }
  });
  changed();
  const log = (message: string): void => {
    item.logs.push(redactBrowserCredentials(message).slice(0, 2000));
    if (item.logs.length > 100) item.logs.shift();
  };
  page.on("console", (message) => log(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => log(`error: ${error.message}`));
  page.on("requestfailed", (request) =>
    log(`network: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`)
  );
  page.on("dialog", (dialog) => {
    log(`dialog dismissed: ${dialog.message()}`);
    void dialog.dismiss().catch(() => undefined);
  });
  return id;
}

export async function disposeWorkspaceBrowsers(): Promise<void> {
  generation++;
  const current = browser;
  browser = undefined;
  sessions.clear();
  attempts.clear();
  if (current) await current.close();
}
