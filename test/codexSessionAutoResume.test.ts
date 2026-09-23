import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_RESUME_SESSION_IDS_KEY,
  consumePersistedCodexSessionIds,
  formatAutoResumeResult,
  persistRunningCodexSessions,
  resumePersistedCodexSessions
} from "../src/services/codexSessionAutoResume";

function createContext(initial?: unknown) {
  let value = initial;
  return {
    context: {
      workspaceState: {
        get: vi.fn(() => value),
        update: vi.fn(async (_key: string, next: unknown) => {
          value = next;
        })
      }
    } as never,
    read: () => value
  };
}

describe("Codex session auto resume", () => {
  beforeEach(() => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => (key === "autoResumeEnabled" ? true : fallback))
    } as never);
  });

  it("persists running sessions with Session Integration disabled", async () => {
    const state = createContext();
    const ids = await persistRunningCodexSessions(state.context, async () => ["session-1", "session-4", "session-1"]);

    expect(ids).toEqual(["session-1", "session-4"]);
    expect(state.read()).toEqual(ids);
    expect(state.context.workspaceState.update).toHaveBeenCalledWith(AUTO_RESUME_SESSION_IDS_KEY, ids);
  });

  it("clears stale state without reading sessions when auto resume is disabled", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback)
    } as never);
    const state = createContext(["stale-session"]);
    const readSessions = vi.fn();

    await expect(persistRunningCodexSessions(state.context, readSessions)).resolves.toEqual([]);
    expect(readSessions).not.toHaveBeenCalled();
    expect(state.read()).toBeUndefined();
  });

  it("restores stored sessions with Session Integration disabled", async () => {
    const state = createContext(["session-1"]);
    const openSession = vi.fn();

    await expect(resumePersistedCodexSessions(state.context, openSession)).resolves.toEqual({
      attempted: 1,
      opened: 1,
      failed: []
    });
    expect(openSession).toHaveBeenCalledWith("session-1");
    expect(state.read()).toBeUndefined();
  });

  it("does not restore stored sessions after Auto Resume is turned off", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback)
    } as never);
    const state = createContext(["session-1"]);
    const openSession = vi.fn();

    await expect(resumePersistedCodexSessions(state.context, openSession)).resolves.toEqual({
      attempted: 0,
      opened: 0,
      failed: []
    });
    expect(openSession).not.toHaveBeenCalled();
    expect(state.read()).toBeUndefined();
  });

  it("consumes stored IDs before opening every session and reports partial failures", async () => {
    const state = createContext(["session-1", "session-2"]);
    const openSession = vi.fn(async (sessionId: string) => {
      if (sessionId === "session-2") throw new Error("editor unavailable");
    });

    await expect(resumePersistedCodexSessions(state.context, openSession)).resolves.toEqual({
      attempted: 2,
      opened: 1,
      failed: [{ sessionId: "session-2", message: "editor unavailable" }]
    });
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(state.read()).toBeUndefined();
  });

  it("trims and deduplicates persisted state and produces visible completion copy", async () => {
    const state = createContext(["session-1", " session-1 ", 42, "", null]);
    await expect(consumePersistedCodexSessionIds(state.context)).resolves.toEqual(["session-1"]);
    expect(formatAutoResumeResult({ attempted: 1, opened: 1, failed: [] })).toBe(
      "Auto resume reopened 1 running VS Code Codex session."
    );
    expect(
      formatAutoResumeResult({
        attempted: 2,
        opened: 1,
        failed: [{ sessionId: "session-2", message: "editor unavailable" }]
      })
    ).toContain("session-2 (editor unavailable)");
    expect(formatAutoResumeResult({ attempted: 0, opened: 0, failed: [] })).toBeUndefined();
  });
});
