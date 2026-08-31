import { readFileSync } from "fs";
import { runInNewContext } from "vm";
import { describe, expect, it, vi } from "vitest";

describe("browser dashboard bridge", () => {
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
    expect(events).toContainEqual({
      type: "dashboard:notice",
      level: "error",
      message: "Dashboard action failed (502)"
    });
  });
});
