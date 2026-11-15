import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { useWorkspaceRequest } from "./workspaceRequest";
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
  connected: boolean;
  active?: boolean;
  onFeedback: (notice: DashboardNotice) => void;
  onInstruction?: (text: string, image?: string) => void;
}) {
  const request = useWorkspaceRequest(props.projectPath, props.targetDeviceId, props.connected);
  const [state, setState] = useState<WorkspaceBrowserState>({ pages: [], feedback: [] });
  const [selected, setSelected] = useState(""),
    [url, setUrl] = useState("http://localhost:3000");
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<"interact" | BrowserFeedback["kind"]>("interact");
  const [points, setPoints] = useState<BrowserPoint[]>([]),
    [text, setText] = useState(""),
    [reference, setReference] = useState("");
  const [input, setInput] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [size, setSize] = useState({ width: 1280, height: 800 });
  const [cursor, setCursor] = useState<BrowserPoint>({ x: 20, y: 20 });
  const locked = useRef(false),
    generation = useRef(0),
    drawing = useRef(false);
  const savedId = useRef<string>();
  const reading = useRef(false), operationGeneration = useRef(0), draftPoints = useRef(points);
  draftPoints.current = points;
  const revision = state.revision;
  const current = state.pages.find((page) => page.id === selected);
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
      if (next.pageId) setSelected(next.pageId);
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
    <section class={`workspace-browser ${expanded ? "is-expanded" : ""}`} aria-label="Development browser">
      <header class="workspace-browser-toolbar">
        <strong>Development browser</strong>
        <span style={{ flex: "1" }} />
        <button aria-pressed={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Collapse" : "Expand"} browser
        </button>
      </header>
      <form
        class="workspace-browser-address"
        onSubmit={(event) => {
          event.preventDefault();
          command({ operation: current ? "navigate" : "open", url });
        }}
      >
        <input
          aria-label="Browser URL"
          type="url"
          required
          value={url}
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
        <button disabled={busy || !props.connected} type="submit">
          Go
        </button>
        <button disabled={busy || !props.connected} type="button" onClick={() => command({ operation: "open", url })}>
          New
        </button>
      </form>
      <div class="workspace-browser-toolbar">
        <select
          aria-label="Open browser pages"
          value={selected}
          disabled={busy || points.length > 0}
          onChange={(event) => {
            setSelected(event.currentTarget.value);
            setPoints([]);
            void run({ operation: "screenshot", pageId: event.currentTarget.value });
          }}
        >
          <option value="">Open pages ({state.pages.length})</option>
          {state.pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.title || page.url}
            </option>
          ))}
        </select>
        <button
          disabled={busy || !props.connected}
          onClick={() => void run({ operation: selected ? "screenshot" : "list", pageId: selected || undefined })}
          title="Refresh preview and page list"
        >
          Refresh
        </button>
        <button disabled={busy || !current || !props.connected} onClick={() => command({ operation: "close" })}>
          Close page
        </button>
      </div>
      <div class="workspace-browser-toolbar">
        <button
          aria-label="Go back"
          disabled={busy || !current || !props.connected}
          onClick={() => command({ operation: "back" })}
        >
          ←
        </button>
        <button
          aria-label="Go forward"
          disabled={busy || !current || !props.connected}
          onClick={() => command({ operation: "forward" })}
        >
          →
        </button>
        <button disabled={busy || !current || !props.connected} onClick={() => command({ operation: "reload" })}>
          Reload
        </button>
        <button
          disabled={busy || !current || !props.connected}
          onClick={() => {
            const width = size.width === 1280 ? 390 : 1280;
            command({ operation: "resize", width, height: 800 });
          }}
        >
          Desktop / Mobile
        </button>
      </div>
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
      <div class="workspace-browser-toolbar">
        <input
          aria-label="Type into focused browser field"
          value={input}
          onInput={(e) => setInput(e.currentTarget.value)}
        />
        <button
          disabled={busy || !current || !props.connected}
          onClick={() => command({ operation: "type", text: input })}
        >
          Type
        </button>
        <button
          disabled={busy || !current || !props.connected}
          onClick={() => command({ operation: "press", key: "Enter" })}
        >
          Enter
        </button>
        <button
          disabled={busy || !current || !props.connected}
          onClick={() => command({ operation: "scroll", y: 500 })}
        >
          Scroll ↓
        </button>
        <button
          disabled={busy || !current || !props.connected}
          aria-label="Scroll up"
          onClick={() => command({ operation: "scroll", y: -500 })}
        >
          ↑
        </button>
      </div>
      {mode !== "interact" ? (
        <div class="workspace-browser-feedback">
          <textarea
            aria-label="Area instruction or design feedback"
            placeholder="Select an area, then describe the change…"
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
          />
          <input
            type="url"
            aria-label="Design or inspiration reference URL"
            placeholder="Design / inspiration URL (optional)"
            value={reference}
            onInput={(e) => setReference(e.currentTarget.value)}
          />
          <button disabled={busy || !points.length || !current || !props.connected} onClick={() => void addFeedback()}>
            Save feedback
          </button>
          <button
            onClick={() => {
              setPoints([]);
              setText("");
            }}
          >
            Cancel mark
          </button>
        </div>
      ) : null}
      <details>
        <summary>Saved feedback ({state.feedback.length})</summary>
        {state.feedback.map((f) => (
          <article key={f.id}>
            <small>
              {f.kind} · {f.url}
            </small>
            <p>
              {f.text || "Visual mark"}{" "}
              {f.referenceUrl ? (
                <a href={f.referenceUrl} target="_blank" rel="noreferrer">
                  Reference ↗
                </a>
              ) : null}
            </p>
            <button disabled={busy || !props.connected} onClick={() => void addInstruction(f)}>
              Add to instruction
            </button>
            <button
              disabled={busy || !props.connected}
              onClick={() => command({ operation: "deleteFeedback", feedbackId: f.id })}
            >
              Delete
            </button>
          </article>
        ))}
      </details>
      <details>
        <summary>Console and network ({state.logs?.length ?? 0})</summary>
        <pre>{state.logs?.join("\n") || "No events captured."}</pre>
      </details>
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
