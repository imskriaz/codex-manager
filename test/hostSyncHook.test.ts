import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardHostMessage } from "../src/domain/dashboard/types";

const { effectMock, postMessageToHostMock, sharedRef } = vi.hoisted(() => ({
  effectMock: vi.fn(),
  postMessageToHostMock: vi.fn(),
  sharedRef: { current: undefined as unknown }
}));

vi.mock("preact/hooks", () => ({
  useEffect: effectMock,
  useRef: vi.fn((value: unknown) => {
    if (sharedRef.current === undefined) sharedRef.current = value;
    return sharedRef;
  })
}));

vi.mock("../webview-src/dashboard/host", () => ({
  postMessageToHost: postMessageToHostMock
}));

import { useDashboardHostSync } from "../webview-src/dashboard/hostSyncHook";

describe("useDashboardHostSync", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    effectMock.mockReset();
    postMessageToHostMock.mockReset();
    sharedRef.current = undefined;
  });

  it("attaches once and routes delayed tunnel responses to the latest render callbacks", () => {
    const listeners = new Map<string, (event: Event & { data?: DashboardHostMessage }) => void>();
    const fakeWindow = {
      addEventListener: vi.fn((type: string, listener: (event: Event & { data?: DashboardHostMessage }) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn()
    };
    vi.stubGlobal("window", fakeWindow);
    const firstHandler = vi.fn();
    const latestHandler = vi.fn();
    let setup: (() => () => void) | undefined;
    effectMock.mockImplementationOnce((callback: () => () => void, dependencies: unknown[]) => {
      setup = callback;
      expect(dependencies).toEqual([]);
    });

    useDashboardHostSync({ handleHostMessage: firstHandler, handleEscape: () => true });
    const dispose = setup?.();
    useDashboardHostSync({ handleHostMessage: latestHandler, handleEscape: () => true });

    const message = { type: "dashboard:notice", level: "warning", message: "remote result" } as const;
    listeners.get("message")?.({ data: message } as MessageEvent<DashboardHostMessage>);

    expect(firstHandler).not.toHaveBeenCalled();
    expect(latestHandler).toHaveBeenCalledWith(message);
    expect(postMessageToHostMock).toHaveBeenCalledTimes(1);
    expect(postMessageToHostMock).toHaveBeenCalledWith({ type: "dashboard:ready" });
    dispose?.();
    expect(fakeWindow.removeEventListener).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it.each(['host', 'preview', 'browser-preview', 'foreign-origin', 'synthetic'] as const)('validates %s messages when VS Code hides the parent window', mode => {
    let guard!: (event: MessageEvent) => void;
    const source = {};
    const origin = 'vscode-webview://dashboard';
    const fakeWindow = {
      parent: undefined as unknown,
      location: {protocol: mode === 'browser-preview' ? 'http:' : 'vscode-webview:', origin},
      addEventListener: vi.fn((type, listener, capture) => { if (type === 'message' && capture) guard = listener; }),
      removeEventListener: vi.fn()
    };
    fakeWindow.parent = fakeWindow;
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', {querySelectorAll: () => mode === 'preview' ? [{contentWindow: source}] : []});
    effectMock.mockImplementationOnce(callback => callback());
    useDashboardHostSync({handleHostMessage: vi.fn(), handleEscape: () => false});
    const stopImmediatePropagation = vi.fn();
    guard({source, origin: mode === 'foreign-origin' ? 'https://preview.example' : origin, isTrusted: mode !== 'synthetic', stopImmediatePropagation} as unknown as MessageEvent);
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(mode === 'host' ? 0 : 1);
  });
});
