import { ToolIcon } from "./icons";
import { WorkspaceMenu } from "./workspaceMenu";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import terminalCss from "@xterm/xterm/css/xterm.css?inline";
import type {
  DashboardHostMessage,
  DashboardWorkspaceTerminalInfo,
  DashboardWorkspaceTerminalOutput,
  WorkspaceTerminalSnapshot
} from "../../src/domain/dashboard/types";
import { useWorkspaceRequest } from "./workspaceRequest";
import { isRawWorkspaceTerminalOutput } from "../../src/domain/workspaceTerminalActivity";
import { createActionRequestId, postMessageToHost } from "./host";
import { WorkspaceDialog as ModalShell } from "./workspaceDialog";

let clientId = "";

export default function WorkspaceTerminal(props: {
  projectPath?: string;
  targetDeviceId?: string;
  connected: boolean;
  terminals: DashboardWorkspaceTerminalInfo[];
  onList: () => void;
  onFocus: (id: string) => void;
}) {
  if (!clientId) {
    clientId = crypto.randomUUID();
  }
  const request = useWorkspaceRequest(props.projectPath, props.targetDeviceId, props.connected);
  const [terminals, setTerminals] = useState(props.terminals);
  const [selected, setSelected] = useState<string>();
  const [split, setSplit] = useState<string>();
  const [profile, setProfile] = useState<"default" | "powershell" | "cmd" | "bash">("default");
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [uncertain, setUncertain] = useState(false);
  const [closeId, setCloseId] = useState<string>();
  const [renameId, setRenameId] = useState<string>(),
    [name, setName] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    if (!["Terminal ready.", "Terminal list refreshed.", "Terminal renamed.", "Terminal closed."].includes(notice)) {
      return;
    }
    const timer = setTimeout(() => setNotice((current) => (current === notice ? "" : current)), 2000);
    return () => clearTimeout(timer);
  }, [notice]);
  const eligible = terminals.filter((item) => !item.shared || samePath(item.cwd, props.projectPath));
  const current =
    eligible.find((item) => item.id === selected) ??
    eligible.find((item) => item.shared) ??
    eligible.find((item) => item.isActive) ??
    eligible[0];
  const second = eligible.find((item) => item.id === split && item.id !== current?.id);
  useEffect(() => {
    setTerminals(props.terminals);
  }, [props.terminals]);
  useEffect(() => {
    let active = true;
    if (props.connected) {
      void request("listWorkspaceTerminals")
        .then((result) => {
          if (active && result.workspaceTerminals) {
            setTerminals(result.workspaceTerminals);
          }
        })
        .catch((error) => {
          if (active) {
            setNotice(error instanceof Error ? error.message : String(error));
          }
        });
    }
    return () => {
      active = false;
      generation.current++;
    };
  }, [request]);
  const refresh = async () => {
    const token = generation.current;
    setBusy(true);
    setNotice("");
    try {
      const result = await request("listWorkspaceTerminals");
      if (token !== generation.current) {
        return;
      }
      setTerminals(result.workspaceTerminals ?? []);
      setUncertain(false);
      props.onList();
      setNotice("Terminal list refreshed.");
    } catch (error) {
      if (token === generation.current) {
        setNotice((error as Error).message);
      }
    } finally {
      if (token === generation.current) {
        setBusy(false);
      }
    }
  };
  const create = async (asSplit = false) => {
    const token = generation.current;
    setBusy(true);
    setNotice("Starting shell…");
    try {
      const result = await request("workspaceTerminal", {
        terminalProfile: profile,
        terminalRequest: { operation: "create", clientId, operationId: crypto.randomUUID() }
      });
      if (token !== generation.current) {
        return;
      }
      setTerminals(result.workspaceTerminals ?? []);
      if (asSplit && current?.shared) {
        setSplit(result.workspaceTerminal?.id);
      } else {
        setSelected(result.workspaceTerminal?.id);
      }
      props.onList();
      setNotice("Terminal ready.");
    } catch (error) {
      if (token === generation.current) {
        setNotice((error as Error).message);
        setUncertain(true);
      }
    } finally {
      if (token === generation.current) {
        setBusy(false);
      }
    }
  };
  const change = async (operation: "close" | "rename", id: string) => {
    const token = generation.current;
    setBusy(true);
    try {
      const state = await request("workspaceTerminal", {
        terminalId: id,
        terminalRequest: { operation: "read", clientId }
      });
      await request("workspaceTerminal", {
        terminalId: id,
        terminalName: name,
        terminalRequest: { operation, clientId, epoch: state.terminalSnapshot?.epoch }
      });
      if (token !== generation.current) {
        return;
      }
      setCloseId(undefined);
      setRenameId(undefined);
      await refresh();
      setNotice(operation === "close" ? "Terminal closed." : "Terminal renamed.");
    } catch (error) {
      if (token === generation.current) {
        setNotice((error as Error).message);
      }
    } finally {
      if (token === generation.current) {
        setBusy(false);
      }
    }
  };
  return (
    <section class="workspace-terminal" aria-label="Interactive terminal">
      <header class="workspace-tool-toolbar">
        <select
          aria-label="Select terminal"
          value={current?.id ?? ""}
          disabled={busy}
          onChange={(event) => setSelected(event.currentTarget.value)}
        >
          <option value="" disabled>
            Select terminal
          </option>
          {eligible.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {!item.shared ? " · native" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          title="New terminal"
          aria-label="New terminal"
          disabled={busy || !props.connected || uncertain}
          onClick={() => void create()}
        >
          <ToolIcon kind="plus" />
        </button>
        <button
          type="button"
          title="Split terminal"
          aria-label="Split terminal"
          disabled={busy || !props.connected || uncertain || !current?.shared}
          onClick={() => void create(true)}
        >
          <ToolIcon kind="split" />
        </button>
        <button
          type="button"
          title="Refresh terminals"
          aria-label="Refresh terminals"
          disabled={busy || !props.connected}
          onClick={() => void refresh()}
        >
          <ToolIcon kind="refresh" />
        </button>
        <WorkspaceMenu label="Terminal actions" icon={<ToolIcon kind="more" />}>
          <div>
            <label>
              Shell profile
              <select value={profile} onChange={(event) => setProfile(event.currentTarget.value as typeof profile)}>
                <option value="default">VS Code default</option>
                <option value="powershell">PowerShell</option>
                <option value="cmd">Command Prompt</option>
                <option value="bash">Bash</option>
              </select>
            </label>
            <button
              type="button"
              disabled={!current || !props.connected}
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                if (current) {
                  props.onFocus(current.id);
                }
              }}
            >
              Show in VS Code
            </button>
            <button
              type="button"
              disabled={!current?.shared || !props.connected}
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                setName(current?.name ?? "");
                setRenameId(current?.id);
              }}
            >
              Rename terminal
            </button>
            <button
              type="button"
              disabled={!current?.shared || !props.connected}
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                setCloseId(current?.id);
              }}
            >
              Close terminal
            </button>
          </div>
        </WorkspaceMenu>
      </header>
      {notice ? (
        <p class="workspace-tool-notice" role="status">
          {notice}
        </p>
      ) : null}
      <div class={`workspace-terminal-panes ${second ? "is-split" : ""}`}>
        {current?.shared ? (
          <TerminalScreen key={current.id} {...props} id={current.id} name={current.name} />
        ) : (
          <div class="workspace-tool-empty">
            <ToolIcon kind="terminal" />
            <strong>{current ? "Native terminal" : "Project terminal"}</strong>
            <p>
              {current
                ? "VS Code’s public API cannot attach an existing terminal’s screen. Create a shared terminal to use the same interactive shell here and in VS Code."
                : "Start a shell with prompts, colours, keyboard input and command history."}
            </p>
            <button type="button" disabled={busy || !props.connected || uncertain} onClick={() => void create()}>
              New shared terminal
            </button>
            {current ? (
              <button type="button" onClick={() => props.onFocus(current.id)}>
                Open native terminal
              </button>
            ) : null}
          </div>
        )}
        {second ? (
          <div class="workspace-terminal-split">
            <button
              type="button"
              class="workspace-split-close"
              aria-label="Unsplit terminal view"
              title="Keep shell running and close this view"
              onClick={() => setSplit(undefined)}
            >
              <ToolIcon kind="close" />
            </button>
            <TerminalScreen key={second.id} {...props} id={second.id} name={second.name} />
          </div>
        ) : null}
      </div>
      {closeId ? (
        <ModalShell
          title="Close terminal?"
          subtitle="The shell and its running processes will stop."
          className="workspace-action-modal"
          onClose={() => setCloseId(undefined)}
          footer={
            <>
              <button type="button" onClick={() => setCloseId(undefined)}>
                Cancel
              </button>
              <button type="button" class="danger" disabled={busy} onClick={() => void change("close", closeId)}>
                Close terminal
              </button>
            </>
          }
        >
          <p>Save work in running programs before closing this terminal.</p>
        </ModalShell>
      ) : null}
      {renameId ? (
        <ModalShell
          title="Rename terminal"
          className="workspace-action-modal"
          onClose={() => setRenameId(undefined)}
          footer={
            <>
              <button type="button" onClick={() => setRenameId(undefined)}>
                Cancel
              </button>
              <button type="button" disabled={busy || !name.trim()} onClick={() => void change("rename", renameId)}>
                Save name
              </button>
            </>
          }
        >
          <label>
            Terminal name
            <input value={name} maxLength={80} onInput={(event) => setName(event.currentTarget.value)} />
          </label>
        </ModalShell>
      ) : null}
    </section>
  );
}

function samePath(left?: string, right?: string): boolean {
  return left?.replace(/\\/g, "/").toLowerCase() === right?.replace(/\\/g, "/").toLowerCase();
}

function TerminalScreen(props: {
  id: string;
  name: string;
  projectPath?: string;
  targetDeviceId?: string;
  connected: boolean;
}) {
  const request = useWorkspaceRequest(props.projectPath, props.targetDeviceId, props.connected);
  const element = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal>(),
    search = useRef<SearchAddon>(),
    fitter = useRef<FitAddon>();
  const [notice, setNotice] = useState("Connecting terminal…"),
    [writable, setWritable] = useState(false),
    [find, setFind] = useState<string>();
  const [canClaim, setCanClaim] = useState(false);
  const findInput = useRef<HTMLInputElement>(null);
  const [refresh, setRefresh] = useState(0),
    [claim, setClaim] = useState(false),
    [ready, setReady] = useState(false);
  const controls = useRef<{ claim: () => void; fit: () => void }>({ claim: () => undefined, fit: () => undefined });
  useLayoutEffect(() => {
    let cancelled = false,
      dispose: (() => void) | undefined;
    const setup = async () => {
      const [{ Terminal }, { FitAddon }, { SearchAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
        import("@xterm/addon-web-links")
      ]);
      if (cancelled) {
        return;
      }
      if (!document.getElementById("workspace-xterm-css")) {
        const style = document.createElement("style");
        style.id = "workspace-xterm-css";
        style.textContent = terminalCss;
        document.head.append(style);
      }
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily:
          getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim() ||
          "Consolas, 'Liberation Mono', monospace",
        scrollback: 500,
        convertEol: false,
        allowProposedApi: true,
        screenReaderMode: true
      });
      const fit = new FitAddon(),
        finder = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(finder);
      term.loadAddon(
        new WebLinksAddon((event, url) => {
          if (!event.ctrlKey && !event.metaKey) {
            return;
          }
          if (/^https?:\/\//i.test(url)) {
            postMessageToHost({
              type: "dashboard:action",
              action: "openExternalUrl",
              requestId: createActionRequestId(),
              payload: { url }
            });
          }
        })
      );
      // The native VS Code renderer answers device queries for the shared process.
      const queryHandlers = [
        term.parser.registerCsiHandler({ final: "n" }, () => true),
        term.parser.registerCsiHandler({ prefix: "?", final: "n" }, () => true),
        term.parser.registerCsiHandler({ final: "c" }, () => true),
        term.parser.registerCsiHandler({ prefix: ">", final: "c" }, () => true),
        ...[10, 11, 12].map((code) => term.parser.registerOscHandler(code, (data) => data === "?")),
        term.parser.registerOscHandler(4, (data) => data.endsWith(";?"))
      ];
      if (element.current) {
        term.open(element.current);
      }
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown" || (!event.ctrlKey && !event.metaKey) || event.altKey) {
          return true;
        }
        if (event.key.toLowerCase() === "f") {
          event.preventDefault();
          setFind((value) => value ?? "");
          requestAnimationFrame(() => findInput.current?.focus());
          return false;
        }
        if (event.key.toLowerCase() === "c" && event.shiftKey && term.hasSelection()) {
          event.preventDefault();
          void copy();
          return false;
        }
        return true;
      });
      terminal.current = term;
      search.current = finder;
      fitter.current = fit;
      const theme = () => {
        const css = getComputedStyle(element.current!);
        const value = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
        const light = css.colorScheme === "light";
        const ansi = (name: string, dark: string, pale: string) =>
          value(`--vscode-terminal-ansi${name}`, light ? pale : dark);
        term.options.theme = {
          background: value("--vscode-terminal-background", value("--bg-base", "#0d1117")),
          foreground: value("--vscode-terminal-foreground", value("--text", "#d7dee8")),
          cursor: value("--vscode-terminalCursor-foreground", value("--accent-blue", "#60a5fa")),
          selectionBackground: "#4169a855",
          black: ansi("Black", "#1b1d23", "#202124"),
          red: ansi("Red", "#f14c4c", "#b42318"),
          green: ansi("Green", "#23d18b", "#1a6e39"),
          yellow: ansi("Yellow", "#f5f543", "#795e26"),
          blue: ansi("Blue", "#3b8eea", "#0451a5"),
          magenta: ansi("Magenta", "#d670d6", "#9b3d79"),
          cyan: ansi("Cyan", "#29b8db", "#005f87"),
          white: ansi("White", "#e5e5e5", "#5b6068"),
          brightBlack: ansi("BrightBlack", "#777777", "#6a6f77"),
          brightRed: ansi("BrightRed", "#f14c4c", "#b42318"),
          brightGreen: ansi("BrightGreen", "#23d18b", "#1a6e39"),
          brightYellow: ansi("BrightYellow", "#f5f543", "#795e26"),
          brightBlue: ansi("BrightBlue", "#3b8eea", "#0451a5"),
          brightMagenta: ansi("BrightMagenta", "#d670d6", "#9b3d79"),
          brightCyan: ansi("BrightCyan", "#29b8db", "#005f87"),
          brightWhite: ansi("BrightWhite", "#ffffff", "#202124")
        };
      };
      theme();
      const observer = new MutationObserver(theme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme", "style"]
      });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["class", "data-vscode-theme-kind", "style"]
      });
      dispose = () => {
        observer.disconnect();
        queryHandlers.forEach((item) => item.dispose());
        term.dispose();
        terminal.current = undefined;
      };
      setReady(true);
    };
    void setup().catch((error) => {
      if (!cancelled) {
        setNotice(`Terminal renderer could not start: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  useEffect(() => {
    if (!ready || !terminal.current) {
      return;
    }
    const term = terminal.current;
    let active = true,
      reading = false,
      failed = false,
      state: WorkspaceTerminalSnapshot | undefined;
    let queue = "",
      sending = false,
      pendingResize: ReturnType<typeof setTimeout> | undefined,
      inputTimer: ReturnType<typeof setTimeout> | undefined;
    let buffered: DashboardWorkspaceTerminalOutput[] = [],
      pendingOutput = 0;
    const freeze = (error: unknown) => {
      if (!active) {
        return;
      }
      failed = true;
      queue = "";
      setWritable(false);
      setCanClaim(error instanceof Error && error.message.includes("Another workspace controls"));
      term.options.disableStdin = true;
      setNotice(error instanceof Error ? error.message : String(error));
    };
    const resize = async () => {
      if (
        !active ||
        !state?.writable ||
        failed ||
        reading ||
        state.exited ||
        !props.connected ||
        !element.current?.clientWidth ||
        !element.current.clientHeight
      ) {
        return;
      }
      try {
        const size = fitter.current?.proposeDimensions();
        if (!size) {
          return;
        }
        const cols = Math.min(300, Math.max(2, size.cols)),
          rows = Math.min(120, Math.max(1, size.rows));
        if (cols === state.cols && rows === state.rows) {
          return;
        }
        const result = await request("workspaceTerminal", {
          terminalId: props.id,
          terminalRequest: { operation: "resize", clientId, epoch: state.epoch, cols, rows }
        });
        if (active && result.terminalSnapshot) {
          state.cols = result.terminalSnapshot.cols;
          state.rows = result.terminalSnapshot.rows;
          term.resize(state.cols, state.rows);
        }
      } catch (error) {
        freeze(error);
      }
    };
    const apply = (output: DashboardWorkspaceTerminalOutput) => {
      if (!state || output.id !== state.epoch || output.sequence <= state.sequence) {
        return;
      }
      if (output.sequence !== state.sequence + 1) {
        void load();
        return;
      }
      if (output.cols && output.rows && (term.cols !== output.cols || term.rows !== output.rows)) {
        term.resize(output.cols, output.rows);
      }
      state.sequence = output.sequence;
      pendingOutput += output.chunk.length;
      if (pendingOutput > 2 * 1024 * 1024) {
        freeze(new Error("Terminal rendering fell behind. Refresh to restore the current screen."));
        return;
      }
      term.write(output.chunk, () => {
        pendingOutput = Math.max(0, pendingOutput - output.chunk.length);
      });
      if (output.exited) {
        setCanClaim(false);
        state.exited = true;
        state.writable = false;
        setWritable(false);
        term.options.disableStdin = true;
        setNotice("Shell exited. Create a new terminal to continue.");
      }
    };
    const load = async (take = false) => {
      if (reading || !active || !props.connected) {
        return;
      }
      reading = true;
      setCanClaim(false);
      failed = false;
      queue = "";
      buffered = [];
      setWritable(false);
      term.options.disableStdin = true;
      setNotice("Connecting terminal…");
      try {
        const result = await request("workspaceTerminal", {
          terminalId: props.id,
          terminalRequest: { operation: take ? "claim" : "read", clientId, takeControl: take }
        });
        if (!active) {
          return;
        }
        if (!result.terminalSnapshot || typeof result.terminalSnapshot.content !== "string") {
          throw new Error("The system did not return a terminal screen. Update the selected system and retry.");
        }
        state = result.terminalSnapshot;
        term.reset();
        term.resize(state.cols, state.rows);
        term.write(state.content!, () => {
          if (!active || !state) {
            return;
          }
          reading = false;
          const pending = buffered;
          buffered = [];
          for (const output of pending.sort((a, b) => a.sequence - b.sequence)) {
            apply(output);
          }
          if (reading) {
            return;
          }
          setWritable(state.writable);
          setCanClaim(!state.writable && !state.exited);
          term.options.disableStdin = !state.writable;
          setNotice(
            state.exited
              ? "Shell exited. Create a new terminal to continue."
              : state.writable
                ? ""
                : "Read only · another workspace is typing."
          );
          void resize();
        });
      } catch (error) {
        reading = false;
        freeze(error);
      }
    };
    const send = async () => {
      if (!active || sending || failed || reading || !state?.writable || !queue) {
        return;
      }
      sending = true;
      let data = "",
        bytes = 0;
      for (const char of queue) {
        const count = new TextEncoder().encode(char).length;
        if (bytes + count > 16 * 1024) {
          break;
        }
        data += char;
        bytes += count;
      }
      queue = queue.slice(data.length);
      const sequence = state.inputSequence + 1;
      try {
        const result = await request("workspaceTerminal", {
          terminalId: props.id,
          terminalRequest: { operation: "input", clientId, epoch: state.epoch, sequence, data }
        });
        if (active) {
          if (result.terminalSnapshot?.inputSequence !== sequence) {
            throw new Error("Input was not confirmed. Refresh before typing; commands were not replayed.");
          }
          state.inputSequence = sequence;
        }
      } catch (error) {
        freeze(error);
      } finally {
        sending = false;
        if (active && queue && !failed) {
          void send();
        }
      }
    };
    const input = term.onData((data) => {
      if (!state?.writable || failed || reading || !props.connected) {
        return;
      }
      if (new TextEncoder().encode(queue + data).length > 64 * 1024) {
        freeze(new Error("Terminal input queue is full. Remaining input was not sent. Refresh before typing again."));
        return;
      }
      queue += data;
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => void send(), 16);
    });
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const output = event.data?.type === "dashboard:terminal-output" ? event.data.output : undefined;
      if (
        !output?.raw ||
        output.terminalId !== props.id ||
        (output.deviceId ?? "") !== (props.targetDeviceId ?? "") ||
        failed
      ) {
        return;
      }
      if (!isRawWorkspaceTerminalOutput(output)) {
        freeze(new Error("The terminal stream was invalid. Refresh its screen before continuing."));
        return;
      }
      if (reading) {
        if (
          buffered.length >= 256 ||
          buffered.reduce((count, item) => count + item.chunk.length, 0) + output.chunk.length > 1024 * 1024
        ) {
          buffered = [];
          reading = false;
          freeze(new Error("Terminal output advanced beyond the reconnect buffer. Refresh to restore its screen."));
        } else {
          buffered.push(output);
        }
      } else if (state && state.epoch !== output.id) {
        void load();
      } else {
        apply(output);
      }
    };
    controls.current = { claim: () => void load(true), fit: () => void resize() };
    window.addEventListener("message", receive);
    const observer = new ResizeObserver(() => {
      clearTimeout(pendingResize);
      pendingResize = setTimeout(() => void resize(), 100);
    });
    if (element.current) {
      observer.observe(element.current);
    }
    if (props.connected) {
      void load();
    } else {
      freeze(new Error("Disconnected · reconnect to restore this terminal."));
    }
    return () => {
      active = false;
      queue = "";
      clearTimeout(inputTimer);
      clearTimeout(pendingResize);
      observer.disconnect();
      input.dispose();
      window.removeEventListener("message", receive);
    };
  }, [props.id, props.connected, request, refresh, ready]);
  const copy = async () => {
    try {
      const value = terminal.current?.getSelection();
      if (!value) {
        setNotice("Select terminal text to copy.");
        return;
      }
      await navigator.clipboard.writeText(value);
      setNotice("Selection copied.");
    } catch {
      setNotice("Clipboard access was denied. Use Ctrl+Shift+C to copy the selection.");
    }
  };
  return (
    <div class="workspace-terminal-screen">
      <div class="workspace-terminal-caption">
        <span title={props.name}>{props.name}</span>
        <button
          type="button"
          title="Find in terminal"
          aria-label="Find in terminal"
          onClick={() => setFind(find === undefined ? "" : undefined)}
        >
          <ToolIcon kind="search" />
        </button>
        <button type="button" title="Copy selection" aria-label="Copy terminal selection" onClick={() => void copy()}>
          <ToolIcon kind="copy" />
        </button>
        <button
          type="button"
          title="Clear local scrollback"
          aria-label="Clear local terminal scrollback"
          onClick={() => {
            terminal.current?.clear();
            setNotice("Local scrollback cleared. The shell continues running.");
          }}
        >
          <ToolIcon kind="clear" />
        </button>
        <button
          type="button"
          title="Reconnect terminal screen"
          aria-label="Reconnect terminal screen"
          disabled={!props.connected}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <ToolIcon kind="refresh" />
        </button>
      </div>
      {find !== undefined ? (
        <form
          class="workspace-terminal-find"
          onSubmit={(event) => {
            event.preventDefault();
            if (!search.current?.findNext(find)) {
              setNotice("No matching terminal text.");
            }
          }}
        >
          <input
            ref={findInput}
            autoFocus
            aria-label="Find terminal text"
            value={find}
            onInput={(event) => {
              const text = event.currentTarget.value;
              setFind(text);
              search.current?.findNext(text, { incremental: true });
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setFind(undefined);
                terminal.current?.focus();
              }
            }}
          />
          <button type="button" aria-label="Previous match" onClick={() => search.current?.findPrevious(find)}>
            ↑
          </button>
          <button type="submit" aria-label="Next match">
            ↓
          </button>
          <button
            type="button"
            aria-label="Close terminal search"
            onClick={() => {
              setFind(undefined);
              terminal.current?.focus();
            }}
          >
            <ToolIcon kind="close" />
          </button>
        </form>
      ) : null}
      {notice ? (
        <div class="workspace-terminal-status" role="status">
          <span>{notice}</span>
          {!writable && canClaim && props.connected ? (
            <button type="button" onClick={() => setClaim(true)}>
              Take control
            </button>
          ) : null}
        </div>
      ) : null}
      <div ref={element} class="workspace-xterm" aria-label={`${props.name} terminal screen`} />
      {claim ? (
        <ModalShell
          title="Take terminal control?"
          className="workspace-action-modal"
          onClose={() => setClaim(false)}
          footer={
            <>
              <button type="button" onClick={() => setClaim(false)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setClaim(false);
                  controls.current.claim();
                }}
              >
                Take control
              </button>
            </>
          }
        >
          <p>
            Input from this workspace will control the shared shell. Other workspaces can continue viewing its output.
          </p>
        </ModalShell>
      ) : null}
    </div>
  );
}
