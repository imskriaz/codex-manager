import { beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }));
vi.mock("preact/hooks", () => ({
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => {
      hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  }
}));
import { useOAuthSessionModal } from "../webview-src/dashboard/oauthSessionHook";

beforeEach(() => { hooks.cursor = 0; hooks.slots = []; });

it("submits manually during automatic listening and blocks duplicates even if the listener fails", () => {
  const sendAction = vi.fn(() => `request-${sendAction.mock.calls.length}`);
  const render = () => {
    hooks.cursor = 0;
    return useOAuthSessionModal({ sendAction, showCopyFeedback: vi.fn(), openAuthorizationInClient: false });
  };
  let modal = render();
  modal.handlePrepareOauthLink();
  const prepared = sendAction.mock.results[0]!.value;
  modal.applyActionResult({ type: "dashboard:action-result", action: "prepareOAuthSession", requestId: prepared, status: "completed", payload: { oauthSession: { sessionId: "login", authUrl: "https://auth.example.test", redirectUri: "http://localhost/callback" } } });
  const listener = sendAction.mock.results[2]!.value;
  modal = render(); modal.setOauthCallbackUrl("http://localhost/callback?state=state&code=code");
  modal = render(); modal.handleCompleteOAuth(); modal.handleCompleteOAuth();
  expect(sendAction.mock.calls.filter(([action]) => action === "completeOAuthSession")).toHaveLength(1);
  const completion = sendAction.mock.results[3]!.value;
  modal.applyActionResult({ type: "dashboard:action-result", action: "startOAuthAutoFlow", requestId: listener, status: "failed", error: "Listener unavailable" });
  modal = render(); modal.handleCompleteOAuth();
  expect(sendAction.mock.calls.filter(([action]) => action === "completeOAuthSession")).toHaveLength(1);
  modal.applyActionResult({ type: "dashboard:action-result", action: "completeOAuthSession", requestId: completion, status: "failed", error: "Network unavailable" });
  modal = render(); modal.handleCompleteOAuth();
  expect(sendAction.mock.calls.filter(([action]) => action === "completeOAuthSession")).toHaveLength(2);
  expect(sendAction).toHaveBeenLastCalledWith("completeOAuthSession", undefined, { oauthSessionId: "login", callbackUrl: "http://localhost/callback?state=state&code=code" });
});
