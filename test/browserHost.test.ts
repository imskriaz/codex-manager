import { readFileSync } from "fs";
import { runInNewContext } from "vm";
import { describe, expect, it, vi } from "vitest";

describe("browser dashboard bridge", () => {
  it("replays an earlier snapshot immediately when a dashboard listener becomes ready", async () => {
    const events: Array<Record<string, unknown>> = [];
    const snapshot = { accounts: [{ id: "one" }] };
    let finishSecond!: (response: unknown) => void;
    const response = { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => snapshot };
    const fetchMock = vi.fn().mockResolvedValueOnce(response).mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }));
    const windowMock = {
      dispatchEvent: (event: { data: Record<string, unknown> }) => events.push(event.data),
      setTimeout: vi.fn(), clearTimeout: vi.fn(), location: { reload: vi.fn() },
      acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> })
    };
    class Event { constructor(_type: string, public options: { data: Record<string, unknown> }) {} get data() { return this.options.data; } }
    runInNewContext(readFileSync("media/webview/browserHost.js", "utf8"), {
      window: windowMock, MessageEvent: Event, fetch: fetchMock,
      console: { error: vi.fn(), warn: vi.fn() }, Error, Array, JSON, Date, Map
    });
    const post = windowMock.acquireVsCodeApi!().postMessage;
    await post({ type: "dashboard:ready" });
    events.length = 0;
    const pending = post({ type: "dashboard:ready" });
    expect(events).toContainEqual({ type: "dashboard:snapshot", state: snapshot });
    finishSecond(response);
    await pending;
  });
  it("rejects an offline browser action immediately without sending it or starting a timeout", async () => {
    const events: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn();
    const timer = vi.fn();
    const windowMock = {
      dispatchEvent: (event: { data: Record<string, unknown> }) => events.push(event.data),
      setTimeout: timer, clearTimeout: vi.fn(), location: { reload: vi.fn() },
      acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> })
    };
    class Event { constructor(_type: string, public options: { data: Record<string, unknown> }) {} get data() { return this.options.data; } }
    runInNewContext(readFileSync("media/webview/browserHost.js", "utf8"), {
      window: windowMock, navigator: { onLine: false }, MessageEvent: Event, fetch: fetchMock,
      console: { error: vi.fn(), warn: vi.fn() }, Error, Array, JSON, Date, Map
    });
    await windowMock.acquireVsCodeApi!().postMessage({ type: "dashboard:action", action: "switch", requestId: "offline" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ requestId: "offline", status: "failed", error: expect.stringContaining("was not sent") }));
  });
  it("replaces stale sockets on retry, network recovery, and suspension without replaying actions", async () => {
    const events: Array<Record<string, unknown>> = [], sockets: Socket[] = [];
    const listeners = new Map<string, () => void>();
    let now = 1000;
    const navigatorMock = { onLine: true };
    const documentMock = { visibilityState: "visible", addEventListener: (name: string, callback: () => void) => listeners.set(name, callback) };
    class Socket {
      static readonly OPEN = 1;
      readyState = 0;
      listeners = new Map<string, (event?: unknown) => void>();
      send = vi.fn(); close = vi.fn(() => { this.readyState = 3; });
      constructor(public url: string) { sockets.push(this); }
      addEventListener(name: string, callback: (event?: unknown) => void) { this.listeners.set(name, callback); }
      open() { this.readyState = Socket.OPEN; this.listeners.get("open")!(); }
    }
    const windowMock = {
      dispatchEvent: (event: { data: Record<string, unknown> }) => events.push(event.data),
      setTimeout: vi.fn(), clearTimeout: vi.fn(),
      addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
      location: { protocol: "https:", host: "dashboard.example.com", reload: vi.fn() }, WebSocket: Socket,
      acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> })
    };
    class Event { constructor(_type: string, public options: { data: Record<string, unknown> }) {} get data() { return this.options.data; } }
    runInNewContext(readFileSync("media/webview/browserHost.js", "utf8"), {
      window: windowMock, document: documentMock, navigator: navigatorMock, MessageEvent: Event,
      fetch: vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) })),
      console: { error: vi.fn(), warn: vi.fn() }, Error, Array, JSON, Date: { now: () => now }, Map
    });
    const post = windowMock.acquireVsCodeApi!().postMessage;
    expect(sockets[0]!.url).toBe("wss://dashboard.example.com/ws");
    sockets[0]!.open();
    await post({ type: "dashboard:action", requestId: "unconfirmed", action: "switch" });
    await post({ type: "dashboard:retry-connection" });
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(events.filter(event => event.requestId === "unconfirmed")).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("outcome is unknown") })]);
    expect(events).toContainEqual(expect.objectContaining({ type: "dashboard:notice", level: "warning" }));
    sockets[0]!.listeners.get("message")!({ data: JSON.stringify({ type: "dashboard:snapshot", state: { stale: true } }) });
    expect(events).not.toContainEqual(expect.objectContaining({ state: { stale: true } }));
    sockets[1]!.open();
    listeners.get("online")!();
    expect(sockets[1]!.close).toHaveBeenCalledOnce();
    sockets[2]!.open();
    documentMock.visibilityState = "hidden"; listeners.get("visibilitychange")!();
    now += 1000; documentMock.visibilityState = "visible"; listeners.get("visibilitychange")!();
    expect(sockets).toHaveLength(3);
    documentMock.visibilityState = "hidden"; listeners.get("visibilitychange")!();
    now += 16000; documentMock.visibilityState = "visible"; listeners.get("visibilitychange")!();
    expect(sockets[2]!.close).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(4);
    sockets[3]!.open();
    await post({ type: "dashboard:action", requestId: "recovered", action: "listCodexCliSessions" });
    expect(sockets[3]!.send).toHaveBeenCalledOnce();
    expect(sockets.slice(1, 3).every(socket => socket.send.mock.calls.length === 0)).toBe(true);
    navigatorMock.onLine = false; listeners.get("offline")!();
    expect(events).toContainEqual(expect.objectContaining({ stage: "offline" }));
    documentMock.visibilityState = "visible"; listeners.get("visibilitychange")!();
    expect(sockets).toHaveLength(4);
    navigatorMock.onLine = true; listeners.get("online")!();
    expect(sockets).toHaveLength(5);
  });
  it("aborts a stalled HTTP action and reports its unconfirmed outcome", async () => {
    const events: Array<Record<string, unknown>> = [];
    const timers: Array<() => void> = [];
    const windowMock = {
      dispatchEvent: (event: { data: Record<string, unknown> }) => events.push(event.data),
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
      clearTimeout: vi.fn(), location: { reload: vi.fn() },
      acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> })
    };
    class Event { constructor(_type: string, public options: { data: Record<string, unknown> }) {} get data() { return this.options.data; } }
    runInNewContext(readFileSync("media/webview/browserHost.js", "utf8"), {
      window: windowMock, MessageEvent: Event, AbortController,
      fetch: vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))),
      console: { error: vi.fn(), warn: vi.fn() }, Error, Array, JSON, Date, Map
    });
    const pending = windowMock.acquireVsCodeApi!().postMessage({ type: "dashboard:action", requestId: "stalled", action: "switch" });
    timers[0]!();
    await pending;
    expect(events).toContainEqual(expect.objectContaining({ type: "dashboard:action-result", requestId: "stalled", status: "failed", error: expect.stringContaining("outcome is unknown") }));
    expect(windowMock.clearTimeout).toHaveBeenCalledOnce();
  });

  it("bounds the socket queue, expires pending actions, and removes completed timers", async () => {
    const events: Array<Record<string, unknown>> = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let socket!: Socket;
    class Socket {
      static readonly OPEN = 1;
      readyState = 0;
      listeners = new Map<string, (event?: unknown) => void>();
      send = vi.fn(); close = vi.fn();
      constructor() { socket = this; }
      addEventListener(type: string, callback: (event?: unknown) => void) { this.listeners.set(type, callback); }
    }
    const windowMock = {
      dispatchEvent: (event: { data: Record<string, unknown> }) => events.push(event.data),
      setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
      clearTimeout: (id: number) => timers.delete(id),
      location: { protocol: "http:", host: "127.0.0.1:39875", reload: vi.fn() }, WebSocket: Socket,
      acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> })
    };
    class Event { constructor(_type: string, public options: { data: Record<string, unknown> }) {} get data() { return this.options.data; } }
    runInNewContext(readFileSync("media/webview/browserHost.js", "utf8"), {
      window: windowMock, MessageEvent: Event, fetch: vi.fn(), console: { error: vi.fn(), warn: vi.fn() }, Error, Array, JSON, Date, Map
    });
    socket.readyState = Socket.OPEN;
    socket.listeners.get("open")!();
    const post = windowMock.acquireVsCodeApi!().postMessage;
    for (let id = 0; id < 129; id++) await post({ type: "dashboard:action", requestId: `queue-${id}`, action: "refresh" });
    expect(socket.send).toHaveBeenCalledTimes(128);
    expect(events).toContainEqual(expect.objectContaining({ requestId: "queue-128", status: "failed", error: expect.stringContaining("queue is full") }));
    await post({ type: "dashboard:action", requestId: "queue-0", action: "refresh" });
    expect(socket.send).toHaveBeenCalledTimes(128);
    socket.listeners.get("message")!({ data: JSON.stringify({ type: "dashboard:action-result", requestId: "queue-0", status: "completed" }) });
    expect(timers.size).toBe(127);
    for (const callback of [...timers.values()]) callback();
    expect(timers.size).toBe(0);
    expect(events.filter((event) => event.status === "failed" && String(event.error).includes("outcome is unknown"))).toHaveLength(127);
    await post({ type: "dashboard:action", requestId: "recovered", action: "refresh" });
    expect(socket.send).toHaveBeenCalledTimes(129);
  });
  it("uses the live WebSocket for requests and publishes connection state without polling", async () => {
    const events: unknown[] = [];
    const sockets: TestWebSocket[] = [];
    const fetchMock = vi.fn();
    class TestMessageEvent {
      constructor(
        _type: string,
        public readonly init: { data: unknown }
      ) {}

      get data(): unknown {
        return this.init.data;
      }
    }
    class TestWebSocket {
      static readonly OPEN = 1;
      readyState = 0;
      readonly send = vi.fn();
      private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();

      constructor(public readonly url: string) {
        sockets.push(this);
      }

      addEventListener(type: string, listener: (event: { data?: string }) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      emit(type: string, event: { data?: string } = {}): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }

      close(): void {
        this.readyState = 3;
      }
    }
    const windowMock = {
      dispatchEvent: vi.fn((event: { data: unknown }) => events.push(event.data)),
      setInterval: vi.fn(),
      setTimeout: vi.fn(),
      location: { protocol: "http:", host: "127.0.0.1:39875", reload: vi.fn() },
      WebSocket: TestWebSocket,
      acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> })
    };

    const code = readFileSync("media/webview/browserHost.js", "utf8");
    runInNewContext(code, {
      window: windowMock,
      MessageEvent: TestMessageEvent,
      fetch: fetchMock,
      console: { error: vi.fn() },
      Error,
      Array,
      JSON
    });

    expect(sockets[0]?.url).toBe("ws://127.0.0.1:39875/ws");
    sockets[0]!.readyState = TestWebSocket.OPEN;
    sockets[0]!.emit("open");
    expect(events).toContainEqual({ type: "dashboard:connection", transport: "websocket", connected: true });

    const action = { type: "dashboard:action", requestId: "request-live", action: "refreshAll" };
    await windowMock.acquireVsCodeApi?.().postMessage(action);
    expect(sockets[0]!.send).toHaveBeenCalledWith(JSON.stringify(action));
    expect(fetchMock).not.toHaveBeenCalled();

    sockets[0]!.emit("message", { data: JSON.stringify({ type: "dashboard:notice", level: "info", message: "Synced." }) });
    expect(events).toContainEqual({ type: "dashboard:notice", level: "info", message: "Synced." });

    sockets[0]!.emit("error");
    expect(sockets[0]!.readyState).toBe(TestWebSocket.OPEN);

    expect(windowMock.setInterval).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200, headers: { get: () => "application/json" },
      json: async () => ({ messages: [{ type: "dashboard:action-result", action: "refreshView", requestId: "recover-view", status: "completed" }] })
    });
    await windowMock.acquireVsCodeApi?.().postMessage({ type: "dashboard:action", action: "refreshView", requestId: "recover-view" });
    expect(fetchMock).toHaveBeenCalledWith("/api/message", expect.objectContaining({ method: "POST" }));
    expect(sockets[0]!.send).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ requestId: "recover-view", status: "completed" }));
  });

  it("does not close a browser WebSocket re-entrantly from its error event", () => {
    const source = readFileSync("media/webview/browserHost.js", "utf8");
    expect(source).toContain('socket.addEventListener("error", () => undefined);');
    expect(source).not.toContain('socket.addEventListener("error", () => socket.close());');
  });

  it("reconnects quickly with bounded backoff and resets after a successful connection", () => {
    const source = readFileSync("media/webview/browserHost.js", "utf8");
    expect(source).toContain("let reconnectDelayMs = 500;");
    expect(source).toContain("const maxReconnectDelayMs = 5000;");
    expect(source).toContain("reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxReconnectDelayMs);");
    expect(source).not.toContain("window.setTimeout(connectRealtime, 3000)");
  });

  it("resolves a failed remote action immediately instead of leaving the modal waiting", async () => {
    const events: unknown[] = [];
    const windowMock = {
      dispatchEvent: vi.fn((event: { data: unknown }) => events.push(event.data)),
      setInterval: vi.fn(),
      location: { reload: vi.fn() },
      acquireVsCodeApi: undefined as
        | undefined
        | (() => { postMessage(message: unknown): Promise<void> })
    };
    class TestMessageEvent {
      constructor(
        _type: string,
        public readonly init: { data: unknown }
      ) {}

      get data(): unknown {
        return this.init.data;
      }
    }
    const code = readFileSync("media/webview/browserHost.js", "utf8");
    runInNewContext(code, {
      window: windowMock,
      MessageEvent: TestMessageEvent,
      fetch: vi.fn(async () => ({ status: 502, ok: false })),
      console: { error: vi.fn() },
      Error,
      Array,
      JSON
    });

    await windowMock.acquireVsCodeApi?.().postMessage({
      type: "dashboard:action",
      requestId: "remote-oauth-1",
      action: "prepareOAuthSession"
    });

    expect(events).toContainEqual({
      type: "dashboard:action-result",
      requestId: "remote-oauth-1",
      action: "prepareOAuthSession",
      accountId: undefined,
      status: "failed",
      error: "Dashboard action failed (502)"
    });
    expect(events.filter((event) => event.type === "dashboard:notice")).toEqual([]);
  });

  it("reports an unconfirmed action when the live socket closes and checks host reachability", async () => {
    const events: Array<Record<string, unknown>> = [];
    class TestMessageEvent {
      constructor(_type: string, public readonly init: { data: Record<string, unknown> }) {}
      get data(): Record<string, unknown> { return this.init.data; }
    }
    class TestWebSocket {
      static readonly OPEN = 1;
      readyState = 0;
      private readonly listeners = new Map<string, Array<(event: { code?: number; data?: string }) => void>>();
      readonly send = vi.fn();
      addEventListener(type: string, listener: (event: { code?: number; data?: string }) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      emit(type: string, event: { code?: number; data?: string } = {}): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    const sockets: TestWebSocket[] = [];
    const WebSocketFactory = class extends TestWebSocket {
      constructor(_url: string) { super(); sockets.push(this); }
    };
    const windowMock = {
      dispatchEvent: vi.fn((event: { data: Record<string, unknown> }) => events.push(event.data)),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      location: { protocol: "http:", host: "127.0.0.1:39875", reload: vi.fn() },
      WebSocket: WebSocketFactory,
      acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> })
    };
    runInNewContext(readFileSync("media/webview/browserHost.js", "utf8"), {
      window: windowMock,
      MessageEvent: TestMessageEvent,
      fetch: vi.fn(async () => { throw new Error("host down"); }),
      console: { error: vi.fn(), warn: vi.fn() },
      Error, Array, JSON, Date, Map
    });
    sockets[0]!.readyState = TestWebSocket.OPEN;
    sockets[0]!.emit("open");
    await windowMock.acquireVsCodeApi?.().postMessage({ type: "dashboard:action", requestId: "save-1", action: "saveWorkspaceFile" });
    sockets[0]!.emit("close", { code: 1006 });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "dashboard:host-status", stage: "unreachable" })));
    expect(events).toContainEqual(expect.objectContaining({
      type: "dashboard:action-result", requestId: "save-1", status: "failed",
      error: expect.stringContaining("outcome is unknown")
    }));
    expect(events).toContainEqual({ type: "dashboard:connection", transport: "websocket", connected: false });
  });

  it("gives an explicit terminal result for a manual connection retry", async () => {
    const events: Array<Record<string, unknown>> = [];
    class TestMessageEvent {
      constructor(_type: string, public readonly init: { data: Record<string, unknown> }) {}
      get data(): Record<string, unknown> { return this.init.data; }
    }
    const windowMock = {
      dispatchEvent: vi.fn((event: { data: Record<string, unknown> }) => events.push(event.data)),
      location: { reload: vi.fn() },
      acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> })
    };
    runInNewContext(readFileSync("media/webview/browserHost.js", "utf8"), {
      window: windowMock,
      MessageEvent: TestMessageEvent,
      fetch: vi.fn(async () => { throw new Error("host down"); }),
      console: { error: vi.fn(), warn: vi.fn() },
      Error, Array, JSON, Date, Map
    });
    await windowMock.acquireVsCodeApi?.().postMessage({ type: "dashboard:retry-connection" });
    expect(events).toContainEqual({
      type: "dashboard:notice", level: "error",
      message: "Dashboard is still unavailable. Check VS Code and try again."
    });
  });
  it("replays an early connection to the mounted UI and recovers a stalled handshake", async () => {
    const events: Array<Record<string, unknown>> = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const sockets: Socket[] = [];
    class Socket {
      static readonly OPEN = 1;
      readyState = 0;
      listeners = new Map<string, (event?: unknown) => void>();
      close = vi.fn();
      constructor() { sockets.push(this); }
      addEventListener(type: string, callback: (event?: unknown) => void): void { this.listeners.set(type, callback); }
    }
    const windowMock = {
      dispatchEvent: (event: { data: Record<string, unknown> }) => events.push(event.data),
      setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length; },
      clearTimeout: vi.fn(),
      location: { protocol: "http:", host: "127.0.0.1:39875", reload: vi.fn() },
      WebSocket: Socket,
      acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> })
    };
    class Event { constructor(_type: string, public options: { data: Record<string, unknown> }) {} get data() { return this.options.data; } }
    runInNewContext(readFileSync("media/webview/browserHost.js", "utf8"), {
      window: windowMock, MessageEvent: Event, fetch: vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) })), console, Error, Array, JSON, Date, Map
    });
    timers.find(timer => timer.delay === 10_000)!.callback();
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: "dashboard:host-status", stage: "reconnecting" }));
    timers.find(timer => timer.delay === 500)!.callback();
    sockets[1]!.readyState = Socket.OPEN;
    sockets[1]!.listeners.get("open")!();
    events.length = 0; // UI mounts after open; ready must replay transport state.
    await windowMock.acquireVsCodeApi!().postMessage({ type: "dashboard:ready" });
    expect(events).toContainEqual({ type: "dashboard:connection", transport: "websocket", connected: true });
    expect(events).toContainEqual(expect.objectContaining({ type: "dashboard:host-status", stage: "live" }));
  });

  it("fails expired HTTP switches once and routes to sign-in without replay", async () => {
    const events: Array<Record<string, unknown>> = [];
    const assign = vi.fn();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    const windowMock = { dispatchEvent: (event: { data: Record<string, unknown> }) => events.push(event.data),
      location: { pathname: "/dash", assign }, acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> }) };
    class Event { constructor(_type: string, public options: { data: Record<string, unknown> }) {} get data() { return this.options.data; } }
    runInNewContext(readFileSync("media/webview/browserHost.js", "utf8"), { window: windowMock, MessageEvent: Event, fetch: fetchMock, console, Error, Array, JSON, Date, Map });
    const post = windowMock.acquireVsCodeApi!().postMessage;
    await post({ type: "dashboard:action", requestId: "expired", action: "switch" });
    await post({ type: "dashboard:action", requestId: "retry", action: "switch" });
    expect(events).toContainEqual(expect.objectContaining({ requestId: "expired", status: "failed", error: expect.stringContaining("was not performed") }));
    expect(events).toContainEqual(expect.objectContaining({ requestId: "retry", status: "failed", error: expect.stringContaining("was not sent") }));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledExactlyOnceWith("/login?returnTo=%2Fdash");
  });

  it("redirects an expired initial snapshot while preserving the conversation return path", async () => {
    const assign = vi.fn();
    const windowMock = { dispatchEvent: vi.fn(), location: { pathname: "/12345678-1234-1234-1234-123456789abc", assign },
      acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> }) };
    class Event { constructor(_type: string, public options: unknown) {} }
    runInNewContext(readFileSync("media/webview/browserHost.js", "utf8"), { window: windowMock, MessageEvent: Event, fetch: vi.fn(async () => ({ ok: false, status: 401 })), console, Error, Array, JSON, Date, Map });
    await windowMock.acquireVsCodeApi!().postMessage({ type: "dashboard:ready" });
    expect(assign).toHaveBeenCalledExactlyOnceWith("/login?returnTo=%2F12345678-1234-1234-1234-123456789abc");
  });

  it("stops reconnecting and preserves uncertain outcomes when an authenticated socket expires", async () => {
    const events: Array<Record<string, unknown>> = [];
    let socket!: Socket;
    class Socket {
      static readonly OPEN = 1; readyState = 0;
      listeners = new Map<string, (event?: any) => void>();
      send = vi.fn(); close = vi.fn();
      constructor() { socket = this; }
      addEventListener(type: string, callback: (event?: unknown) => void) { this.listeners.set(type, callback); }
    }
    const assign = vi.fn();
    const windowMock = { dispatchEvent: (event: { data: Record<string, unknown> }) => events.push(event.data), setTimeout: vi.fn(), clearTimeout: vi.fn(),
      location: { protocol: "https:", host: "dashboard.example", pathname: "/dash", assign }, WebSocket: Socket,
      acquireVsCodeApi: undefined as undefined | (() => { postMessage(message: unknown): Promise<void> }) };
    class Event { constructor(_type: string, public options: { data: Record<string, unknown> }) {} get data() { return this.options.data; } }
    const fetchMock = vi.fn();
    runInNewContext(readFileSync("media/webview/browserHost.js", "utf8"), { window: windowMock, MessageEvent: Event, fetch: fetchMock, console, Error, Array, JSON, Date, Map });
    socket.readyState = Socket.OPEN; socket.listeners.get("open")!();
    await windowMock.acquireVsCodeApi!().postMessage({ type: "dashboard:action", requestId: "uncertain", action: "switch" });
    socket.listeners.get("close")!({ code: 4001 });
    expect(events).toContainEqual(expect.objectContaining({ requestId: "uncertain", status: "failed", error: expect.stringContaining("outcome is unknown") }));
    expect(assign).toHaveBeenCalledExactlyOnceWith("/login?returnTo=%2Fdash");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledOnce();
  });

});
