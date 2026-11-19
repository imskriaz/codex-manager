import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Browser, BrowserContext, Page } from "playwright-core";
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

type ManagedPage = { page: Page; revision: string; logs: string[]; openedBy?: 'ai' | 'user'; debug?: Promise<BrowserDebugger>; capture?: Promise<Buffer> };
type Session = { context: BrowserContext; pages: Map<string, ManagedPage>; projectPath: string; sessionId?: string; scope: string };
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
  const screenshot = image && item ? await (item.capture ??= item.page.screenshot({ type: "jpeg", quality: 65, timeout: 5000 }).finally(() => { item.capture = undefined; })) : undefined;
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
    logs: item?.logs
  };
}

export function workspaceBrowser(projectPath: string, raw: unknown): Promise<WorkspaceBrowserState> {
  const request = validateBrowserRequest(raw),
    project = request.sessionId ? JSON.stringify([projectTaskKey(projectPath), request.sessionId]) : projectTaskKey(projectPath);
  const read = ["list", "snapshot", "screenshot", "readFeedback", "html", "styles", "events"].includes(request.operation) || (request.operation === 'storage' && (!request.params?.['action'] || request.params['action'] === 'read'));
  if (!read && !request.operationId) return Promise.reject(new Error("A unique browser operationId is required."));
  const key = `${project}:${request.operationId ?? ""}`;
  const fingerprint = JSON.stringify(request);
  const existing = !read ? attempts.get(key) : undefined;
  if (existing)
    return existing.fingerprint === fingerprint
      ? existing.promise.then((pageId) => state(project, pageId))
      : Promise.reject(new Error("This browser operationId was already used for a different operation."));
  if (busy.has(project))
    return Promise.reject(
      new Error("A browser operation is running. Wait for its result, then refresh; nothing was queued.")
    );
  if (!read && attempts.size >= 1024)
    return Promise.reject(
      new Error("Browser operation history is full. Restart the host after checking pending work.")
    );
  if (!read) busy.add(project);
  const promise = run(project, request, projectPath).finally(() => {
    if (!read) {
      busy.delete(project);
      publishDashboardRealtime({ type: 'dashboard:browser-changed', projectPath, sessionId: request.sessionId });
    }
  });
  if (!read) {
    const remembered = promise.then((value) => value.pageId);
    void remembered.catch(() => undefined);
    attempts.set(key, { fingerprint, promise: remembered });
  }
  return promise;
}

async function run(project: string, r: WorkspaceBrowserRequest, projectPath: string): Promise<WorkspaceBrowserState> {
  // Verify durable storage before launching or modifying a page.
  feedbackFor(project);
  let session = sessions.get(project);
  if (r.operation === "list") return state(project);
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
      if (sessions.size >= 4) throw new Error("Four browser sessions are already open. Close their pages first.");
      const instance = await engine();
      // Recheck after launch because other projects can start concurrently.
      if (sessions.size >= 4) throw new Error("Browser session capacity reached. Close another session.");
      const context = await instance.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
      if (sessions.size >= 4 || browser !== instance) {
        await context.close();
        throw new Error("Browser capacity or host changed. Refresh before retrying.");
      }
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(15_000);
      session = { context, pages: new Map(), projectPath, sessionId: r.sessionId, scope: project };
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
    return state(project, id, url !== "about:blank");
  }
  const item = r.pageId ? session?.pages.get(r.pageId) : undefined;
  if (!item || item.page.isClosed())
    throw new Error("This browser page is no longer open, or the host restarted. Refresh the page list.");
  const page = item.page;
  if (r.operation === 'events') {
    const debug = await debuggerFor(item);
    return { ...(await state(project, r.pageId)), events: debug.events.filter(event => event.sequence > (r.after ?? 0)), eventSequence: debug.sequence,
      ...((r.after ?? 0) < (debug.events[0]?.sequence ?? 1) - 1 ? { warning: 'Older browser events were evicted from the 100-event buffer. Capture events more frequently.' } : {}) };
  }
  if (['html', 'styles'].includes(r.operation) || (r.operation === 'storage' && (!r.params?.['action'] || r.params['action'] === 'read'))) {
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
    const path = await waitWithin(download.path(), 5_000, "The remote download path was unavailable.");
    if (!path) throw new Error("The remote download was not saved. Retry the link.");
    const file = await readFile(path);
    if (file.byteLength > 16 * 1024 * 1024) throw new Error("The remote download is larger than 16 MiB.");
    return {
      ...(await state(project, r.pageId)),
      fileDownload: {
        filename: download.suggestedFilename().replace(/[\\/:*?\"<>|\u0000-\u001f]/g, "_").slice(0, 180) || "download",
        mimeType: "application/octet-stream",
        data: file.toString("base64")
      }
    };
  }
  if (r.operation === "feedback") {
    const rows = feedbackFor(project),
      f = r.feedback!;
    const previous = rows.find((row) => row.id === f.id);
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
  else if (r.operation === "press" && !r.selector) await page.keyboard.press(r.key ?? "Enter");
  else if (r.operation === "click" && !r.selector) {
    if (r.x === undefined || r.y === undefined) throw new Error("Choose a selector or click coordinates.");
    await page.mouse.click(r.x, r.y);
  } else {
    if (!r.selector) throw new Error("Choose a browser selector.");
    const locator = page.locator(r.selector);
    if (r.operation === "click") await locator.click();
    else if (r.operation === "fill") await locator.fill(r.text ?? "");
    else if (r.operation === "press") await locator.press(r.key ?? "Enter");
    else if (r.operation === "hover") await locator.hover();
    else if (r.operation === "select") await locator.selectOption(r.text ?? "");
    else if (r.operation === "wait") await locator.waitFor({ state: "visible" });
  }
  item.revision = randomUUID();
  return state(project, r.pageId, true);
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
    if (frame === page.mainFrame()) { item.revision = randomUUID(); changed(); }
  });
  changed();
  const log = (message: string): void => {
    item.logs.push(message.slice(0, 2000));
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
