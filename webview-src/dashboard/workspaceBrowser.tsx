import { useEffect, useRef, useState } from "preact/hooks";
import { BrowserInspectorContent, BrowserResizeHandle, emptyBrowserConsole, type BrowserConsoleState } from './workspaceBrowserInspector';
import type { JSX } from "preact";
import { useWorkspaceRequest } from "./workspaceRequest";
import { ToolIcon } from "./icons";
import { ModalShell } from './primitives';
import { WorkspaceMenu } from './workspaceMenu';
import { BrowserCredentials } from './browserCredentials';
import { downloadInViewer } from './workspaceSurface';
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
  onOpenPageHandled?: (nonce: number) => void;
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
    [notice, setNotice] = useState(""),
    [failed, setFailed] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [pageCursor, setPageCursor] = useState('default');
  const cursorSequence = useRef(0);
  const pageDrag = useRef<BrowserPoint>();
  const [commentPosition, setCommentPosition] = useState<{ x: number; y: number }>();
  const commentDrag = useRef<{ x: number; y: number; left: number; top: number }>();
  const [editingMark, setEditingMark] = useState<BrowserFeedback>();
  const markDrag = useRef<{ start: BrowserPoint; points: BrowserPoint[]; corner?: number }>();
  const [mode, setMode] = useState<"interact" | BrowserFeedback["kind"]>("interact");
  const [points, setPoints] = useState<BrowserPoint[]>([]),
    [text, setText] = useState(""),
    [reference, setReference] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [dock, setDock] = useState<'left' | 'right' | 'bottom'>('right');
  const [responsive, setResponsive] = useState(false);
  const [zoom, setZoom] = useState(100);
  const zoomBy = (delta: number): void => setZoom(value => Math.max(25, Math.min(300, value + delta)));
  const [viewport, setViewport] = useState({ width: 390, height: 844 });
  const [viewportPreset, setViewportPreset] = useState('responsive');
  const [consoleStates, setConsoleStates] = useState<Record<string, BrowserConsoleState>>({});
  const updateConsole = (next: BrowserConsoleState) => setConsoleStates(previous => ({ ...previous, [selected]: next }));
  const [consoleOutcome, setConsoleOutcome] = useState<{ pageId: string; value?: unknown; message: string; failed: boolean }>();
  const [consoleDrawer, setConsoleDrawer] = useState(false);
  const [settings, setSettings] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"elements" | "console" | "sources" | "network" | "application" | "performance" | "memory">("elements");
  const [inspectorSize, setInspectorSize] = useState(45);
  const [inspect, setInspect] = useState(false), [elementSelector, setElementSelector] = useState('body');
  const [activeFeedback, setActiveFeedback] = useState(''), [showMarks, setShowMarks] = useState(true);
  const [feedbackFilter, setFeedbackFilter] = useState('');
  const [drawerSide, setDrawerSide] = useState<'bottom' | 'right'>('bottom');
  const [drawerSize, setDrawerSize] = useState(35);
  const [theme, setTheme] = useState('auto'), [wrap, setWrap] = useState(false);
  const [size, setSize] = useState({ width: 1280, height: 800 });
  const [cursor, setCursor] = useState<BrowserPoint>({ x: 20, y: 20 });
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
  const pageDrafts = useRef(new Map<string, { points: BrowserPoint[]; text: string; reference: string; mode: typeof mode; editingMark?: BrowserFeedback }>());
  const draftPage = useRef(selected);
  pageDrafts.current.set(draftPage.current, { points, text, reference, mode, editingMark });
  const revision = state.pageId === selected ? state.revision : undefined;
  const current = state.pages.find((page) => page.id === selected);
  const noticeAction = (message: string): void => { setNotice(message); setFailed(false); };
  useEffect(() => {
    if (draftPage.current !== selected) {
      setActiveFeedback(''); setInspect(false);
      const draft = pageDrafts.current.get(selected);
      draftPage.current = selected;
      setPoints(draft?.points ?? []); setText(draft?.text ?? ''); setReference(draft?.reference ?? ''); setMode(draft?.mode ?? 'interact'); setEditingMark(draft?.editingMark);
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
        downloadInViewer(next.fileDownload);
        noticeAction(`${next.fileDownload.filename}: download started in this viewer.`);
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
        setNotice(next.warning ?? (next.fileDownload ? `${next.fileDownload.filename}: download started in this viewer.` : 'Done.'));
      }
    } catch (error) {
      if (version !== generation.current) return;
      const detail = error instanceof Error ? error.message : String(error);
      const message = detail.includes('Unsupported dashboard action: workspaceBrowser') ? 'This host is running an older Manager. Restart that host with the installed version, then reconnect.' : detail;
      if (!quiet) { setNotice(message); setFailed(true); pageInput.current = []; }
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
    if (!nonce || nonce === openedPageRequest.current || !props.connected || busy || locked.current) return;
    openedPageRequest.current = nonce; // Fence before dispatch; never replay an unconfirmed mutation.
    latest.current.onOpenPageHandled?.(nonce);
    setUrl("about:blank");
    void run({ operation: "open", url: "about:blank" });
  }, [props.openPageNonce, props.connected, busy]);
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
  const coordinate = (event: JSX.TargetedPointerEvent<SVGElement>): BrowserPoint => {
    const svg = event.currentTarget instanceof SVGSVGElement ? event.currentTarget : event.currentTarget.ownerSVGElement!;
    const rect = svg.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(size.width, ((event.clientX - rect.left) / rect.width) * size.width))),
      y: Math.round(Math.max(0, Math.min(size.height, ((event.clientY - rect.top) / rect.height) * size.height)))
    };
  };
  const addFeedback = async (): Promise<void> => {
    if (!points.length || !revision) return;
    const feedback = {
      id: editingMark?.id ?? crypto.randomUUID(),
      pageId: selected,
      revision,
      kind: mode === "interact" ? ("comment" as const) : mode,
      points,
      text,
      selector: elementSelector || undefined,
      referenceUrl: reference || undefined
    };
    savedId.current = feedback.id;
    await run({ operation: editingMark ? 'updateFeedback' : 'feedback', pageId: selected, revision, feedback, ...(editingMark ? { params: { expected: JSON.stringify([editingMark.id, editingMark.createdAt, editingMark.text, editingMark.points, editingMark.referenceUrl ?? '']) } } : {}) });
    // Keep the draft until its ID is returned in a later verified state.
  };
  useEffect(() => {
    if (state.feedback.some((f) => f.id === savedId.current)) {
      savedId.current = undefined;
      setPoints([]);
      setText("");
      setReference("");
      setEditingMark(undefined);
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
    cancelMark();
    setMode(mode === tool ? 'interact' : tool);
  };
  const cancelMark = (): void => {
    drawing.current = false; pageDrag.current = undefined; markDrag.current = undefined; setEditingMark(undefined); setPoints([]); setText(''); setReference(''); setActiveFeedback(''); setInspect(false); setMode('interact'); setHoverRect(undefined); setCommentPosition(undefined);
  };
  const dragMark = (event: JSX.TargetedPointerEvent<SVGElement>, mark?: BrowserFeedback, corner?: number): void => {
    if (busy || drawing.current || !props.connected || points.length && mark) return;
    event.preventDefault(); event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement!;
    const source = mark?.points ?? points;
    if (mark) { setEditingMark(mark); setPoints(mark.points.map(point => ({ ...point }))); setText(mark.text); setReference(mark.referenceUrl ?? ''); setMode(mark.kind); setActiveFeedback(''); }
    markDrag.current = { start: coordinate(event), points: source.map(point => ({ ...point })), corner };
    drawing.current = true; svg.setPointerCapture(event.pointerId);
  };
  const readCursor = async (point: BrowserPoint): Promise<void> => {
    const sequence = ++cursorSequence.current;
    try {
      const response = await request('workspaceBrowser', { browserRequest: { operation: 'cursor', pageId: selected, ...point } });
      const value = response.workspaceBrowser?.value as { cursor?: string } | undefined;
      if (sequence === cursorSequence.current) setPageCursor(value?.cursor ?? 'default');
    } catch { if (sequence === cursorSequence.current) setPageCursor('default'); }
  };
  const visibleNote = feedback.find(item => item.id === activeFeedback);
  useEffect(() => {
    if (!points.length && !activeFeedback) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.workspace-browser-inline-comment,.workspace-browser-draft-mark,.workspace-browser-mark-handle')) return;
      cancelMark(); noticeAction('Mark cancelled.');
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [points.length, activeFeedback]);
  const agentVisible = !!state.agentActivity;
  const agentPoint = state.agentPointer ?? { x: 28, y: 36, action: state.agentActivity?.operation ?? 'inspect', updatedAt: state.agentActivity?.updatedAt ?? 0 };
  const agentLabel = ({ events: 'Reading console / network', html: 'Inspecting HTML', styles: 'Inspecting CSS', evaluate: 'Running JavaScript', cdp: 'Using DevTools', storage: 'Inspecting storage', snapshot: 'Reading page', screenshot: 'Capturing page', navigate: 'Navigating', reload: 'Reloading', click: 'Clicking', hover: 'Pointing', fill: 'Filling field', type: 'Typing', press: 'Pressing key', scroll: 'Scrolling', resize: 'Resizing', wait: 'Waiting', select: 'Selecting' } as Record<string, string>)[state.agentActivity?.operation ?? ''] ?? state.agentActivity?.operation;
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
    {(['interact', 'pointer', 'area', 'draw'] as const).map(tool => <button type="button" class="workspace-browser-icon-button" aria-label={tool === 'interact' ? 'Control page / select element' : tool} title={tool === 'interact' ? (inspect ? 'Return to page control' : 'Select an element; click again for page control') : tool === 'draw' ? 'Freehand pen' : tool === 'area' ? 'Rectangle' : 'Pointer'} aria-pressed={tool === 'interact' ? inspect : mode === tool} disabled={busy || !props.connected || !revision} onClick={() => {
      chooseTool(tool);
      if (tool === 'interact') { setInspect(!inspect); if (!inspect) { setInspectorOpen(true); setInspectorTab('elements'); } }
    }}><BrowserMarkIcon tool={tool} /></button>)}
  </div>;
  return (
    <section class="workspace-browser" aria-label="Development browser" onKeyDownCapture={event => {
      if ((event.ctrlKey || event.metaKey) && ['+', '=', '-', '0'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (event.key === '0') setZoom(100); else zoomBy(event.key === '-' ? -25 : 25); return; }
      if (event.key === 'Escape' && (points.length || activeFeedback || inspect || mode !== 'interact')) { event.preventDefault(); event.stopPropagation(); cancelMark(); noticeAction('Mark cancelled.'); }
    }}>
      <form class="workspace-browser-address" onSubmit={(event) => { event.preventDefault(); const nextUrl = normalizeBrowserInput(url); if (!nextUrl) { setFailed(true); setNotice("Enter a website address."); return; } setUrl(nextUrl); command({ operation: current ? "navigate" : "open", url: nextUrl }); }}>
        <button class="workspace-browser-icon-button" aria-label="Go back" title="Go back" disabled={busy || !current || !props.connected} type="button" onClick={() => command({ operation: "back" })}><ToolIcon kind="left" /></button>
        <button class="workspace-browser-icon-button" aria-label="Go forward" title="Go forward" disabled={busy || !current || !props.connected} type="button" onClick={() => command({ operation: "forward" })}><ToolIcon kind="right" /></button>
        <button class="workspace-browser-icon-button" aria-label="Reload page" title="Reload page" disabled={busy || !current || !props.connected} type="button" onClick={() => command({ operation: "reload" })}><ToolIcon kind="refresh" /></button>
        <input aria-label="Browser URL" type="text" inputMode="url" placeholder="Search or enter a URL" value={url} onInput={(e) => setUrl(e.currentTarget.value)} />
        <button class="workspace-browser-icon-button workspace-browser-go" type="submit" aria-label="Go to URL" title="Go to URL" disabled={busy || !props.connected || !url.trim()}><ToolIcon kind="right" /></button>
      <div class="workspace-browser-actions">
        {notice && !points.length ? <span class={`workspace-browser-action-status ${failed ? 'is-error' : ''}`} role={failed ? 'alert' : 'status'} title={notice} tabIndex={0}><span aria-hidden="true">{failed ? '⚠' : 'ⓘ'}</span><span class="workspace-browser-status-detail">{notice}</span></span> : null}
        {browserControls}
        <WorkspaceMenu label="Browser menu" icon={<span aria-hidden="true">⋮</span>}>
          <button type="button" role="menuitem" onClick={() => setCommentsOpen(true)}>Comments</button>
          <button type="button" role="menuitem" onClick={() => setCredentialsOpen(value => !value)}>Credentials</button>
          <button type="button" role="menuitemcheckbox" aria-checked={responsive} onClick={() => { const next = !responsive; setResponsive(next); if (current) command({ operation: 'resize', ...(next ? viewport : { width: 1280, height: 800 }) }); }}>Responsive viewport</button>
          <button type="button" role="menuitemcheckbox" aria-checked={inspectorOpen} onClick={() => setInspectorOpen(value => !value)}>Browser inspector</button>
          <button type="button" role="menuitem" onClick={() => zoomBy(-25)} disabled={zoom <= 25}>Zoom out −</button>
          <button type="button" role="menuitem" onClick={() => zoomBy(25)} disabled={zoom >= 300}>Zoom in +</button>
          <button type="button" role="menuitem" onClick={() => setZoom(100)}>Reset zoom ({zoom}%)</button>
        </WorkspaceMenu>

      </div>
      </form>
      {credentialsOpen ? <BrowserCredentials request={request} pageId={selected} revision={revision} url={current?.url} onFilled={() => void run({ operation: 'screenshot', pageId: selected }, true)} onClose={() => setCredentialsOpen(false)} /> : null}
      <ModalShell open={commentsOpen} title="Comments" closeLabel="Close comments" className="workspace-browser-comments-modal" onClose={() => setCommentsOpen(false)}><section class="workspace-browser-feedback-list" aria-label="Saved feedback">
            <div class="workspace-browser-pane-toolbar"><strong>Comments ({state.feedback.length})</strong><input aria-label="Search comments" placeholder="Filter comments" value={feedbackFilter} onInput={event => setFeedbackFilter(event.currentTarget.value)} /><button type="button" aria-label="Add all comments to instruction" title="Add all comments to instruction" disabled={busy || !props.connected || !state.feedback.length || !props.onInstruction} onClick={() => void addInstruction(state.feedback)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 19 9-19 9 4-9zM7 12h15" /></svg></button></div>
            {!state.feedback.length ? <p class="workspace-empty-inline">Mark a point or area on the page to add a comment.</p> : <table aria-label="Comments"><colgroup><col style={{ width:28 }} /><col style={{ width:30 }} /><col /><col style={{ width:110 }} /><col style={{ width:76 }} /></colgroup><thead><tr><th>#</th><th aria-label="Mark type" /><th>Comment</th><th>Page</th><th>Actions</th></tr></thead><tbody>
            {state.feedback.filter(item => `${item.text} ${item.url} ${item.selector ?? ''}`.toLowerCase().includes(feedbackFilter.toLowerCase())).map(f => <tr key={f.id} class={f.id === activeFeedback || f.id === editingMark?.id ? 'is-selected' : ''}>
              <td>{state.feedback.indexOf(f) + 1}</td><td title={f.kind}><BrowserMarkIcon tool={f.kind} /></td><td title={f.text || 'Visual mark'}>{f.text || 'Visual mark'}</td><td title={f.url}>{f.url.replace(/^https?:\/\//, '')}</td>
              <td><div class="workspace-browser-comment-actions"><button type="button" aria-label="Edit mark" title="Edit or reposition mark" disabled={busy || !!points.length || !feedback.some(item => item.id === f.id)} onClick={() => { setCommentsOpen(false); setEditingMark(f); setPoints(f.points.map(point => ({ ...point }))); setText(f.text); setReference(f.referenceUrl ?? ''); setMode(f.kind); setShowMarks(true); setCommentPosition(undefined); }}><ToolIcon kind="edit" /></button><button type="button" aria-label="Add to instruction" title="Add comment and screenshot to instruction" disabled={busy || !props.connected || !props.onInstruction} onClick={() => void addInstruction([f])}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 19 9-19 9 4-9zM7 12h15" /></svg></button><button type="button" aria-label="Delete comment" title="Delete comment" disabled={busy || !props.connected} onClick={() => command({ operation: 'deleteFeedback', feedbackId: f.id })}><ToolIcon kind="clear" /></button></div></td>
            </tr>)}
            </tbody></table>}
          </section>{notice ? <span role={failed ? 'alert' : 'status'}>{notice}</span> : null}</ModalShell>
      {!props.connected ? (
        <p role="status">Offline. Reconnect to control the browser. Unsaved feedback stays in this panel.</p>
      ) : null}
      {agentVisible && state.agentActivity ? <p class="workspace-browser-agent-activity" role="status"><span class="workspace-browser-agent-dot" aria-hidden="true" />AI · {agentLabel} · {state.agentActivity.status}</p> : null}
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
      <div class={`workspace-browser-stage${responsive ? ' is-responsive' : ''}`} data-zoomed={zoom !== 100} data-browser-revision={revision} style={{ '--browser-viewport-width': `${size.width}px`, '--browser-preview-ratio': String(size.width / size.height), '--browser-zoom': String(zoom / 100) }} onWheel={event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); zoomBy(event.deltaY > 0 ? -25 : 25); } }}>
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
              if (mode === 'interact' && !inspect && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); queuePageInput({ pageId:selected, operation:'press', key:'ControlOrMeta+A' }); return; }
              if (mode === 'interact' && !inspect && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key.length === 1 || ['Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))) {
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
            style={{ touchAction: "none", cursor: inspect ? browserToolCursor('interact') : mode !== 'interact' ? browserToolCursor(mode) : pageCursor }}
            onPaste={event => {
              if (mode !== 'interact' || inspect || !props.connected || !revision) return;
              const text = event.clipboardData?.getData('text/plain');
              if (text) { event.preventDefault(); queuePageInput({ pageId: selected, operation: 'type', text }); }
            }}
            onWheel={event => { if (!event.ctrlKey && !event.metaKey && mode === 'interact' && !inspect && !busy && props.connected && revision) { event.preventDefault(); command({ operation: 'scroll', x: event.deltaX, y: event.deltaY }); } }}
            onPointerDown={(event) => {
              if (busy || !props.connected || !revision) return;
              const point = coordinate(event);
              event.currentTarget.focus();
              if (inspect) { void pickElement(point); return; }
              if (points.length) { setFailed(true); setNotice('Save or cancel the current mark first.'); return; }
              setActiveFeedback('');
              if (mode === "interact") {
                pageDrag.current = point;
                event.currentTarget.setPointerCapture(event.pointerId);
                return;
              }
              drawing.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              setPoints([point]);
            }}
            onPointerMove={(event) => {
              if (markDrag.current) {
                const drag = markDrag.current, point = coordinate(event);
                if (drag.corner !== undefined) {
                  const xs = drag.points.map(point => point.x), ys = drag.points.map(point => point.y), opposite = { x: drag.corner % 2 ? Math.min(...xs) : Math.max(...xs), y: drag.corner > 1 ? Math.min(...ys) : Math.max(...ys) };
                  setPoints([opposite, point]);
                } else {
                  const dx = Math.max(-Math.min(...drag.points.map(point => point.x)), Math.min(size.width - Math.max(...drag.points.map(point => point.x)), point.x - drag.start.x));
                  const dy = Math.max(-Math.min(...drag.points.map(point => point.y)), Math.min(size.height - Math.max(...drag.points.map(point => point.y)), point.y - drag.start.y));
                  setPoints(drag.points.map(point => ({ x: point.x + dx, y: point.y + dy })));
                }
                return;
              }
              if (mode === 'interact' && !inspect && !busy && !pageDrag.current) {
                const point = coordinate(event);
                if (hoverTimer.current) clearTimeout(hoverTimer.current);
                hoverTimer.current = setTimeout(() => void readCursor(point), 60);
              }
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
            onPointerUp={event => {
              if (pageDrag.current) {
                const start = pageDrag.current, end = coordinate(event); pageDrag.current = undefined;
                command(Math.hypot(end.x - start.x, end.y - start.y) > 3 ? { operation:'drag', ...start, params:{ toX:end.x,toY:end.y } } : { operation:'click', ...start });
              }
              drawing.current = false;
              markDrag.current = undefined;
            }}
            onPointerCancel={() => {
              pageDrag.current = undefined;
              drawing.current = false;
              markDrag.current = undefined;
            }}
          >
            {showMarks ? feedback.filter(f => f.id !== editingMark?.id).map((f, index) => <g key={f.id} class="workspace-browser-saved-mark" role="button" tabindex={0} aria-label={`Comment ${index + 1}: ${f.text || 'Visual mark'}`} onPointerDown={event => dragMark(event, f)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (!points.length) { setEditingMark(f); setPoints(f.points); setText(f.text); setReference(f.referenceUrl ?? ''); setMode(f.kind); } } }}>
              {shape({ ...f, text: '' })}<circle cx={f.points[0]!.x} cy={f.points[0]!.y} r="15" fill="#6366f1" stroke="white" stroke-width="2" /><text x={f.points[0]!.x} y={f.points[0]!.y + 5} text-anchor="middle" fill="white" font-size="14">{index + 1}</text>
            </g>) : null}
            <g class="workspace-browser-draft-mark" onPointerDown={event => dragMark(event)}>{shape({ kind: mode === "interact" ? "pointer" : mode, points, text })}</g>
            {mode === 'area' && points.length > 1 ? [0, 1, 2, 3].map(corner => <rect class="workspace-browser-mark-handle" role="button" aria-label={`Resize rectangle corner ${corner + 1}`} x={(corner % 2 ? Math.max : Math.min)(...points.map(point => point.x)) - 5} y={(corner > 1 ? Math.max : Math.min)(...points.map(point => point.y)) - 5} width="10" height="10" fill="white" stroke="#2563eb" stroke-width="2" style={{ cursor: corner === 0 || corner === 3 ? 'nwse-resize' : 'nesw-resize' }} onPointerDown={event => dragMark(event, undefined, corner)} />) : null}
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
          </svg>
          {agentVisible && state.agentActivity ? <div class="workspace-browser-agent-pointer" role="img" aria-label={`AI pointer: ${agentPoint.action}`} data-label-left={agentPoint.x > size.width * .7} data-label-above={agentPoint.y > size.height * .85} style={{ left:`${agentPoint.x / size.width * 100}%`,top:`${agentPoint.y / size.height * 100}%` }}>
            <svg viewBox="-24 -24 72 72" aria-hidden="true" key={`${state.agentActivity.operation}:${state.agentActivity.updatedAt}`}>
              <circle class="workspace-browser-agent-ripple" r="12" fill="none" stroke="#0078d4" stroke-width="3" />
              <circle class="workspace-browser-agent-halo" r="18" fill="#0078d433" />
              <path d="M0 0V25L6.5 19.5 11 29 16 26.5 11.5 17H21Z" fill="#fff" stroke="#171717" stroke-width="1.5" stroke-linejoin="round" />
            </svg>
            <span>AI · {agentLabel}</span>
          </div> : null}
          {anchor && (points.length > 0 || visibleNote) ? <div class="workspace-browser-inline-comment" onPointerDown={event => { if ((event.target as HTMLElement).closest('button,textarea,input,p,code')) return; const box = event.currentTarget, parent = box.parentElement!.getBoundingClientRect(), rect = box.getBoundingClientRect(); commentDrag.current = { x: event.clientX, y: event.clientY, left: (rect.left - parent.left) / parent.width * 100, top: (rect.top - parent.top) / parent.height * 100 }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }} onPointerMove={event => { const drag = commentDrag.current; if (!drag) return; const box = event.currentTarget, parent = box.parentElement!.getBoundingClientRect(); setCommentPosition({ x: Math.max(0, Math.min((parent.width - box.offsetWidth) / parent.width * 100, drag.left + (event.clientX - drag.x) / parent.width * 100)), y: Math.max(0, Math.min((parent.height - box.offsetHeight) / parent.height * 100, drag.top + (event.clientY - drag.y) / parent.height * 100)) }); }} onPointerUp={() => { commentDrag.current = undefined; }} onPointerCancel={() => { commentDrag.current = undefined; }} role="dialog" aria-label={visibleNote ? 'Saved comment' : 'Comment on mark'} style={{ '--comment-left': `${commentPosition?.x ?? Math.min(65, Math.max(2, anchor.x / size.width * 100))}%`, '--comment-top': `${commentPosition?.y ?? Math.min(70, Math.max(2, anchor.y / size.height * 100))}%` }}>

            {visibleNote ? <><p>{visibleNote.text || 'Visual mark'}</p>{visibleNote.selector ? <code class="workspace-browser-feedback-selector">{visibleNote.selector}</code> : null}<button type="button" disabled={busy || !props.connected || !props.onInstruction} onClick={() => void addInstruction([visibleNote])}>Add to instruction</button></> : <>
              <textarea aria-label="Area instruction or design feedback" maxLength={8000} placeholder="Describe the change…" value={text} onInput={event => setText(event.currentTarget.value)} />
              <button class="workspace-browser-comment-send" type="button" aria-label="Save feedback" title="Save feedback" disabled={busy || !current || !props.connected} onClick={() => void addFeedback()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 19 9-19 9 4-9zM7 12h15" /></svg></button>
              {failed ? <span role="alert">{notice}</span> : null}
            </>}
          </div> : null}
        </div>
      ) : (
        <div class="workspace-browser-welcome" aria-label="New browser tab">
          <div class="workspace-browser-welcome-icon"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="8" width="38" height="32" rx="5" /><path d="M5 17h38M11 12.5h1m4 0h1m4 0h1M18 25l-5 4 5 4m12-8 5 4-5 4m-4-11-4 14" /></svg></div>
          <small>CODEX MANAGER BROWSER</small><h2>Your next idea starts here</h2><p>Enter a URL above and choose Go to open your website.</p>
          <button type="button" onClick={event => { const address = event.currentTarget.closest('.workspace-browser')?.querySelector<HTMLInputElement>('[aria-label="Browser URL"]'); address?.focus(); address?.select(); }}>Enter a URL <span aria-hidden="true">↗</span></button>
        </div>
      )}
      </div>
      </div>
      {inspectorOpen ? <BrowserResizeHandle label="Resize browser inspector" value={inspectorSize} onChange={setInspectorSize} axis={dock === 'bottom' ? 'y' : 'x'} reverse={dock !== 'left'} responsive /> : null}
      <aside style={{ '--inspector-size': `${inspectorSize}%` }} data-inspector-theme={theme} class={`workspace-browser-inspector ${inspectorOpen ? "is-open" : ""}`} aria-label="Browser inspector" aria-hidden={!inspectorOpen}>
        <header class="workspace-browser-inspector-header">
          <nav class="workspace-browser-inspector-tabs" role="tablist" aria-label="Browser inspector panels">
            {(["elements", "console", "sources", "network", "application", "performance", "memory"] as const).map((tab) => <button type="button" role="tab" aria-selected={inspectorTab === tab} class={inspectorTab === tab ? "is-active" : ""} onClick={() => setInspectorTab(tab)}>{tab.charAt(0).toUpperCase() + tab.slice(1)}</button>)}
          </nav>
          <div class="workspace-browser-inspector-actions">
            <button class="workspace-browser-icon-button" type="button" aria-label="Inspector settings" title="Inspector settings" aria-pressed={settings} onClick={() => setSettings(value => !value)}><span aria-hidden="true">⚙</span></button>
            <button class="workspace-browser-icon-button" type="button" aria-label="Toggle console drawer" title="Toggle console drawer" aria-pressed={consoleDrawer} onClick={() => setConsoleDrawer(value => !value)}><ToolIcon kind="terminal" /></button>
            <WorkspaceMenu label="Inspector position" icon={<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>}>
              {(['left', 'right', 'bottom'] as const).map(position => <button type="button" role="menuitemradio" aria-checked={dock === position} onClick={() => setDock(position)}>Dock {position}</button>)}
              <button type="button" role="menuitem" onClick={() => { setDock('right'); setInspectorSize(45); }}>Reset position</button>
            </WorkspaceMenu>
            <button class="workspace-browser-icon-button" type="button" aria-label="Close browser inspector" title="Close browser inspector" onClick={() => setInspectorOpen(false)}><ToolIcon kind="close" /></button>
          </div>
        </header>

        <div class={`workspace-browser-inspector-layout drawer-${drawerSide}`}>
        <div class="workspace-browser-inspector-body">
          {settings ? <section class="workspace-browser-settings" aria-label="Inspector settings"><header><strong>Settings</strong><button type="button" onClick={() => setSettings(false)}>Close settings</button></header><label>Theme <select aria-label="Inspector theme" value={theme} onChange={event => setTheme(event.currentTarget.value)}><option value="auto">Auto</option><option value="dark">Dark</option><option value="light">Light</option></select></label><label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.currentTarget.checked)} />Word wrap sources</label><label>Console drawer <select aria-label="Console drawer position" value={drawerSide} onChange={event => setDrawerSide(event.currentTarget.value as typeof drawerSide)}><option value="bottom">Bottom</option><option value="right">Right</option></select></label></section> : inspectorOpen ? <BrowserInspectorContent key={selected} consoleState={consoleStates[selected] ?? emptyBrowserConsole()} onConsoleState={updateConsole} panel={inspectorTab} pageId={selected} revision={revision} connected={props.connected} request={request} busy={busy} selector={elementSelector} wrap={wrap} outcome={consoleOutcome?.pageId === selected ? consoleOutcome : undefined} onClearConsole={() => setConsoleOutcome(undefined)} onEvaluate={text => { setConsoleOutcome(undefined); command({ operation: 'evaluate', confirmed: true, text }); }} onCommand={command} onInspectionApplied={next => setState(previous => next.pageId === previous.pageId ? { ...next, image: next.image ?? previous.image } : previous)} /> : null}
        </div>
        {inspectorOpen && consoleDrawer && inspectorTab !== 'console' ? <><BrowserResizeHandle label="Resize Console drawer" value={drawerSize} onChange={setDrawerSize} axis={drawerSide === 'bottom' ? 'y' : 'x'} reverse /><section class="workspace-browser-console-drawer" aria-label="Console drawer" style={{ flexBasis: `${drawerSize}%` }}><header><strong>Console</strong><button type="button" onClick={() => setDrawerSide(value => value === 'bottom' ? 'right' : 'bottom')}>Dock {drawerSide === 'bottom' ? 'right' : 'bottom'}</button><button type="button" aria-label="Close Console drawer" onClick={() => setConsoleDrawer(false)}>?</button></header><BrowserInspectorContent key={selected} consoleState={consoleStates[selected] ?? emptyBrowserConsole()} onConsoleState={updateConsole} panel="console" pageId={selected} revision={revision} connected={props.connected} request={request} busy={busy} outcome={consoleOutcome?.pageId === selected ? consoleOutcome : undefined} onClearConsole={() => setConsoleOutcome(undefined)} onEvaluate={text => { setConsoleOutcome(undefined); command({ operation: 'evaluate', confirmed: true, text }); }} onCommand={command} onInspectionApplied={next => setState(previous => next.pageId === previous.pageId ? { ...next, image: next.image ?? previous.image } : previous)} /></section></> : null}
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

function browserToolCursor(tool: string): string {
  const shape = tool === 'interact' ? '<path d="M2 1v21l6-5 4 9 4-2-4-8h9z" fill="white" stroke="black"/>' : tool === 'pointer' ? '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/>' : tool === 'area' ? '<rect x="3" y="4" width="18" height="15"/>' : '<path d="m4 18-1 5 5-1L23 7l-4-4zM16 6l4 4"/>';
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="30" fill="white" stroke="#0078d4" stroke-width="2">${shape}</svg>`)}") ${tool === 'interact' ? '2 1' : '12 12'}, default`;
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
