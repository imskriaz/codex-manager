import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DashboardHostMessage } from "../src/domain/dashboard/types";

const mocks = vi.hoisted(() => ({
  home: "",
  summary: vi.fn(),
  completed: vi.fn(),
  resume: vi.fn(),
  notice: vi.fn(),
  listener: undefined as ((message: DashboardHostMessage) => void) | undefined,
  explicitPause: false,
  enabled: true
}));

vi.mock("../src/infrastructure/config/extensionSettings", () => ({
  isRuntimeModuleEnabled: () => true,
  isAutoResumeEnabled: () => mocks.enabled,
  getCodexManagerConfiguration: () => ({ get: () => true })
}));
vi.mock("../src/services/codexSessionResume", () => ({
  GOAL_CONTINUATION_TURN_NAMESPACE: "goal-continuation-turn",
  readCodexCliSessionSummary: mocks.summary,
  readCompletedCodexSessionTurns: mocks.completed,
  resumeCodexSessionGoal: mocks.resume,
  resolveCodexHome: () => mocks.home,
  CodexNativeOwnerUnavailableError: class extends Error {}
}));
vi.mock("../src/services/codexSessionAutoResumeSelection", () => ({
  readAutoResumeGoalCandidateIds: async () => ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]
}));
vi.mock("../src/services/codexSessionGoals", () => ({ isExplicitSessionGoalPause: () => mocks.explicitPause }));
vi.mock("../src/services/codexSessionLive", () => ({ availableCodexSessionLiveSlots: () => 30 }));
vi.mock("../src/services/dashboardRealtime", () => ({
  publishDashboardRealtime: mocks.notice,
  subscribeDashboardRealtime: (listener: typeof mocks.listener) => {
    mocks.listener = listener;
    return () => { mocks.listener = undefined; };
  }
}));

import { registerCodexGoalContinuation } from "../src/services/codexGoalContinuation";
import { writeCodexSessionPreference } from "../src/services/codexSessionPreferences";
import type { AccountsRepository } from "../src/storage";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { removeTestDirectory } from "./testFilesystem";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const session = { id, title: "Roadmap", status: "idle", goal: { objective: "Finish the roadmap", status: "active" } };
const resumeClaim = (_session: unknown, _signal: AbortSignal, _origin: string, _privateHost: boolean, claim: (turn: string) => boolean) => claim("turn-1");

let store: SqliteStateStore;
let subscriptions: vscode.Disposable[];
let canUseAccount: boolean;
const start = () => registerCodexGoalContinuation({ subscriptions } as vscode.ExtensionContext, {
  listAccounts: async () => [{ id: "account", isActive: true }]
} as Pick<AccountsRepository, "listAccounts">, () => canUseAccount);
const tick = () => vi.advanceTimersByTimeAsync(500);
const stop = () => subscriptions.splice(0).forEach(item => item.dispose());

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.home = await mkdtemp(path.join(tmpdir(), "codex-active-goal-"));
  store = await SqliteStateStore.open(path.join(mocks.home, "manager.sqlite"));
  configureSqliteStateStore(store);
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  mocks.enabled = true;
  mocks.explicitPause = false;
  canUseAccount = true;
  subscriptions = [];
  mocks.completed.mockResolvedValue(new Map([[id, "turn-1"]]));
  mocks.summary.mockResolvedValue(session);
  mocks.resume.mockImplementation(async (...args: Parameters<typeof resumeClaim>) => { expect(resumeClaim(...args)).toBe(true); });
});

afterEach(async () => {
  stop();
  vi.useRealTimers();
  configureSqliteStateStore(undefined);
  store.close();
  await removeTestDirectory(mocks.home);
});

it("continues a verified idle goal once per completed turn, including across host restart", async () => {
  start();
  await tick();
  expect(mocks.resume).toHaveBeenCalledOnce();
  stop();
  start();
  await tick();
  expect(mocks.resume).toHaveBeenCalledOnce();
  mocks.completed.mockResolvedValue(new Map([[id, "turn-2"]]));
  mocks.resume.mockImplementationOnce(async (_session, _signal, _origin, _connection, claim) => {
    expect(claim("turn-2")).toBe(true);
  });
  mocks.listener?.({ type: "dashboard:codex-session-live", state: { status: "completed" } } as DashboardHostMessage);
  await tick();
  expect(mocks.resume).toHaveBeenCalledTimes(2);
});

it("reports a lost start confirmation and leaves the same completed turn claimed after restart", async () => {
  mocks.resume.mockImplementationOnce(async (...args: Parameters<typeof resumeClaim>) => {
    expect(resumeClaim(...args)).toBe(true);
    throw new Error("Start confirmation timed out.");
  });
  start();
  await tick();
  expect(mocks.notice).toHaveBeenCalledWith(expect.objectContaining({ level: "warning", message: expect.stringContaining("Start confirmation timed out.") }));
  stop();
  start();
  await tick();
  expect(mocks.resume).toHaveBeenCalledOnce();
});

it.each(["paused", "stopped", "queued", "opted-out", "unowned", "interrupted", "no completion"] as const)(
  "leaves %s work idle", async outcome => {
    if (outcome === "paused") mocks.explicitPause = true;
    if (outcome === "stopped") writeCodexSessionPreference(mocks.home, id, { manualStop: true });
    if (outcome === "queued") writeCodexSessionPreference(mocks.home, id, { queue: true });
    if (outcome === "opted-out") writeCodexSessionPreference(mocks.home, id, { autoResume: false });
    if (outcome === "unowned") canUseAccount = false;
    if (outcome === "interrupted") mocks.summary.mockResolvedValue({ ...session, interrupted: true });
    if (outcome === "no completion") mocks.completed.mockResolvedValue(new Map());
    start();
    await tick();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

it("rechecks the completed turn and Pause immediately before launch", async () => {
  mocks.resume.mockImplementationOnce(async (_session, _signal, _origin, _connection, claim) => {
    expect(claim("another-turn")).toBe(false);
    mocks.explicitPause = true;
    expect(claim("turn-1")).toBe(false);
  });
  start();
  await tick();
  expect(mocks.resume).toHaveBeenCalledOnce();
});

it("honors a per-session opt-in when global Auto Resume is off", async () => {
  mocks.enabled = false;
  writeCodexSessionPreference(mocks.home, id, { autoResume: true });
  start();
  await tick();
  expect(mocks.resume).toHaveBeenCalledOnce();
});
