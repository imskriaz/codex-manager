import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { useWorkspaceRequest } from "./workspaceRequest";
import { WorkspaceMenu } from "./workspaceMenu";
import { ToolIcon } from "./icons";
import type { DashboardNotice } from "../../src/domain/dashboard/types";
import type {
  BrowserFeedback,
  BrowserPoint,
  WorkspaceBrowserRequest,
  WorkspaceBrowserState
} from "../../src/domain/workspaceBrowser";

export default function WorkspaceBrowser(props: {
  projectPath?: string;
  targetDeviceId?: string;
  initialUrl?: string;
  downloadUrl?: string;
  actionNonce?: number;
  initialPageId?: string;
  closePageId?: string;
  onPagesChange?: (pages: WorkspaceBrowserState["pages"]) => void;
  onPageSelected?: (pageId: string) => void;
  connected: boolean;
  active?: boolean;
  onFeedback: (notice: DashboardNotice) => void;
  onInstruction?: (text: string, image?: string) => void;
}) {
  const request = useWorkspaceRequest(props.projectPath, props.targetDeviceId, props.connected);
  const [state, setState] = useState<WorkspaceBrowserState>({ pages: [], feedback: [] });
  const [selected, setSelected] = useState(props.initialPageId ?? ""),
    [url, setUrl] = useState(props.initialUrl ?? "http://localhost:3000");
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<"interact" | BrowserFeedback["kind"]>("interact");
  const [points, setPoints] = useState<BrowserPoint[]>([]),
    [text, setText] = useState(""),
    [reference, setReference] = useState("");
  const [input, setInput] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"elements" | "console" | "sources" | "network">("elements");
  const [preferences, setPreferences] = useState({ openLinks: true, autoOpenFiles: true, autoVerify: true, keepCookies: true });
  const [size, setSize] = useState({ width: 1280, height: 800 });
  const [cursor, setCursor] = useState<BrowserPoint>({ x: 20, y: 20 });
  const locked = useRef(false),
    generation = useRef(0),
    drawing = useRef(false);
  const savedId = useRef<string>();
  const openedRequest = useRef<number>();
  const downloadedRequest = useRef<number>();
  const openingForDownload = useRef(false);
  const reading = useRef(false), operationGeneration = useRef(0), draftPoints = useRef(points);
  draftPoints.current = points;
  const revision = state.revision;
  const current = state.pages.find((page) => page.id === selected);
  const noticeAction = (message: string): void => { setNotice(message); setFailed(false); };
  const togglePreference = (key: keyof typeof preferences): void => {
    setPreferences((previous) => {
      const next = { ...previous, [key]: !previous[key] };
      try { localStorage.setItem(`codexManager.browser.${key}`, String(next[key])); } catch { /* optional browser preference */ }
      return next;
    });
  };
  const copyUrl = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(current?.url ?? url); noticeAction("URL copied."); }
    catch { setFailed(true); setNotice("Clipboard access was unavailable. Select the URL and copy it manually."); }
  };
  const saveScreenshot = (): void => {
    if (!state.image) return;
    const link = document.createElement("a"); link.href = state.image; link.download = "codex-browser-screenshot.jpg"; link.click(); noticeAction("Screenshot saved.");
  };
  const saveHtml = async (): Promise<void> => {
    if (!selected) return;
    try {
      const response = await request("workspaceBrowser", { browserRequest: { operation: "html", pageId: selected } });
      const html = response.workspaceBrowser?.value;
      if (typeof html !== "string") throw new Error("HTML was not returned.");
      const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([html], { type: "text/html" })); link.download = "codex-browser-page.html"; link.click(); URL.revokeObjectURL(link.href); noticeAction("HTML saved.");
    } catch (error) { setFailed(true); setNotice(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => {
    if (current?.url) setUrl(current.url);
  }, [current?.url]);
  const run = async (value: WorkspaceBrowserRequest, quiet = false): Promise<void> => {
    if (quiet && reading.current) return;
    if (!quiet && locked.current) {
      if (!quiet) {
        setFailed(true);
        setNotice("A browser operation is pending. Check its result before retrying.");
      }
      return;
    }
    if (quiet) reading.current = true;
    else { locked.current = true; setBusy(true); operationGeneration.current++; }
    const version = generation.current;
    const operationVersion = operationGeneration.current;
    try {
      const response = await request("workspaceBrowser", {
        browserRequest: { operationId: crypto.randomUUID(), ...value }
      });
      if (version !== generation.current) return;
      if (quiet && (operationVersion !== operationGeneration.current || drawing.current || draftPoints.current.length)) return;
      if (!response.workspaceBrowser) throw new Error("Browser outcome was not returned. Refresh before retrying.");
      setState((previous) => ({
        ...response.workspaceBrowser!,
        image:
          response.workspaceBrowser!.image ??
          (response.workspaceBrowser!.pageId === previous.pageId ? previous.image : undefined)
      }));
      const next = response.workspaceBrowser;
      props.onPagesChange?.(next.pages);
      if (next.fileDownload) {
        const link = document.createElement("a");
        link.href = `data:${next.fileDownload.mimeType};base64,${next.fileDownload.data}`;
        link.download = next.fileDownload.filename;
        link.click();
        noticeAction(`${next.fileDownload.filename} downloaded.`);
      }
      if (next.pageId) { setSelected(next.pageId); props.onPageSelected?.(next.pageId); }
      else
        setSelected((previous) =>
          next.pages.some((page) => page.id === previous) ? previous : (next.pages[0]?.id ?? "")
        );
      if (!quiet) {
        setFailed(false);
        setNotice("Browser action completed.");
      }
    } catch (error) {
      if (version !== generation.current) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!quiet) { setNotice(message); setFailed(true); props.onFeedback({ level: "error", message }); }
    } finally {
      if (quiet) reading.current = false;
      else if (version === generation.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (props.initialPageId !== undefined && props.initialPageId !== selected) {
      setSelected(props.initialPageId);
      setPoints([]);
      if (props.initialPageId) void run({ operation: "screenshot", pageId: props.initialPageId });
    }
  }, [props.initialPageId]);
  useEffect(() => {
    if (props.closePageId) {
      setSelected(props.closePageId);
      void command({ operation: "close", pageId: props.closePageId });
    }
  }, [props.closePageId]);
  useEffect(() => {
    const target = props.initialUrl?.trim();
    const nonce = props.actionNonce ?? 0;
    if (!target || nonce === openedRequest.current || !props.connected) return;
    openedRequest.current = nonce;
    setUrl(target);
    void run({ operation: selected ? "navigate" : "open", pageId: selected || undefined, revision: selected ? revision : undefined, url: target });
  }, [props.initialUrl, props.actionNonce, props.connected, selected, revision]);
  useEffect(() => {
    const target = props.downloadUrl?.trim();
    const nonce = props.actionNonce ?? 0;
    if (!target || nonce === downloadedRequest.current || !props.connected) return;
    if (!selected) {
      if (openingForDownload.current) return;
      openingForDownload.current = true;
      void run({ operation: "open", url: "http://localhost:3000" }).finally(() => { openingForDownload.current = false; });
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
    if (!props.connected || props.active === false) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !drawing.current && !points.length)
        void run({ operation: selected ? "screenshot" : "list", pageId: selected || undefined }, true);
    }, 2500);
    return () => clearInterval(timer);
  }, [selected, props.connected, props.active, request, points.length]);
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
  const addInstruction = async (feedback: BrowserFeedback): Promise<void> => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    const version = generation.current;
    try {
      const response = await request("workspaceBrowser", {
        browserRequest: { operation: "readFeedback", feedbackId: feedback.id }
      });
      const image = response.workspaceBrowser?.feedbackImage;
      const annotated = image ? await annotateScreenshot(image, feedback) : undefined;
      if (version !== generation.current) return;
      props.onInstruction?.(
        `Browser feedback: ${feedback.url}\n${feedback.kind} at ${JSON.stringify(feedback.points)}\n${feedback.text}${feedback.referenceUrl ? `\nDesign reference: ${feedback.referenceUrl}` : ""}\nFeedback ID: ${feedback.id}`,
        annotated
      );
      setFailed(false);
      setNotice("Feedback and its marked screenshot added to the composer. Review and send when ready.");
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
  return (
    <section class="workspace-browser" aria-label="Development browser">
      <header class="workspace-browser-header workspace-browser-tabs">
        <button class="workspace-browser-icon-button" type="button" aria-label="Toggle responsive viewport" title="Toggle responsive viewport" disabled={busy || !current || !props.connected} onClick={() => command({ operation: "resize", width: size.width === 1280 ? 390 : 1280, height: 800 })}><ToolIcon kind="split" /></button>
        <button class="workspace-browser-icon-button" type="button" aria-label={inspectorOpen ? "Close browser inspector" : "Open browser inspector"} title={inspectorOpen ? "Close browser inspector" : "Open browser inspector"} aria-pressed={inspectorOpen} onClick={() => setInspectorOpen((value) => !value)}><ToolIcon kind="comment" /></button>
        <WorkspaceMenu label="Browser actions" icon={<ToolIcon kind="more" />}>
          <button type="button" disabled={!current} onClick={() => current && window.open(current.url, "_blank", "noopener,noreferrer")}><ToolIcon kind="external" />Open in Google Chrome</button>
          <button type="button" disabled={!current} onClick={() => void copyUrl()}><ToolIcon kind="copy" />Copy URL</button>
          <button type="button" disabled={!state.image} onClick={saveScreenshot}><ToolIcon kind="download" />Save screenshot</button>
          <button type="button" disabled={!current} onClick={() => void saveHtml()}><ToolIcon kind="download" />Open HTML file…</button>
          <div class="workspace-browser-menu-divider" />
          <button type="button" disabled={!current || busy || !props.connected} onClick={() => command({ operation: "resize", width: size.width === 1280 ? 390 : 1280, height: 800 })}><ToolIcon kind="split" />Viewport <span class="workspace-browser-menu-value">{size.width === 1280 ? "Responsive" : "Mobile"}</span></button>
          <button type="button" onClick={() => togglePreference("openLinks")}><ToolIcon kind="external" />Open links in built-in browser <span class="workspace-browser-menu-check">{preferences.openLinks ? "✓" : ""}</span></button>
          <button type="button" onClick={() => togglePreference("autoOpenFiles")}><ToolIcon kind="edit" />Auto-open files Codex writes <span class="workspace-browser-menu-check">{preferences.autoOpenFiles ? "✓" : ""}</span></button>
          <button type="button" onClick={() => togglePreference("autoVerify")}><ToolIcon kind="check" />Auto-verify changes <span class="workspace-browser-menu-check">{preferences.autoVerify ? "✓" : ""}</span></button>
          <button type="button" onClick={() => noticeAction("Allowed sites are controlled by the current project and Manager permissions.")}><ToolIcon kind="eye" />Manage allowed sites…</button>
          <button type="button" onClick={() => noticeAction("Local network access is limited to the current project browser context.")}><ToolIcon kind="branch" />Local network access <span class="workspace-browser-menu-value">Allowed</span></button>
          <button type="button" disabled={!current || busy || !props.connected} onClick={() => command({ operation: "storage" })}><ToolIcon kind="eye" />Cookies</button>
          <button type="button" onClick={() => togglePreference("keepCookies")}><ToolIcon kind="check" />Keep cookies <span class="workspace-browser-menu-value">{preferences.keepCookies ? "Until quit" : "Session"}</span></button>
          <button type="button" disabled={!current || busy || !props.connected} onClick={() => command({ operation: "storage", confirmed: true, params: { action: "clearCookies" } })}><ToolIcon kind="clear" />Clear browsing data</button>
          <div class="workspace-browser-menu-divider" />
          <button type="button" disabled={busy || !props.connected} onClick={() => void run({ operation: selected ? "screenshot" : "list", pageId: selected || undefined })}><ToolIcon kind="refresh" />Refresh preview</button>
          <button type="button" disabled={busy || !current || !props.connected} onClick={() => command({ operation: "close" })}><ToolIcon kind="close" />Close page</button>
          <button type="button" disabled={busy || !current || !props.connected} onClick={() => command({ operation: "reload" })}><ToolIcon kind="refresh" />Reload page</button>
          <button type="button" disabled={busy || !current || !props.connected} onClick={() => command({ operation: "resize", width: size.width === 1280 ? 390 : 1280, height: 800 })}><ToolIcon kind="split" />{size.width === 1280 ? "Use mobile viewport" : "Use desktop viewport"}</button>
        </WorkspaceMenu>
      </header>
      <form class="workspace-browser-address" onSubmit={(event) => { event.preventDefault(); command({ operation: current ? "navigate" : "open", url }); }}>
        <button class="workspace-browser-icon-button" aria-label="Go back" title="Go back" disabled={busy || !current || !props.connected} type="button" onClick={() => command({ operation: "back" })}><ToolIcon kind="left" /></button>
        <button class="workspace-browser-icon-button" aria-label="Go forward" title="Go forward" disabled={busy || !current || !props.connected} type="button" onClick={() => command({ operation: "forward" })}><ToolIcon kind="right" /></button>
        <button class="workspace-browser-icon-button" aria-label="Reload page" title="Reload page" disabled={busy || !current || !props.connected} type="button" onClick={() => command({ operation: "reload" })}><ToolIcon kind="refresh" /></button>
        <input aria-label="Browser URL" type="text" inputMode="url" required value={url} onInput={(e) => setUrl(e.currentTarget.value)} />
      </form>
      {notice ? (
        <p role={failed ? "alert" : "status"} class={failed ? "is-error" : ""}>
          {notice}
        </p>
      ) : null}
      {!props.connected ? (
        <p role="status">Offline. Reconnect to control the browser. Unsaved feedback stays in this panel.</p>
      ) : null}
      {state.image && current ? (
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
            aria-label="Browser preview. Arrow keys move the pointer, Enter clicks or marks, Shift and arrow keys extend an area or drawing."
            role="application"
            tabindex={0}
            onKeyDown={(event) => {
              if (busy || !props.connected || !revision) return;
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
                if (mode === "interact") command({ operation: "click", ...cursor });
                else setPoints((previous) => (mode === "area" && previous.length ? [previous[0]!, cursor] : [cursor]));
              }
            }}
            style={{ touchAction: "none" }}
            onPointerDown={(event) => {
              if (busy || !props.connected || !revision) return;
              const point = coordinate(event);
              if (mode === "interact") {
                command({ operation: "click", ...point });
                return;
              }
              drawing.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              setPoints([point]);
            }}
            onPointerMove={(event) => {
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
            {feedback.map((f) => (
              <g key={f.id}>{shape(f)}</g>
            ))}
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
          </svg>
          <div class="workspace-browser-mark-tools" role="toolbar" aria-label="Feedback tools">
            {(["interact", "pointer", "area", "draw", "comment"] as const).map((tool) => (
              <button
                aria-label={tool}
                aria-pressed={mode === tool}
                disabled={busy || !props.connected || !revision}
                title={tool === "interact" ? "Control page" : tool === "draw" ? "Freehand pen" : tool}
                onClick={() => {
                  setMode(tool);
                  setPoints([]);
                  setInspectorOpen(true);
                }}
              >
                {tool === "interact"
                  ? "↖"
                  : tool === "pointer"
                    ? "◉"
                    : tool === "area"
                      ? "□"
                      : tool === "draw"
                        ? "✎"
                        : "T"}
                <span class="sr-only">{tool}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p class="workspace-browser-empty">Open your development URL. AI and manual pages appear here together.</p>
      )}
      <aside class={`workspace-browser-inspector ${inspectorOpen ? "is-open" : ""}`} aria-label="Browser inspector" aria-hidden={!inspectorOpen}>
        <header class="workspace-browser-inspector-header">
          <span><strong>Inspector</strong></span>
          <button class="workspace-browser-icon-button" type="button" aria-label="Close browser inspector" title="Close browser inspector" onClick={() => setInspectorOpen(false)}><ToolIcon kind="close" /></button>
        </header>
        <nav class="workspace-browser-inspector-tabs" role="tablist" aria-label="Browser inspector panels">
          {(["elements", "console", "sources", "network"] as const).map((tab) => <button type="button" role="tab" aria-selected={inspectorTab === tab} class={inspectorTab === tab ? "is-active" : ""} onClick={() => setInspectorTab(tab)}>{tab.charAt(0).toUpperCase() + tab.slice(1)}</button>)}
        </nav>
        <div class="workspace-browser-inspector-body">
          <div class="workspace-browser-toolbar workspace-browser-interaction">
            <input aria-label="Type into focused browser field" value={input} onInput={(e) => setInput(e.currentTarget.value)} />
            <button class="workspace-browser-icon-button" aria-label="Type into focused browser field" title="Type into focused browser field" disabled={busy || !current || !props.connected} onClick={() => command({ operation: "type", text: input })}><ToolIcon kind="edit" /></button>
            <button class="workspace-browser-icon-button" aria-label="Press Enter" title="Press Enter" disabled={busy || !current || !props.connected} onClick={() => command({ operation: "press", key: "Enter" })}><ToolIcon kind="play" /></button>
            <button class="workspace-browser-icon-button" aria-label="Scroll down" title="Scroll down" disabled={busy || !current || !props.connected} onClick={() => command({ operation: "scroll", y: 500 })}><ToolIcon kind="down" /></button>
            <button class="workspace-browser-icon-button" disabled={busy || !current || !props.connected} aria-label="Scroll up" title="Scroll up" onClick={() => command({ operation: "scroll", y: -500 })}><ToolIcon kind="up" /></button>
          </div>
          {mode !== "interact" ? (
            <div class="workspace-browser-feedback">
              <textarea aria-label="Area instruction or design feedback" placeholder="Select an area, then describe the change…" value={text} onInput={(e) => setText(e.currentTarget.value)} />
              <input type="url" aria-label="Design or inspiration reference URL" placeholder="Design / inspiration URL (optional)" value={reference} onInput={(e) => setReference(e.currentTarget.value)} />
              <div class="workspace-browser-feedback-actions">
                <button disabled={busy || !points.length || !current || !props.connected} onClick={() => void addFeedback()}>Save feedback</button>
                <button onClick={() => { setPoints([]); setText(""); }}>Cancel mark</button>
              </div>
            </div>
          ) : null}
          <details hidden={inspectorTab !== "elements"}>
            <summary>Saved feedback ({state.feedback.length})</summary>
            {state.feedback.map((f) => (
              <article key={f.id}><small>{f.kind} · {f.url}</small><p>{f.text || "Visual mark"}{" "}{f.referenceUrl ? <a href={f.referenceUrl} target="_blank" rel="noreferrer">Reference ↗</a> : null}</p><button disabled={busy || !props.connected} onClick={() => void addInstruction(f)}>Add to instruction</button><button disabled={busy || !props.connected} onClick={() => command({ operation: "deleteFeedback", feedbackId: f.id })}>Delete</button></article>
            ))}
          </details>
          <details open={inspectorTab === "console" || inspectorTab === "network"} hidden={inspectorTab === "elements" || inspectorTab === "sources"}><summary>{inspectorTab === "network" ? "Network activity" : "Page activity"} ({state.logs?.length ?? 0})</summary><div class="workspace-browser-log-list">{state.logs?.length ? state.logs.map((log) => <div><i aria-hidden="true" /> <span>{log}</span></div>) : <p>No captured activity.</p>}</div></details>
          {inspectorTab === "sources" ? <div class="workspace-browser-inspector-empty"><ToolIcon kind="eye" /><strong>Rendered page view</strong><span>Select a mark or use the pointer to inspect what is visible.</span></div> : null}
        </div>
      </aside>
    </section>
  );
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
