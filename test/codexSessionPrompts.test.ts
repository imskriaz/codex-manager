import { describe, expect, it } from "vitest";
import type { DashboardCodexServerRequest } from "../src/domain/dashboard/types";
import { canAnswerCodexPrompt, codexPromptKey, emptyCodexPrompts, updateCodexPrompts } from "../webview-src/dashboard/codexSessionPrompts";

const prompt = (id = "question", deviceId?: string): DashboardCodexServerRequest => ({
  id, deviceId, threadId: "thread", kind: "question", title: "Question",
  questions: [{ id: "choice", header: "Choice", question: "Which layout?", isSecret: false }]
});
const seed = (request = prompt()) => updateCodexPrompts(emptyCodexPrompts, { type: "request", request });
const edit = (state = seed(), answer = "Compact", request = prompt()) => updateCodexPrompts(state, { type: "answer", key: codexPromptKey(request), questionId: "choice", answer });

describe("session approval and question state", () => {
  it("keeps identical request IDs isolated by their owning system", () => {
    const local = prompt(), remote = prompt("question", "other");
    const state = edit(updateCodexPrompts(seed(local), { type: "request", request: remote }));
    expect(state.entries[0]!.answers).toEqual({ choice: "Compact" });
    expect(state.entries[1]!.answers).toEqual({});
    expect(codexPromptKey(local)).not.toBe(codexPromptKey(remote));
    expect(codexPromptKey(prompt("a:b", "c"))).not.toBe(codexPromptKey(prompt("b", "c:a")));
  });
  it("retains answers and queue order across duplicate pushes and reconnect snapshots", () => {
    const request = prompt(), second = prompt("second");
    let state = edit(updateCodexPrompts(seed(), { type: "request", request: second }));
    state = updateCodexPrompts(state, { type: "request", request: structuredClone(request) });
    expect(state.entries.map(entry => entry.request.id)).toEqual(["question", "second"]);
    state = updateCodexPrompts(state, { type: "list", requests: [request, request, second] });
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]!.answers.choice).toBe("Compact");
  });
  it("requires answers to every question, bounds input, and preserves exact secret answers", () => {
    expect(canAnswerCodexPrompt(seed().entries[0]!)).toBe(false);
    expect(canAnswerCodexPrompt(edit().entries[0]!)).toBe(true);
    expect(canAnswerCodexPrompt(edit(seed(), "   ").entries[0]!)).toBe(false);
    const request = { ...prompt(), questions: [...prompt().questions!, { id: "secret", header: "Secret", question: "Secret?", isSecret: true }] };
    let state = edit(seed(request));
    expect(canAnswerCodexPrompt(state.entries[0]!)).toBe(false);
    state = updateCodexPrompts(state, { type: "answer", key: codexPromptKey(request), questionId: "secret", answer: "  " });
    expect(canAnswerCodexPrompt(state.entries[0]!)).toBe(true);
    expect(state.entries[0]!.answers.secret).toBe("  ");
    expect(edit(seed(), "x".repeat(9000)).entries[0]!.answers.choice).toHaveLength(8000);
    expect(canAnswerCodexPrompt({ request: { ...prompt(), questions: [] }, answers: {} })).toBe(false);
    expect(canAnswerCodexPrompt({ request: { ...prompt(), kind: "permissions" }, answers: {} })).toBe(true);
  });
  it("ignores unknown question IDs and locks submitted answers until a response arrives", () => {
    const state = updateCodexPrompts(edit(), { type: "submit", key: codexPromptKey(prompt()), responseId: "send" });
    expect(updateCodexPrompts(state, { type: "answer", key: codexPromptKey(prompt()), questionId: "choice", answer: "Other" }).entries[0]!.answers.choice).toBe("Compact");
    expect(updateCodexPrompts(state, { type: "submit", key: codexPromptKey(prompt()), responseId: "duplicate" })).toBe(state);
    expect(updateCodexPrompts(seed(), { type: "answer", key: codexPromptKey(prompt()), questionId: "unknown", answer: "Other" }).entries[0]!.answers).toEqual({});
  });
  it("keeps failed answers editable and accepts only the matching response acknowledgement", () => {
    const key = codexPromptKey(prompt());
    let state = updateCodexPrompts(edit(), { type: "submit", key, responseId: "send" });
    expect(updateCodexPrompts(state, { type: "result", responseId: "other", success: true })).toBe(state);
    state = updateCodexPrompts(state, { type: "result", responseId: "send", success: false, error: "System offline" });
    expect(state.entries[0]).toMatchObject({ answers: { choice: "Compact" }, responseId: undefined, error: "System offline" });
    expect(canAnswerCodexPrompt(state.entries[0]!)).toBe(true);
    state = updateCodexPrompts(state, { type: "submit", key, responseId: "retry" });
    state = updateCodexPrompts(state, { type: "result", responseId: "retry", success: true });
    expect(state.entries).toEqual([]);
    expect(state.responses).toEqual({});
  });
  it("blocks uncertain retries until a fresh pending-request list confirms the request", () => {
    const request = prompt(), key = codexPromptKey(request);
    let state = updateCodexPrompts(edit(), { type: "submit", key, responseId: "send" });
    state = updateCodexPrompts(state, { type: "timeout", responseId: "send" });
    expect(state.entries[0]).toMatchObject({ answers: { choice: "Compact" }, uncertain: true, responseId: undefined });
    expect(canAnswerCodexPrompt(state.entries[0]!)).toBe(false);
    expect(updateCodexPrompts(state, { type: "submit", key, responseId: "duplicate" })).toBe(state);
    state = updateCodexPrompts(state, { type: "list", requests: [request] });
    expect(canAnswerCodexPrompt(state.entries[0]!)).toBe(true);
    expect(state.entries[0]!.responseId).toBeUndefined();
    state = updateCodexPrompts(state, { type: "submit", key, responseId: "retry" });
    state = updateCodexPrompts(state, { type: "result", responseId: "send", success: false, error: "Old failure" });
    expect(state.entries[0]).toMatchObject({ responseId: "retry", error: undefined });
  });
  it("handles a late successful response without leaving a stale prompt or reviving it", () => {
    const request = prompt(), key = codexPromptKey(request);
    let state = updateCodexPrompts(edit(), { type: "submit", key, responseId: "send" });
    state = updateCodexPrompts(state, { type: "timeout", responseId: "send" });
    state = updateCodexPrompts(state, { type: "result", responseId: "send", success: true });
    expect(state.entries).toEqual([]);
    expect(updateCodexPrompts(state, { type: "request", request }).entries).toEqual([]);
    expect(updateCodexPrompts(state, { type: "list", requests: [request] }).entries).toEqual([]);
  });
  it("removes resolved, expired, and cancelled answers without touching another system", () => {
    const request = prompt(), remote = prompt("question", "remote");
    let state = edit(updateCodexPrompts(seed(), { type: "request", request: remote }));
    state = updateCodexPrompts(state, { type: "resolved", key: codexPromptKey(request) });
    expect(state.entries.map(entry => entry.request.deviceId)).toEqual(["remote"]);
    expect(updateCodexPrompts(state, { type: "request", request }).entries).toHaveLength(1);
    state = updateCodexPrompts(state, { type: "list", requests: [] });
    expect(state.entries).toEqual([]);
    expect(updateCodexPrompts(state, { type: "request", request: prompt("new") }).entries[0]!.answers).toEqual({});
  });
  it("requires a new review when request details change under the same ID", () => {
    const request = { ...prompt(), title: "Different action" };
    let state = updateCodexPrompts(edit(), { type: "request", request });
    expect(state.entries[0]).toMatchObject({ answers: {}, uncertain: true });
    expect(canAnswerCodexPrompt(state.entries[0]!)).toBe(false);
    state = updateCodexPrompts(state, { type: "list", requests: [request] });
    expect(state.entries[0]!.uncertain).toBe(false);
    expect(canAnswerCodexPrompt(state.entries[0]!)).toBe(false);
  });
  it("keeps check failures scoped to their initiating request", () => {
    const state = updateCodexPrompts(seed(), { type: "request", request: prompt("other") });
    const failed = updateCodexPrompts(state, { type: "error", key: codexPromptKey(prompt()), error: "Check timed out" });
    expect(failed.entries.map(entry => entry.error)).toEqual(["Check timed out", undefined]);
    expect(updateCodexPrompts(failed, { type: "error", key: codexPromptKey(prompt()) }).entries[0]!.error).toBeUndefined();
  });
  it("bounds retired acknowledgements and resolved IDs while retaining active responses", () => {
    let state = emptyCodexPrompts;
    for (let i = 0; i < 200; i++) {
      const request = prompt(String(i));
      state = updateCodexPrompts(state, { type: "request", request });
      state = edit(state, "Answer", request);
      state = updateCodexPrompts(state, { type: "submit", key: codexPromptKey(request), responseId: "send" + i });
      state = updateCodexPrompts(state, { type: "resolved", key: codexPromptKey(request) });
    }
    expect(Object.keys(state.responses).length).toBeLessThanOrEqual(128);
    expect(state.closed).toHaveLength(128);
    expect(state.entries).toEqual([]);
    expect(updateCodexPrompts(state, { type: "result", responseId: "constructor", success: true })).toBe(state);
  });
});
