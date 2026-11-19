import { useEffect, useRef, useState } from "preact/hooks";
import { BrowserInspectorContent, BrowserResizeHandle } from './workspaceBrowserInspector';
import type { JSX } from "preact";
import { useWorkspaceRequest } from "./workspaceRequest";
import { ToolIcon } from "./icons";
import type { DashboardHostMessage, DashboardNotice } from "../../src/domain/dashboard/types";
import { canonicalWebPath } from './helpers';
import type {
  BrowserFeedback,
  BrowserPoint,
  WorkspaceBrowserRequest,
  WorkspaceBrowserState
} from "../../src/domain/workspaceBrowser";

export default function WorkspaceBrowser(props: {
  projectPath?: string;
  sessionId?: string;
  targetDeviceId?: string;
  initialUrl?: string;
  downloadUrl?: string;
  actionNonce?: number;
  openPageNonce?: number;
  initialPageId?: string;
  closePageId?: string;
  onClosePageHandled?: (pageId: string) => void;
  onPagesChange?: (pages: WorkspaceBrowserState["pages"]) => void;
  onPageSelected?: (pageId: string) => void;
  connected: boolean;
  active?: boolean;
  onFeedback: (notice: DashboardNotice) => void;
  onInstruction?: (text: string, image?: string, images?: string[]) => void;
}) {
  const request = useWorkspaceRequest(props.projectPath, props.targetDeviceId, props.connected, props.sessionId);
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshedTick = useRef(0);
  const [state, setState] = useState<WorkspaceBrowserState>({ pages: [], feedback: [] });
  const [selected, setSelected] = useState(props.initialPageId ?? ""),
    [url, setUrl] = useState(props.initialUrl ?? "");
  const [busy, setBusy] = useState(false),
    [, setNotice] = useState(""),
    [, setFailed] = useState(false);
  const [mode, setMode] = useState<"interact" | BrowserFeedback["kind"]>("interact");
  const [points, setPoints] = useState<BrowserPoint[]>([]),
    [text, setText] = useState(""),
    [reference, setReference] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [dock] = useState<'left' | 'right' | 'bottom'>('right');
  const [responsive, setResponsive] = useState(false);
  const [viewport, setViewport] = useState({ width: 390, height: 844 });
  const [viewportPreset, setViewportPreset] = useState('responsive');
  const [consoleOutcome, setConsoleOutcome] = useState<{ pageId: string; value?: unknown; message: string; failed: boolean }>();
  const [inspectorTab, setInspectorTab] = useState<"elements" | "console" | "sources" | "network" | "application" | "performance" | "memory" | "feedback">("elements");
  const [inspectorSize, setInspectorSize] = useState(45);
  const [inspect, setInspect] = useState(false), [elementSelector, setElementSelector] = useState('body');
  const [activeFeedback, setActiveFeedback] = useState(''), [showMarks, setShowMarks] = useState(true);
  const [feedbackFilter, setFeedbackFilter] = useState('');
  const [consoleDrawer, setConsoleDrawer] = useState(false);
  const [drawerSide, setDrawerSide] = useState<'bottom' | 'right'>('bottom');
  const [drawerSize, setDrawerSize] = useState(35);
  const [settings, setSettings] = useState(false);
  const [theme, setTheme] = useState('auto'), [wrap, setWrap] = useState(false);
  const [size, setSize] = useState({ width: 1280, height: 800 });
  const [cursor, setCursor] = useState<BrowserPoint>({ x: 20, y: 20 });
  const [agentVisible, setAgentVisible] = useState(false);
  const pageInput = useRef<Array<{ pageId: string; operation: 'type' | 'press'; text?: string; key?: string }>>([]);
  const [inputTick, setInputTick] = useState(0);
  const queuePageInput = (value: typeof pageInput.current[number]) => {
    const previous = pageInput.current.at(-1);
    if (value.operation === 'type' && previous?.operation === 'type' && previous.pageId === value.pageId && (previous.text?.length ?? 0) + (value.text?.length ?? 0) <= 16000) previous.text = (previous.text ?? '') + (value.text ?? '');
    else pageInput.current.push(value);
    setInputTick(tick => tick + 1);
  };
  const [hoverRect, setHoverRect] = useState<{ x: number; y: number; width: number; height: number }>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const locked = useRef(false),
    generation = useRef(0),
    drawing = useRef(false);
  const savedId = useRef<string>();
  const openedRequest = useRef<number>();
  const downloadedRequest = useRef<number>();
  const openedPageRequest = useRef<number>();
  const openingForDownload = useRef(false);
  const reading = useRef(false), operationGeneration = useRef(0), draftPoints = useRef(points);
  draftPoints.current = points;
  const latest = useRef(props); latest.current = props;
  const pageDrafts = useRef(new Map<string, { points: BrowserPoint[]; text: string; reference: string; mode: typeof mode }>());
  const draftPage = useRef(selected);
  pageDrafts.current.set(draftPage.current, { points, text, reference, mode });
  const revision = state.pageId === selected ? state.revision : undefined;
  const current = state.pages.find((page) => page.id === selected);
  const noticeAction = (message: string): void => { setNotice(message); setFailed(false); };
  useEffect(() => {
    const activity = state.agentActivity;
    const remaining = activity ? Math.max(0, activity.updatedAt + 1800 - Date.now()) : 0;
    setAgentVisible(activity?.status === 'running' || remaining > 0);
    if (activity?.status !== 'running' && remaining) {
      const timer = setTimeout(() => setAgentVisible(false), remaining);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state.agentActivity?.updatedAt, state.agentActivity?.status]);
  useEffect(() => {
    if (draftPage.current !== selected) {
      setActiveFeedback(''); setInspect(false);
      const draft = pageDrafts.current.get(selected);
      draftPage.current = selected;
      setPoints(draft?.points ?? []); setText(draft?.text ?? ''); setReference(draft?.reference ?? ''); setMode(draft?.mode ?? 'interact');
    }
    if (current?.url) setUrl(current.url);
    else if (!selected) setUrl('');
  }, [selected, current?.url]);
  const run = async (value: WorkspaceBrowserRequest, quiet = false): Promise<void> => {
    if (quiet && (reading.current || locked.current)) return;
    if (!quiet && locked.current) {
      if (!quiet) {
        setFailed(true);
        setNotice("A browser operation is pending. Check its result before retrying.");
      }
      return;
    }
    if (quiet) reading.current = true;
    else { locked.current = true; setBusy(true); setNotice(''); operationGeneration.current++; }
    const version = generation.current;
    const operationVersion = operationGeneration.current;
    let recoverPreview = false;
    try {
      const response = await request("workspaceBrowser", {
        browserRequest: { operationId: crypto.randomUUID(), ...value, pageId: value.pageId || undefined }
      });
      if (version !== generation.current) return;
      if (quiet && (operationVersion !== operationGeneration.current || drawing.current || draftPoints.current.length)) return;
      if (!response.workspaceBrowser) throw new Error("Browser outcome was not returned. Refresh before retrying.");
      setState((previous) => ({
        ...response.workspaceBrowser!,
        ...(['list', 'deleteFeedback'].includes(value.operation) && response.workspaceBrowser!.pages.some(page => page.id === previous.pageId) ? { pageId: previous.pageId, revision: previous.revision, image: previous.image } : {}),
        image:
          response.workspaceBrowser!.warning ? undefined :
          response.workspaceBrowser!.image ??
          (response.workspaceBrowser!.pageId === previous.pageId || ['list', 'deleteFeedback'].includes(value.operation) && response.workspaceBrowser!.pages.some(page => page.id === previous.pageId) ? previous.image : undefined)
      }));
      const next = response.workspaceBrowser;
      if (value.operation === 'evaluate') setConsoleOutcome({ pageId: value.pageId ?? '', value: next.value, message: next.warning ?? 'Script completed.', failed: false });
      latest.current.onPagesChange?.(next.pages);
      if (next.fileDownload) {
        const link = document.createElement("a");
        link.href = `data:${next.fileDownload.mimeType};base64,${next.fileDownload.data}`;
        link.download = next.fileDownload.filename;
        link.click();
        noticeAction(`${next.fileDownload.filename} downloaded.`);
      }
      const requested = latest.current.initialPageId;
      if (next.pageId && (!quiet || requested === undefined || requested === next.pageId)) {
        setSelected(next.pageId);
        if (!quiet && latest.current.active !== false && !['screenshot', 'snapshot', 'list', 'close'].includes(value.operation)) latest.current.onPageSelected?.(next.pageId);
      } else if (!next.pageId) {
        setSelected(previous => next.pages.some(page => page.id === previous) ? previous : requested === undefined ? next.pages[0]?.id ?? '' : '');
      }
      if (!quiet) {
        setFailed(false);
        setNotice(next.warning ?? (next.fileDownload ? `${next.fileDownload.filename} downloaded.` : 'Done.'));
        if (next.warning || !['list', 'snapshot', 'screenshot', 'type', 'press'].includes(value.operation)) props.onFeedback({ level: next.warning ? 'warning' : 'info', message: next.warning ?? (value.operation === 'close' ? 'Browser tab closed.' : 'Browser action completed.') });
      }
    } catch (error) {
      if (version !== generation.current) return;
      const detail = error instanceof Error ? error.message : String(error);
      const message = detail.includes('Unsupported dashboard action: workspaceBrowser') ? 'This host is running an older Manager. Restart that host with the installed version, then reconnect.' : detail;
      if (!quiet) { setNotice(message); setFailed(true); pageInput.current = []; props.onFeedback({ level: "error", message }); }
      recoverPreview = !quiet && !!value.pageId && !draftPoints.current.length && !['list', 'snapshot', 'screenshot', 'close'].includes(value.operation);
      if (quiet && value.pageId && message.includes('no longer open')) {
        // A closed selection cannot refresh itself. Reconcile tabs without replaying any action.
        reading.current = false;
        void run({ operation: 'list' }, true);
      }
      if (value.operation === 'evaluate') setConsoleOutcome({ pageId: value.pageId ?? '', message, failed: true });
    } finally {
      if (quiet) reading.current = false;
      else if (version === generation.current) {
        locked.current = false;
        setBusy(false);
        if (recoverPreview) void run({ operation: 'screenshot', pageId: value.pageId }, true);
      }
    }
  };
  useEffect(() => {
    if (busy || locked.current || !pageInput.current.length || !props.connected || !revision) return;
    pageInput.current = pageInput.current.filter(value => value.pageId === selected);
    const next = pageInput.current.shift();
    if (next) void run({ ...next, revision });
  }, [inputTick, busy, props.connected, selected, revision]);
  useEffect(() => {
    if (props.initialPageId === undefined || props.initialPageId === selected || busy) return;
    setSelected(props.initialPageId);
    operationGeneration.current++;
    const openingPage = props.openPageNonce && props.openPageNonce !== openedPageRequest.current;
    if (props.initialPageId && props.connected && !openingPage) void run({ operation: 'screenshot', pageId: props.initialPageId });
  }, [props.initialPageId, props.connected, busy]);
  useEffect(() => {
    if (!props.closePageId || busy || !props.connected) return;
    const id = props.closePageId;
    const page = state.pages.find(page => page.id === id);
    if (!page) { latest.current.onClosePageHandled?.(id); return; }
    if (pageDrafts.current.get(id)?.points.length) { setFailed(true); setNotice('Save or cancel the mark on this page before closing it.'); latest.current.onClosePageHandled?.(id); return; }
    void run({ operation: 'close', pageId: id, revision: page.revision }).finally(() => latest.current.onClosePageHandled?.(id));
  }, [props.closePageId, props.connected, busy]);
  useEffect(() => {
    const target = props.initialUrl?.trim();
    const nonce = props.actionNonce ?? 0;
    if (!target || nonce === openedRequest.current || !props.connected) return;
    openedRequest.current = nonce;
    setUrl(target);
    void run({ operation: selected ? "navigate" : "open", pageId: selected || undefined, revision: selected ? revision : undefined, url: target });
  }, [props.initialUrl, props.actionNonce, props.connected, selected, revision]);
  useEffect(() => {
    const nonce = props.openPageNonce ?? 0;
    if (!nonce || nonce === openedPageRequest.current) return;
    openedPageRequest.current = nonce;
    if (!props.connected) { setFailed(true); setNotice('Offline. The new browser page was not opened. Reconnect and choose Browser again.'); return; }
    setUrl("about:blank");
    void run({ operation: "open", url: "about:blank" });
  }, [props.openPageNonce]);
  useEffect(() => {
    const target = props.downloadUrl?.trim();
    const nonce = props.actionNonce ?? 0;
    if (!target || nonce === downloadedRequest.current || !props.connected) return;
    if (!selected) {
      if (openingForDownload.current) return;
      openingForDownload.current = true;
      void run({ operation: "open" }).finally(() => { openingForDownload.current = false; });
      return;
    }
    downloadedRequest.current = nonce;
    void run({ operation: "download", pageId: selected || undefined, revision, url: target });
  }, [props.downloadUrl, props.actionNonce, props.connected, selected, revision]);
  useEffect(() => {
    if (props.connected) void run({ operation: "list" }, true);
    return () => {
      generation.current++;
      locked.current = false;
      setBusy(false);
    };
  }, [request]);
  useEffect(() => {
    if (!props.connected) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !drawing.current && !points.length)
        void run({ operation: selected && props.active !== false && state.agentActivity?.status !== 'running' ? "screenshot" : "list", pageId: props.active !== false ? selected || undefined : undefined }, true);
    }, props.active !== false ? 1000 : 2500);
    return () => clearInterval(timer);
  }, [selected, props.connected, props.active, request, points.length, state.agentActivity?.status]);
  useEffect(() => {
    const changed = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type === 'dashboard:browser-changed' && message.deviceId === props.targetDeviceId &&
        message.sessionId === props.sessionId && props.projectPath && canonicalWebPath(message.projectPath) === canonicalWebPath(props.projectPath)) setRefreshTick(value => value + 1);
    };
    window.addEventListener('message', changed);
    return () => window.removeEventListener('message', changed);
  }, [props.projectPath, props.targetDeviceId, props.sessionId]);
  useEffect(() => {
    if (refreshTick === refreshedTick.current || !props.connected || busy || drawing.current || points.length || document.visibilityState !== 'visible') return;
    refreshedTick.current = refreshTick;
    void run({ operation: 'list', pageId: props.active !== false ? selected || undefined : undefined }, true);
  }, [refreshTick, props.connected, busy, selected, props.active, request, points.length]);
  const command = (value: Partial<WorkspaceBrowserRequest> & Pick<WorkspaceBrowserRequest, "operation">): void => {
    if (
      points.length &&
      !["feedback", "deleteFeedback", "readFeedback", "screenshot", "list"].includes(value.operation)
    ) {
      setFailed(true);
      setNotice("Save or cancel the current mark before changing the page.");
      return;
    }
    void run({ pageId: selected, revision, ...value });
  };
  const coordinate = (event: JSX.TargetedPointerEvent<SVGSVGElement>): BrowserPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(size.width, ((event.clientX - rect.left) / rect.width) * size.width))),
      y: Math.round(Math.max(0, Math.min(size.height, ((event.clientY - rect.top) / rect.height) * size.height)))
    };
  };
  const addFeedback = async (): Promise<void> => {
    if (!points.length || !revision) return;
    const feedback = {
      id: crypto.randomUUID(),
      pageId: selected,
      revision,
      kind: mode === "interact" ? ("comment" as const) : mode,
      points,
      text,
      selector: elementSelector || undefined,
      referenceUrl: reference || undefined
    };
    savedId.current = feedback.id;
    await run({ operation: "feedback", pageId: selected, revision, feedback });
    // Keep the draft until its ID is returned in a later verified state.
  };
  useEffect(() => {
    if (state.feedback.some((f) => f.id === savedId.current)) {
      savedId.current = undefined;
      setPoints([]);
      setText("");
      setReference("");
    }
  }, [state.feedback]);
  const feedback = state.feedback.filter((f) => f.pageId === selected && f.revision === revision);
  const addInstruction = async (items: BrowserFeedback[]): Promise<void> => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    const version = generation.current;
    try {
      if (!props.onInstruction) throw new Error('The instruction composer is unavailable.');
      // Prepare every attachment before changing the composer, so failed reads can be retried safely.
      const prepared = [];
      for (const feedback of items) {
        const response = await request('workspaceBrowser', { browserRequest: { operation: 'readFeedback', feedbackId: feedback.id } });
        const image = response.workspaceBrowser?.feedbackImage;
        if (!image) throw new Error('The saved feedback screenshot is unavailable. No feedback was added.');
        prepared.push({ feedback, image: await annotateScreenshot(image, feedback) });
      }
      if (version !== generation.current) return;
      props.onInstruction(prepared.map(({ feedback }) => `Browser feedback: ${feedback.url}\n${feedback.kind} at ${JSON.stringify(feedback.points)}\n${feedback.text}${feedback.selector ? `\nElement: ${feedback.selector}` : ""}${feedback.referenceUrl ? `\nDesign reference: ${feedback.referenceUrl}` : ""}\nFeedback ID: ${feedback.id}`).join('\n\n'), prepared[0]?.image, prepared.map(item => item.image));
      setFailed(false);
      setNotice("Feedback and marked screenshots added to the composer. Review and send when ready.");
    } catch (error) {
      setFailed(true);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === generation.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  };
  const pickElement = async (point: BrowserPoint, commit = true): Promise<void> => {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    const version = generation.current;
    try {
      const response = await request('workspaceBrowser', { browserRequest: { operation: 'styles', pageId: selected, ...point } });
      if (version !== generation.current) return;
      const value = response.workspaceBrowser?.value as { selector?: string; rect?: { x: number; y: number; width: number; height: number } } | undefined;
      if (!value?.selector) throw new Error('No element was returned. Refresh and select it again.');
      setHoverRect(value.rect);
      if (commit) { setElementSelector(value.selector); setInspectorTab('elements'); setInspectorOpen(true); setInspect(false); }
    } catch (error) { if (commit && version === generation.current) { setFailed(true); setNotice(error instanceof Error ? error.message : String(error)); } }
    finally { if (version === generation.current) { locked.current = false; setBusy(false); } }
  };
  const chooseTool = (tool: typeof mode): void => {
    if (points.length) { setFailed(true); setNotice('Save or cancel the current mark before changing tools.'); return; }
    setMode(tool); setInspect(false); setActiveFeedback('');
  };
  const visibleNote = feedback.find(item => item.id === activeFeedback);
  const anchor = points[0] ?? visibleNote?.points[0];
  const shape = (f: Pick<BrowserFeedback, "kind" | "points" | "text">) => {
    const first = f.points[0];
    if (!first) return null;
    const last = f.points.at(-1)!;
    return (
      <g>
        {f.kind === "area" ? (
          <rect
            x={Math.min(first.x, last.x)}
            y={Math.min(first.y, last.y)}
            width={Math.max(6, Math.abs(last.x - first.x))}
            height={Math.max(6, Math.abs(last.y - first.y))}
            fill="#ff654522"
            stroke="#ff6545"
            stroke-width="3"
          />
        ) : f.kind === "draw" ? (
          <polyline
            points={f.points.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="#ff6545"
            stroke-width="3"
          />
        ) : (
          <circle cx={first.x} cy={first.y} r="9" fill="#ff654544" stroke="#ff6545" stroke-width="3" />
        )}
        <text
          x={first.x + 14}
          y={Math.max(18, first.y)}
          fill="#fff"
          stroke="#111"
          paint-order="stroke"
          stroke-width="3"
          font-size="16"
        >
          {f.text.slice(0, 80)}
        </text>
      </g>
    );
  };
  const browserControls = <div class="workspace-browser-inspector-tools" role="toolbar" aria-label="Feedback tools">
    {(['interact', 'pointer', 'area', 'draw'] as const).map(tool => <button type="button" class="workspace-browser-icon-button" aria-label={tool === 'interact' ? 'Control page / select element' : tool} title={tool === 'interact' ? (inspect ? 'Return to page control' : 'Control page / select an element') : tool === 'draw' ? 'Freehand pen' : tool === 'area' ? 'Rectangle' : 'Pointer'} aria-pressed={mode === tool} disabled={busy || !props.connected || !revision || !!points.length} onClick={() => {
      chooseTool(tool);
      if (tool === 'interact') { setInspect(!inspect); if (!inspect) { setInspectorOpen(true); setInspectorTab('elements'); } }
    }}><BrowserMarkIcon tool={tool} /></button>)}
  </div>;
  return (
    <section class="workspace-browser" aria-label="Development browser">
      <form class="workspace-browser-address" onSubmit={(event) => { event.preventDefault(); const nextUrl = normalizeBrowserInput(url); if (!nextUrl) { setFailed(true); setNotice("Enter a website address."); return; } setUrl(nextUrl); command({ operation: current ? "navigate" : "open", url: nextUrl }); }}>
        <button class="workspace-browser-icon-button" aria-label="Go back" title="Go back" disabled={busy || !current || !props.connected} type="button" onClick={() => command({ operation: "back" })}><ToolIcon kind="left" /></button>
        <button class="workspace-browser-icon-button" aria-label="Go forward" title="Go forward" disabled={busy || !current || !props.connected} type="button" onClick={() => command({ operation: "forward" })}><ToolIcon kind="right" /></button>
        <button class="workspace-browser-icon-button" aria-label="Reload page" title="Reload page" disabled={busy || !current || !props.connected} type="button" onClick={() => command({ operation: "reload" })}><ToolIcon kind="refresh" /></button>
        <input aria-label="Browser URL" type="text" inputMode="url" placeholder="Search or enter a URL" value={url} onInput={(e) => setUrl(e.currentTarget.value)} />
        <button class="workspace-browser-icon-button workspace-browser-go" type="submit" aria-label="Go to URL" title="Go to URL" disabled={busy || !props.connected || !url.trim()}><ToolIcon kind="right" /></button>
      <div class="workspace-browser-actions">
        <button class="workspace-browser-icon-button" type="button" aria-label="Toggle responsive viewport" title="Toggle responsive viewport" aria-pressed={responsive} onClick={() => setResponsive(value => !value)}><ToolIcon kind="split" /></button>
        <button class="workspace-browser-icon-button" type="button" aria-label={inspectorOpen ? "Close browser inspector" : "Open browser inspector"} title={inspectorOpen ? "Close browser inspector" : "Open browser inspector"} aria-pressed={inspectorOpen} onClick={() => setInspectorOpen((value) => !value)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20" /></svg></button>
      </div>
      </form>
      {!props.connected ? (
        <p role="status">Offline. Reconnect to control the browser. Unsaved feedback stays in this panel.</p>
      ) : null}
      {agentVisible && state.agentActivity ? <p class="workspace-browser-agent-activity" role="status">AI · {state.agentActivity.operation} · {state.agentActivity.status}</p> : null}
      <div class={`workspace-browser-content dock-${dock}`}>
      <div class="workspace-browser-page">
      {responsive ? <form class="workspace-browser-viewport" aria-label="Responsive viewport" onSubmit={event => { event.preventDefault(); command({ operation: 'resize', ...viewport }); }}>
        <span>Dimensions:</span>
        <select aria-label="Viewport preset" value={viewportPreset} disabled={busy || !current || !props.connected} onChange={event => {
          const preset = event.currentTarget.value;
          setViewportPreset(preset);
          const next = preset === 'phone' ? { width: 390, height: 844 } : preset === 'tablet' ? { width: 768, height: 1024 } : preset === 'desktop' ? { width: 1280, height: 800 } : viewport;
          setViewport(next);
          command({ operation: 'resize', ...next });
        }}><option value="responsive">Responsive</option><option value="phone">Phone</option><option value="tablet">Tablet</option><option value="desktop">Desktop</option></select>
        <input type="number" aria-label="Viewport width" min={320} max={3840} required value={viewport.width} onInput={event => { setViewportPreset('responsive'); setViewport(value => ({ ...value, width: event.currentTarget.valueAsNumber })); }} />
        <span aria-hidden="true">×</span>
        <input type="number" aria-label="Viewport height" min={240} max={2160} required value={viewport.height} onInput={event => { setViewportPreset('responsive'); setViewport(value => ({ ...value, height: event.currentTarget.valueAsNumber })); }} />
        <button type="submit" disabled={busy || !current || !props.connected}>Apply</button>
        <button class="workspace-browser-icon-button" type="button" aria-label="Rotate viewport" title="Rotate viewport" disabled={busy || !current || !props.connected || viewport.height < 320 || viewport.width > 2160} onClick={() => { const next = { width: viewport.height, height: viewport.width }; setViewport(next); command({ operation: 'resize', ...next }); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m9 3-6 6 12 12 6-6zM3 3v5h5M21 21v-5h-5" /></svg></button>
      </form> : null}
      <div class="workspace-browser-stage" data-browser-revision={revision} style={{ '--browser-viewport-width': `${size.width}px`, '--browser-preview-ratio': String(size.width / size.height) }}>
      {state.image && current && current.url !== 'about:blank' && state.pageId === selected ? (
        <div class="workspace-browser-preview">
          <img
            src={state.image}
            alt={`Browser preview of ${current.url}`}
            onLoad={(event) =>
              setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
            }
          />
          <svg
            viewBox={`0 0 ${size.width} ${size.height}`}
            aria-label="Browser preview. Type or paste into the focused page field. Arrow keys move the pointer; Enter marks in annotation mode. Shift and arrow keys extend an area or drawing."
            role="application"
            tabindex={0}
            onKeyDown={(event) => {
              if (!props.connected || !revision) return;
              if (mode === 'interact' && !inspect && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key.length === 1 || ['Backspace', 'Delete', 'Tab', 'Enter'].includes(event.key))) {
                event.preventDefault();
                queuePageInput({ pageId: selected, operation: event.key.length === 1 ? 'type' : 'press', ...(event.key.length === 1 ? { text: event.key } : { key: event.shiftKey ? `Shift+${event.key}` : event.key }) });
                return;
              }
              if (busy) return;
              if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
                event.preventDefault();
                const point = {
                  x: Math.max(
                    0,
                    Math.min(
                      size.width,
                      cursor.x + (event.key === "ArrowLeft" ? -10 : event.key === "ArrowRight" ? 10 : 0)
                    )
                  ),
                  y: Math.max(
                    0,
                    Math.min(
                      size.height,
                      cursor.y + (event.key === "ArrowUp" ? -10 : event.key === "ArrowDown" ? 10 : 0)
                    )
                  )
                };
                setCursor(point);
                if (event.shiftKey && (mode === "area" || mode === "draw"))
                  setPoints((previous) =>
                    mode === "area" ? [previous[0] ?? cursor, point] : [...previous.slice(0, 499), point]
                  );
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (inspect) void pickElement(cursor);
                else if (mode === "interact") command({ operation: "click", ...cursor });
                else setPoints((previous) => (mode === "area" && previous.length ? [previous[0]!, cursor] : [cursor]));
              }
            }}
            style={{ touchAction: "none" }}
            onPaste={event => {
              if (mode !== 'interact' || inspect || !props.connected || !revision) return;
              const text = event.clipboardData?.getData('text/plain');
              if (text) { event.preventDefault(); queuePageInput({ pageId: selected, operation: 'type', text }); }
            }}
            onWheel={event => { if (mode === 'interact' && !inspect && !busy && props.connected && revision) { event.preventDefault(); command({ operation: 'scroll', x: event.deltaX, y: event.deltaY }); } }}
            onPointerDown={(event) => {
              if (busy || !props.connected || !revision) return;
              const point = coordinate(event);
              event.currentTarget.focus();
              if (inspect) { void pickElement(point); return; }
              if (points.length) { setFailed(true); setNotice('Save or cancel the current mark first.'); return; }
              setActiveFeedback('');
              if (mode === "interact") {
                command({ operation: "click", ...point });
                return;
              }
              drawing.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              setPoints([point]);
            }}
            onPointerMove={(event) => {
              if (inspect && !drawing.current) {
                const point = coordinate(event);
                if (hoverTimer.current) clearTimeout(hoverTimer.current);
                hoverTimer.current = setTimeout(() => void pickElement(point, false), 70);
                return;
              }
              if (drawing.current && (mode === "draw" || mode === "area")) {
                const point = coordinate(event);
                setPoints((previous) => (mode === "area" ? [previous[0]!, point] : [...previous.slice(0, 499), point]));
              }
            }}
            onPointerUp={() => {
              drawing.current = false;
            }}
            onPointerCancel={() => {
              drawing.current = false;
            }}
          >
            {showMarks ? feedback.map((f, index) => <g key={f.id} class="workspace-browser-saved-mark" role="button" tabindex={0} aria-label={`Comment ${index + 1}: ${f.text || 'Visual mark'}`} onPointerDown={event => { event.stopPropagation(); if (points.length) { setFailed(true); setNotice('Save or cancel the current mark first.'); return; } setActiveFeedback(f.id); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (!points.length) setActiveFeedback(f.id); } }}>
              {shape({ ...f, text: '' })}<circle cx={f.points[0]!.x} cy={f.points[0]!.y} r="15" fill="#6366f1" stroke="white" stroke-width="2" /><text x={f.points[0]!.x} y={f.points[0]!.y + 5} text-anchor="middle" fill="white" font-size="14">{index + 1}</text>
            </g>) : null}
            {shape({ kind: mode === "interact" ? "pointer" : mode, points, text })}
            <circle
              class="workspace-browser-key-cursor"
              cx={cursor.x}
              cy={cursor.y}
              r="6"
              fill="none"
              stroke="#469fff"
              stroke-width="2"
            />
            {inspect && hoverRect ? <rect class="workspace-browser-element-hover" x={hoverRect.x} y={hoverRect.y} width={hoverRect.width} height={hoverRect.height} fill="#1a73e822" stroke="#1a73e8" stroke-width="2" stroke-dasharray="5 3" /> : null}
            {agentVisible && state.agentPointer ? <g class="workspace-browser-agent-pointer" role="img" aria-label={`AI pointer: ${state.agentPointer.action}`} pointer-events="none" transform={`translate(${state.agentPointer.x} ${state.agentPointer.y})`} style={{ transition: 'transform 160ms ease-out' }}>
              <circle r="18" fill="#6366f122" stroke="#6366f1" stroke-width="2" />
              <path d="M0 0 4 23 10 16 20 15Z" fill="#6366f1" stroke="white" stroke-width="2" />
              <rect x="19" y="18" width="78" height="24" rx="6" fill="#4338ca" />
              <text x="25" y="34" fill="white" font-size="12">AI · {state.agentPointer.action}</text>
            </g> : null}
          </svg>
          {anchor && (points.length > 0 || visibleNote) ? <div class="workspace-browser-inline-comment" role="dialog" aria-label={visibleNote ? 'Saved comment' : 'Comment on mark'} style={{ left: `${Math.min(65, Math.max(2, anchor.x / size.width * 100))}%`, top: `${Math.min(70, Math.max(2, anchor.y / size.height * 100))}%` }}>
            <header><strong>{visibleNote ? 'Comment' : 'New comment'}</strong><button type="button" aria-label="Close comment" onClick={() => { if (visibleNote) setActiveFeedback(''); else { setPoints([]); setText(''); setReference(''); noticeAction('Mark cancelled.'); } }}>×</button></header>
            {visibleNote ? <><p>{visibleNote.text || 'Visual mark'}</p>{visibleNote.selector ? <code class="workspace-browser-feedback-selector">{visibleNote.selector}</code> : null}<button type="button" disabled={busy || !props.connected || !props.onInstruction} onClick={() => void addInstruction([visibleNote])}>Add to instruction</button></> : <>
              <textarea aria-label="Area instruction or design feedback" maxLength={8000} placeholder="Describe the change…" value={text} onInput={event => setText(event.currentTarget.value)} />
              <input type="url" aria-label="Design or inspiration reference URL" placeholder="Reference URL (optional)" value={reference} onInput={event => setReference(event.currentTarget.value)} />
              <footer><button type="button" disabled={busy || !current || !props.connected} onClick={() => void addFeedback()}>Save feedback</button><button type="button" onClick={() => { setPoints([]); setText(''); setReference(''); noticeAction('Mark cancelled.'); }}>Cancel mark</button></footer>
            </>}
          </div> : null}
        </div>
      ) : (
        <div class="workspace-browser-welcome" aria-label="New browser tab">
          <div class="workspace-browser-welcome-icon"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="8" width="38" height="32" rx="5" /><path d="M5 17h38M11 12.5h1m4 0h1m4 0h1M18 25l-5 4 5 4m12-8 5 4-5 4m-4-11-4 14" /></svg></div>
          <small>CODEX MANAGER BROWSER</small><h2>Your next idea starts here</h2><p>Enter a URL above and choose Go to open your website.</p>
          <button type="button" onClick={event => { const address = event.currentTarget.closest('.workspace-browser')?.querySelector<HTMLInputElement>('[aria-label="Browser URL"]'); address?.focus(); address?.select(); }}>Enter a URL <span aria-hidden="true">↗</span></button>
          <div class="workspace-browser-welcome-features"><span>Inspect elements</span><span>Test interactions</span><span>Mark and comment</span><span>Share tabs with AI</span></div>
        </div>
      )}
      </div>
      </div>
      {inspectorOpen ? <BrowserResizeHandle label="Resize browser inspector" value={inspectorSize} onChange={setInspectorSize} axis={dock === 'bottom' ? 'y' : 'x'} reverse={dock !== 'left'} responsive /> : null}
      <aside style={{ '--inspector-size': `${inspectorSize}%` }} data-inspector-theme={theme} class={`workspace-browser-inspector ${inspectorOpen ? "is-open" : ""}`} aria-label="Browser inspector" aria-hidden={!inspectorOpen}>
        <header class="workspace-browser-inspector-header">
          {browserControls}
          <nav class="workspace-browser-inspector-tabs" role="tablist" aria-label="Browser inspector panels">
            {(["elements", "console", "sources", "network", "application", "performance", "memory", "feedback"] as const).map((tab) => <button type="button" role="tab" aria-selected={inspectorTab === tab} class={inspectorTab === tab ? "is-active" : ""} onClick={() => setInspectorTab(tab)}>{tab === 'feedback' ? 'Comments' : tab.charAt(0).toUpperCase() + tab.slice(1)}</button>)}
          </nav>
          <div class="workspace-browser-inspector-actions"><button class="workspace-browser-icon-button" type="button" aria-label="Close browser inspector" title="Close browser inspector" onClick={() => setInspectorOpen(false)}><ToolIcon kind="close" /></button></div>
        </header>

        <div class={`workspace-browser-inspector-layout drawer-${drawerSide}`}>
        <div class="workspace-browser-inspector-body">
          {settings ? <section class="workspace-browser-settings" aria-label="Inspector settings"><header><strong>Settings</strong><button type="button" onClick={() => setSettings(false)}>Close settings</button></header><label>Theme <select aria-label="Inspector theme" value={theme} onChange={event => setTheme(event.currentTarget.value)}><option value="auto">Auto</option><option value="dark">Dark</option><option value="light">Light</option></select></label><label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.currentTarget.checked)} />Word wrap sources</label><label>Console drawer <select aria-label="Console drawer position" value={drawerSide} onChange={event => setDrawerSide(event.currentTarget.value as typeof drawerSide)}><option value="bottom">Bottom</option><option value="right">Right</option></select></label></section> : inspectorTab === 'feedback' ? <section class="workspace-browser-feedback-list" aria-label="Saved feedback">
            <header><strong>Comments ({state.feedback.length})</strong><button type="button" disabled={busy || !props.connected || !state.feedback.length || !props.onInstruction} title="Add all saved feedback and marked screenshots to the instruction composer" onClick={() => void addInstruction(state.feedback)}>Send all</button></header>
            <input aria-label="Search comments" placeholder="Search comments?" value={feedbackFilter} onInput={event => setFeedbackFilter(event.currentTarget.value)} />
            {!state.feedback.length ? <p>Choose a mark tool and click or draw on the page to add a comment.</p> : null}
            {state.feedback.filter(item => `${item.text} ${item.url} ${item.selector ?? ''}`.toLowerCase().includes(feedbackFilter.toLowerCase())).map(f => <article key={f.id} class={f.id === activeFeedback ? 'is-selected' : ''}>
              <strong>{state.feedback.indexOf(f) + 1}. {f.kind}</strong><small>{f.url}</small>{f.selector ? <code class="workspace-browser-feedback-selector">{f.selector}</code> : null}<p>{f.text || 'Visual mark'}</p>
              {f.referenceUrl ? <a href={f.referenceUrl} target="_blank" rel="noreferrer">Reference ?</a> : null}
              <footer><button type="button" disabled={!!points.length || !feedback.some(item => item.id === f.id)} onClick={() => { setActiveFeedback(f.id); setShowMarks(true); }}>Show mark</button><button type="button" disabled={busy || !props.connected || !props.onInstruction} onClick={() => void addInstruction([f])}>Add to instruction</button><button type="button" disabled={busy || !props.connected} onClick={() => command({ operation: 'deleteFeedback', feedbackId: f.id })}>Delete</button></footer>
            </article>)}
          </section> : inspectorOpen ? <BrowserInspectorContent key={selected} panel={inspectorTab} pageId={selected} revision={revision} connected={props.connected} request={request} busy={busy} selector={elementSelector} wrap={wrap} outcome={consoleOutcome?.pageId === selected ? consoleOutcome : undefined} onClearConsole={() => setConsoleOutcome(undefined)} onEvaluate={text => command({ operation: 'evaluate', confirmed: true, text })} onCommand={command} /> : null}
        </div>
        {inspectorOpen && consoleDrawer && inspectorTab !== 'console' ? <><BrowserResizeHandle label="Resize Console drawer" value={drawerSize} onChange={setDrawerSize} axis={drawerSide === 'bottom' ? 'y' : 'x'} reverse /><section class="workspace-browser-console-drawer" aria-label="Console drawer" style={{ flexBasis: `${drawerSize}%` }}><header><strong>Console</strong><button type="button" onClick={() => setDrawerSide(value => value === 'bottom' ? 'right' : 'bottom')}>Dock {drawerSide === 'bottom' ? 'right' : 'bottom'}</button><button type="button" aria-label="Close Console drawer" onClick={() => setConsoleDrawer(false)}>?</button></header><BrowserInspectorContent panel="console" pageId={selected} revision={revision} connected={props.connected} request={request} busy={busy} outcome={consoleOutcome?.pageId === selected ? consoleOutcome : undefined} onClearConsole={() => setConsoleOutcome(undefined)} onEvaluate={text => command({ operation: 'evaluate', confirmed: true, text })} onCommand={command} /></section></> : null}
        </div>
      </aside>
      </div>
    </section>
  );
}

export function normalizeBrowserInput(value: string): string {
  const input = value.trim();
  if (!input) return "";
  if (input === 'about:blank') return input;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return input;
  if (/^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input)) return `http://${input}`;
  return `https://${input}`;
}

function BrowserMarkIcon(props: { tool: 'interact' | BrowserFeedback['kind'] }) {
  if (props.tool === 'comment') return <ToolIcon kind="comment" />;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{props.tool === 'interact' ? <path d="m5 3 14 9-7 1-3 7z" /> : props.tool === 'pointer' ? <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></> : props.tool === 'area' ? <rect x="4" y="5" width="16" height="14" rx="1" /> : <><path d="m5 16-1 4 4-1L20 7l-3-3zM14 7l3 3" /></>}</svg>;
}

async function annotateScreenshot(source: string, feedback: BrowserFeedback): Promise<string> {
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The marked screenshot could not be prepared.");
  context.drawImage(image, 0, 0);
  context.strokeStyle = "#ff6545";
  context.fillStyle = "#ff654533";
  context.lineWidth = 4;
  const first = feedback.points[0]!,
    last = feedback.points.at(-1)!;
  if (feedback.kind === "area") {
    context.fillRect(first.x, first.y, last.x - first.x, last.y - first.y);
    context.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y);
  } else if (feedback.kind === "draw") {
    context.beginPath();
    feedback.points.forEach((point, index) => {
      if (index) context.lineTo(point.x, point.y);
      else context.moveTo(point.x, point.y);
    });
    context.stroke();
  } else {
    context.beginPath();
    context.arc(first.x, first.y, 10, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.font = "16px sans-serif";
  context.fillStyle = "#ff6545";
  context.fillText(feedback.text.slice(0, 80), Math.min(first.x, canvas.width - 100), Math.max(20, first.y - 10));
  return canvas.toDataURL("image/jpeg", 0.8);
}
