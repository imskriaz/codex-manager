import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessionLiveReducer, isCodexSessionLiveState, isNewerCodexSessionLiveState, MAX_CODEX_LIVE_STATE_BYTES } from "../src/domain/codexSessionLive";
import { parseCodexAppServerThreadItems } from "../src/services/codexSessionResume";
import { getCodexSessionLiveState, listCodexSessionLiveStates, reserveCodexSessionLive } from "../src/services/codexSessionLive";
import { subscribeDashboardRealtime } from "../src/services/dashboardRealtime";
import type { CodexAppServerRpc } from "../src/services/codexAppServerRpc";

const sessionId = "01a04882-d037-7a42-ad24-9afb61901199";
const streamId = "01a04882-d037-7a42-ad24-9afb61901200";
const reducer = () => new CodexSessionLiveReducer(sessionId, streamId, parseCodexAppServerThreadItems);
const params = (values: Record<string, unknown>) => ({ threadId: sessionId, turnId: "turn-1", ...values });
afterEach(() => vi.useRealTimers());

describe("Codex live current turn", () => {
  it("streams items, readable reasoning, command output and authoritative completions", () => {
    const live = reducer();
    live.started("turn-1");
    live.accept("item/started", params({ item: { id: "reply", type: "agentMessage", text: "" } }));
    live.accept("item/agentMessage/delta", params({ itemId: "reply", delta: "Hello " }));
    live.accept("item/agentMessage/delta", params({ itemId: "reply", delta: "world" }));
    expect(live.snapshot().messages[0]).toMatchObject({ id: "reply", text: "Hello world", turnId: "turn-1" });
    live.accept("item/completed", params({ item: { id: "reply", type: "agentMessage", text: "Authoritative final" } }));
    expect(live.accept("item/agentMessage/delta", params({ itemId: "reply", delta: "late" }))).toBe(false);
    expect(live.accept("item/started", params({ item: { id: "reply", type: "agentMessage", text: "duplicate" } }))).toBe(false);
    live.accept("item/started", params({ item: { id: "reason", type: "reasoning", summary: [] } }));
    live.accept("item/reasoning/summaryTextDelta", params({ itemId: "reason", summaryIndex: 0, delta: "First" }));
    live.accept("item/reasoning/summaryTextDelta", params({ itemId: "reason", summaryIndex: 1, delta: "Second" }));
    live.accept("item/started", params({ item: { id: "cmd", type: "commandExecution", command: "echo hi" } }));
    live.accept("item/commandExecution/outputDelta", params({ itemId: "cmd", delta: "hi\n" }));
    expect(live.snapshot().messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: "First\n\nSecond" }), expect.objectContaining({ output: "hi\n", status: "inProgress" })]));
    live.accept("turn/completed", params({ turn: { id: "turn-1", status: "completed" } }));
    expect(live.accept("item/started", params({ item: { id: "late", type: "agentMessage", text: "late" } }))).toBe(false);
    expect(live.snapshot().status).toBe("completed");
    expect(isCodexSessionLiveState(live.snapshot())).toBe(true);
  });

  it("rejects unrelated threads/turns and reconciles matching early completion only", () => {
    const live = reducer();
    live.accept("turn/completed", { threadId: sessionId, turn: { id: "old-turn", status: "completed" } });
    live.accept("turn/completed", { threadId: sessionId, turn: { id: "turn-1", status: "interrupted" } });
    expect(live.snapshot().status).toBe("starting");
    live.started("turn-1");
    expect(live.snapshot().status).toBe("cancelled");
    const current = reducer();
    current.started("turn-1");
    expect(current.accept("item/started", params({ threadId: streamId, item: { id: "wrong", type: "agentMessage", text: "wrong" } }))).toBe(false);
    expect(current.accept("item/started", params({ turnId: "other-turn", item: { id: "wrong", type: "agentMessage", text: "wrong" } }))).toBe(false);
  });

  it("retains plan/diff/context/rate snapshots within encoded-byte limits", () => {
    const live = reducer();
    live.started("turn-1");
    live.accept("turn/plan/updated", params({ explanation: "Approach", plan: [{ step: "Read", status: "completed" }, { step: "Implement", status: "inProgress" }] }));
    live.accept("turn/diff/updated", params({ diff: "+change" }));
    live.accept("thread/tokenUsage/updated", { threadId: sessionId, tokenUsage: { last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 20, outputTokens: 20 }, modelContextWindow: 200_000 } });
    live.accept("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 25, resetsAt: 200_000 } } });
    expect(live.snapshot()).toMatchObject({ diff: "+change", plan: { steps: [{ step: "Read", status: "completed" }, { step: "Implement", status: "inProgress" }] }, tokenUsage: { total: 100, contextWindow: 200_000 }, rateLimits: { primary: { usedPercent: 25 } } });
    for (let index = 0; index < 210; index++) live.accept("item/started", params({ item: { id: `msg-${index}`, type: "agentMessage", text: "界".repeat(15_000) } }));
    const state = live.snapshot();
    expect(state.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeLessThanOrEqual(MAX_CODEX_LIVE_STATE_BYTES);
    expect(isCodexSessionLiveState(state)).toBe(true);
  });

  it("validates nested peer state and never revives a terminal stream", () => {
    const live = reducer();
    live.started("turn-1");
    const state = live.snapshot();
    for (const override of [{ sequence: -1 }, { messages: [{ id: "x", text: "x", images: [{ src: 12 }] }] }, { tokenUsage: { input: -1 } }, { rateLimits: { primary: { usedPercent: 101 } } }, { unknown: true }]) expect(isCodexSessionLiveState({ ...state, ...override })).toBe(false);
    expect(isNewerCodexSessionLiveState({ ...state, sequence: state.sequence + 1 }, state)).toBe(true);
    expect(isNewerCodexSessionLiveState({ ...state, streamId: sessionId }, state)).toBe(false);
    expect(isNewerCodexSessionLiveState({ ...state, sequence: state.sequence + 1 }, { ...state, status: "completed" })).toBe(false);
    const next = new CodexSessionLiveReducer(sessionId, sessionId, parseCodexAppServerThreadItems, state.updatedAt);
    expect(isNewerCodexSessionLiveState(next.snapshot(), state)).toBe(true);
  });
});

describe("bounded live registry", () => {
  it("coalesces updates, flushes terminal state immediately, and replays it until expiry", () => {
    vi.useFakeTimers();
    let notify!: (method: string, params: unknown) => void;
    const rpc = { onNotification: (listener: typeof notify) => { notify = listener; return vi.fn(); }, onDisconnect: () => vi.fn() } as unknown as CodexAppServerRpc;
    const events: unknown[] = [];
    const off = subscribeDashboardRealtime((event) => { if (event.type === "dashboard:codex-session-live") events.push(event); });
    const live = reserveCodexSessionLive();
    try {
      live.attach(sessionId, rpc, parseCodexAppServerThreadItems);
      live.started("turn-1");
      const before = events.length;
      notify("item/started", params({ item: { id: "reply", type: "agentMessage", text: "" } }));
      for (const delta of ["one", "two", "three"]) notify("item/agentMessage/delta", params({ itemId: "reply", delta }));
      expect(events).toHaveLength(before);
      vi.advanceTimersByTime(100);
      expect(events).toHaveLength(before + 1);
      notify("turn/completed", params({ turn: { id: "turn-1", status: "completed" } }));
      expect(getCodexSessionLiveState(sessionId)?.status).toBe("completed");
      expect(listCodexSessionLiveStates()).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId })]));
      vi.advanceTimersByTime(5 * 60_000);
      expect(getCodexSessionLiveState(sessionId)).toBeUndefined();
    } finally { live.dispose(); off(); }
  });

  it("refuses a full registry before provider mutation and releases capacity on failure", () => {
    const reservations = Array.from({ length: 30 }, () => reserveCodexSessionLive());
    try { expect(() => reserveCodexSessionLive()).toThrow(/30 turns/); }
    finally { reservations.forEach((reservation) => reservation.dispose()); }
    const reservation = reserveCodexSessionLive();
    reservation.dispose();
    reservation.dispose();
  });
});
