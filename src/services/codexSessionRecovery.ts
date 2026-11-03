import * as fs from "node:fs/promises";
import { CodexNativeOwnerUnavailableError, observeRunningCodexSession, readCodexCliSessionSummary, readManuallyStoppedCodexSessionIds, resolveCodexHome, resumeCodexSessionGoal, sendCodexCliSessionMessage, toSessionLogRef } from "./codexSessionResume";
import { waitWithin } from "../utils/concurrency";
import { recordPersistentEvent } from "../utils/persistentLog";
import { isExplicitSessionGoalPause } from "./codexSessionGoals";
import { clearCodexSessionManualStop, readCodexSessionPreferences } from "./codexSessionPreferences";

const recovering = new Map<string, Promise<"running" | "continued" | "goal" | "idle">>();

/** Recheck after the native editor loads; never replace an active writer or resend after acceptance. */
export function resumeCodexSessionWork(sessionId: string, signal?: AbortSignal, origin: "user" | "automatic" | "queue" = "automatic", connection: "native" | "private" = "native"): Promise<"running" | "continued" | "goal" | "idle"> {
  const home = resolveCodexHome();
  const key = `${home}:${sessionId}`;
  const identity = { sessionId, sessionRef: toSessionLogRef(sessionId) };
  const pending = recovering.get(key);
  if (pending) {
    recordPersistentEvent("debug", "session-resume", "Joining pending recovery", identity);
    return pending;
  }
  recordPersistentEvent("info", "session-resume", "Post-load recovery check started", { ...identity, origin });
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const startedAt = Date.now();
  let title: string | undefined;
  let phase = "state-verification";
  let goalStatus: string | undefined;
  const work = (async () => {
    let privateFallback = connection === "private";
    let session = await waitWithin(readCodexCliSessionSummary(sessionId, home, !privateFallback), 6_000, "Session state could not be verified after opening.", controller.signal);
    controller.signal.throwIfAborted();
    if (session?.status === 'unknown' && !privateFallback) {
      const verified = await waitWithin(readCodexCliSessionSummary(sessionId, home, false), 6000, 'Private recovery state could not be verified.', controller.signal);
      if (verified?.status === 'idle' && !verified.locked) { session = verified; privateFallback = true; }
    }
    if (privateFallback) recordPersistentEvent('warning', 'session-resume', 'Using private Auto Resume fallback', { ...identity, origin, transport: 'private-app-server' });
    if (resolveCodexHome() !== home) throw new Error('The active account home changed. Recovery was kept; refresh before resuming.');
    if (!session || session.archived || session.subAgent || session.parentSessionId) throw new Error("This session is missing, archived, or belongs to a parent. Refresh before resuming.");
    title = session.title;
    goalStatus = session.goal?.status ?? (session.goal === null ? "none" : "unavailable");
    recordPersistentEvent("debug", "session-resume", "Post-load recovery state", {
      ...identity, title: session.title, projectPath: session.projectPath, status: session.status, locked: session.locked, interrupted: session.interrupted, activitySource: "official-native", goalStatus: session.goal?.status ?? (session.goal === null ? "none" : "unavailable")
    });
    if (session.status === "running") {
      observeRunningCodexSession(session);
      recordPersistentEvent("info", "session-resume", "Native session already running; no prompt sent", { ...identity, title: session.title, activitySource: "official-native", nativeRunning: true });
      return "running" as const;
    }
    if (privateFallback && session.locked) throw new Error('Another Codex writer still owns this session. Private recovery was not started.');
    if (session.status === "unknown") throw new Error("Running state could not be verified. Recovery was kept; refresh before retrying.");
    if (origin === "user") clearCodexSessionManualStop(home, sessionId);
    else if (readCodexSessionPreferences(home, [sessionId]).get(sessionId)?.manualStop ||
      (origin === "automatic" && (await readManuallyStoppedCodexSessionIds(home, [sessionId], controller.signal)).length)) {
      recordPersistentEvent("info", "session-resume", "Recovery skipped", { ...identity, origin, reason: "manual-stop", goalStatus });
      return "idle" as const;
    }
    const explicitPause = session.goal?.status === "paused" && origin !== "user" ? isExplicitSessionGoalPause(home, session.id) : undefined;
    const recoverablePausedGoal = session.goal?.status === "paused" && (origin === "user" || (session.interrupted === true && !explicitPause));
    const eligibleGoal = Boolean(session.goal && (["active", "usage_limited"].includes(session.goal.status) || recoverablePausedGoal));
    if (eligibleGoal) {
      phase = "goal-continuation";
      recordPersistentEvent("info", "session-resume", "Goal recovery requested", { ...identity, origin, goalStatus, explicitPause, interrupted: session.interrupted === true, reason: recoverablePausedGoal && goalStatus === "paused" ? "interrupted-paused-goal" : "unfinished-goal", promptKind: "none", transport: "official-native" });
      try {
        await waitWithin(resumeCodexSessionGoal(session, controller.signal, origin === "user" ? "user" : "automatic", ...(privateFallback ? [true] as const : [])), 25_000, "Goal resume was not confirmed. Check Codex before retrying.", controller.signal);
      } catch (error) {
        if (privateFallback || controller.signal.aborted || !(error instanceof CodexNativeOwnerUnavailableError)) throw error;
        const verified = await readCodexCliSessionSummary(sessionId, home, false);
        if (!verified || verified.status !== 'idle' || verified.locked) throw error;
        await waitWithin(resumeCodexSessionGoal(verified, controller.signal, origin === 'user' ? 'user' : 'automatic', true), 25_000, 'Private goal resume was not confirmed. Check Codex before retrying.', controller.signal);
      }
      recordPersistentEvent("info", "session-resume", "Goal continuation accepted", { ...identity, title: session.title });
      return "goal" as const;
    }
    if (session.goal) {
      recordPersistentEvent("info", "session-resume", "Goal left unchanged", { ...identity, title: session.title, origin, goalStatus, reason: session.goal.status === "paused" ? (explicitPause ? "explicit-pause" : "goal-paused") : "goal-not-eligible" });
      return "idle" as const;
    }
    if (session.goal === undefined) {
      const files = await waitWithin(fs.readdir(resolveCodexHome()), 2_000, "Goal storage did not respond. Recovery was kept.", controller.signal);
      controller.signal.throwIfAborted();
      if (resolveCodexHome() !== home) throw new Error('The active account home changed. Recovery was kept; refresh before resuming.');
      if (files.some(name => /^goals_\d+\.sqlite$/.test(name))) throw new Error("Goal status is unavailable. Recovery was kept to avoid sending a duplicate prompt.");
    }
    if (session.interrupted === undefined) throw new Error("Interrupted work could not be verified. Saved recovery was retained; refresh before retrying.");
    if (session.interrupted !== true) {
      recordPersistentEvent("info", "session-resume", "Session has no interrupted work", { ...identity, title });
      return "idle" as const;
    }
    phase = "non-goal-continuation";
    recordPersistentEvent("info", "session-resume", "Requesting non-goal continuation", { ...identity, title, origin, promptKind: "continue-if-not-completed", transport: "official-native" });
    let accepted!: () => void;
    let didStart = false;
    const started = new Promise<void>(resolve => { accepted = () => { didStart = true; resolve(); }; });
    const turn = sendCodexCliSessionMessage({ sessionId, text: "Continue if not completed", projectPath: session.projectPath, signal: controller.signal, onStarted: accepted, clearManualStop: origin === "user", interruptedOnly: true, ...(privateFallback ? { preferPrivate: true } : {}) });
    void turn.catch(error => recordPersistentEvent("warning", "session-resume", "Continuation turn failed", { ...identity, title: session.title }, error));
    await waitWithin(Promise.race([started, turn]), 15_000, "Continue was not confirmed. Check this session before retrying.", controller.signal);
    if (!didStart) {
      recordPersistentEvent("info", "session-resume", "Session completed before continuation; no prompt sent", { ...identity, title });
      return "idle" as const;
    }
    recordPersistentEvent("info", "session-resume", "Continue accepted", { ...identity, title: session.title });
    return "continued" as const;
  })().catch(error => {
    recordPersistentEvent("warning", "session-resume", "Post-load recovery could not be confirmed", { ...identity, title, origin, phase, goalStatus, recoveryRetained: true, durationMs: Date.now() - startedAt, cancelled: controller.signal.aborted }, error);
    throw error;
  }).finally(() => {
    controller.abort();
    signal?.removeEventListener("abort", abort);
    if (recovering.get(key) === work) recovering.delete(key);
  });
  recovering.set(key, work);
  return work;
}
