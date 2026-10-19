import { describe, expect, it } from "vitest";
import type { DashboardCliSessionMessage, DashboardCodexSessionLiveState } from "../src/domain/dashboard/types";
import { acceptCliLiveState, combineCliLiveMessages, isCliTurnActive, isCliLiveStateCurrent, reconcileCliSessionStatus } from "../webview-src/dashboard/cliSessionLiveState";
import { cliSessionTargetKey } from "../webview-src/dashboard/cliSessionRoute";

const message = (id: string, text: string, turnId?: string, role: "user" | "assistant" = "assistant"): DashboardCliSessionMessage => ({ id, text, role, turnId });
const snapshot = (changes: Partial<DashboardCodexSessionLiveState> = {}): DashboardCodexSessionLiveState => ({ sessionId: "chat", streamId: "stream", sequence: 1, updatedAt: 100, status: "running", turnId: "turn", messages: [], ...changes });

describe("shared browser/native live turn reconciliation", () => {
  it("keeps saved current-turn history when the bounded live suffix has rolled forward", () => {
    const history = [message("prompt", "Do work", "turn", "user"), message("early", "Earlier activity", "turn"), message("latest", "Partial", "turn")];
    expect(combineCliLiveMessages(history, snapshot({ truncated: true, messages: [message("latest", "Updated", "turn")] })).map(item => item.text)).toEqual(["Do work", "Earlier activity", "Updated"]);
    expect(combineCliLiveMessages(history.slice(0, 2), snapshot({ truncated: true, messages: [message("latest", "Updated", "turn")] }))).toHaveLength(3);
  });
  it("keeps failed turns resumable and clears recovery when running or completed", () => {
    const row = { id: "chat", title: "Task", status: "idle" as const, interrupted: true, runningSince: 10 };
    const reconcile = (status: DashboardCodexSessionLiveState["status"]) => reconcileCliSessionStatus(row, { [cliSessionTargetKey(row)]: snapshot({ status }) });
    expect(reconcile("running")).toMatchObject({ status: "running", interrupted: false });
    expect(reconcile("completed")).toMatchObject({ status: "idle", interrupted: false, runningSince: undefined });
    expect(reconcile("cancelled").interrupted).toBe(false);
    expect(reconcile("failed")).toMatchObject({ status: "idle", interrupted: true, runningSince: undefined });
    expect(reconcile("disconnected")).toBe(row);
  });
  it("uses a newer verified idle row over an old running snapshot for counts, spinners, and steering", () => {
    const row = { id: "chat", title: "Task", status: "idle" as const, locked: false, updatedAt: new Date(2000).toISOString() };
    const live = snapshot({ updatedAt: 1000 });
    expect(isCliLiveStateCurrent(row, live)).toBe(false);
    expect(reconcileCliSessionStatus(row, { [cliSessionTargetKey(row)]: live })).toBe(row);
    expect(isCliLiveStateCurrent(row, snapshot({ updatedAt: 3000 }))).toBe(true);
    expect(isCliLiveStateCurrent({ ...row, deviceId: "other" }, live)).toBe(false);
  });
  it("honors terminal state for stale index rows without hiding a newer external turn", () => {
    const row = { id: "chat", title: "Task", status: "running" as const, locked: true };
    const states = { [cliSessionTargetKey(row)]: snapshot({ status: "completed", updatedAt: 1000 }) };
    expect(reconcileCliSessionStatus(row, states)).toMatchObject({ status: "idle", locked: false, canStop: false });
    const newer = { ...row, updatedAt: new Date(2000).toISOString() };
    expect(reconcileCliSessionStatus(newer, states)).toBe(newer);
    expect(reconcileCliSessionStatus({ ...row, deviceId: "remote" }, states).status).toBe("running");
    expect(reconcileCliSessionStatus(row, { [cliSessionTargetKey(row)]: snapshot({ status: "disconnected" }) })).toBe(row);
  });
  it("reconciles remote completion and local aliases using the live registry's target keys", () => {
    const remote = { id: "chat", deviceId: "pc:remote", title: "Task", status: "running" as const, locked: true };
    const states = { [cliSessionTargetKey(remote)]: snapshot({ deviceId: remote.deviceId, status: "completed" }) };
    expect(reconcileCliSessionStatus(remote, states)).toMatchObject({ status: "idle", locked: false });
    expect(reconcileCliSessionStatus({ ...remote, deviceId: "other" }, states).status).toBe("running");
    const local = { ...remote, deviceId: "local" };
    expect(reconcileCliSessionStatus(local, { [cliSessionTargetKey(local)]: snapshot({ status: "completed" }) }).status).toBe("idle");
  });
  it("ignores duplicate, out-of-order and obsolete stream snapshots", () => {
    const previous = snapshot();
    expect(acceptCliLiveState(previous, snapshot())).toBe(false);
    expect(acceptCliLiveState(previous, snapshot({ sequence: 0 }))).toBe(false);
    expect(acceptCliLiveState(previous, snapshot({ streamId: "old", updatedAt: 99 }))).toBe(false);
    expect(acceptCliLiveState(previous, snapshot({ sequence: 2 }))).toBe(true);
    expect(acceptCliLiveState(previous, snapshot({ streamId: "new", updatedAt: 101 }))).toBe(true);
  });
  it("does not revive terminal turns or treat disconnected turns as steering authority", () => {
    expect(acceptCliLiveState(snapshot({ status: "completed" }), snapshot({ sequence: 2 }))).toBe(false);
    expect(isCliTurnActive(snapshot({ status: "disconnected" }))).toBe(false);
    expect(acceptCliLiveState(undefined, snapshot({ sequence: NaN }))).toBe(false);
  });
  it("replaces the exact current turn suffix after reload without duplicating a repeated prompt", () => {
    const history = [message("old-prompt", "same", "old", "user"), message("old-answer", "prior", "old"), message("stored-prompt", "same", "turn", "user"), message("stored-partial", "partial", "turn")];
    const live = snapshot({ messages: [message("live-prompt", "same", "turn", "user"), message("live-answer", "latest", "turn")] });
    expect(combineCliLiveMessages(history, live).map((item) => item.id)).toEqual(["old-prompt", "old-answer", "live-prompt", "live-answer"]);
  });
  it("uses exact item ids for partial histories and preserves unrelated turns", () => {
    const history = [message("prior", "prior", "old"), message("current", "partial")];
    expect(combineCliLiveMessages(history, snapshot({ messages: [message("current", "complete")] })).map((item) => item.text)).toEqual(["prior", "complete"]);
    expect(combineCliLiveMessages([message("prior", "prior", "old")], snapshot({ messages: [message("next", "next", "turn")] })).map((item) => item.id)).toEqual(["prior", "next"]);
    expect(combineCliLiveMessages(history, undefined)).toBe(history);
  });
  it("does not erase an older unannotated turn when the next prompt repeats its text", () => {
    const history = [message("old-user", "again", undefined, "user"), message("old-answer", "prior answer")];
    const live = snapshot({ messages: [message("new-user", "again", "turn", "user")] });
    expect(combineCliLiveMessages(history, live).map((item) => item.id)).toEqual(["old-user", "old-answer", "new-user"]);
  });
});
