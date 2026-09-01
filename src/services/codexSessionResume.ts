import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createHash } from "crypto";
import * as readline from "readline";
import type {
  DashboardCliComposerConfig,
  DashboardCliSessionMessage,
  DashboardCliSessionSummary,
  DashboardCliSandboxMode
} from "../domain/dashboard/types";
import {
  CrossWindowOperationBusyError,
  runCrossWindowExclusive
} from "../utils/crossWindowOperations";
import { recordPersistentEvent } from "../utils/persistentLog";
import { readSafeFileSnapshot } from "../utils/safeFileReads";

const CODEX_EXTENSION_ID = "openai.chatgpt";
const CODEX_CONVERSATION_VIEW_TYPE = "chatgpt.conversationEditor";
const CODEX_CONVERSATION_SCHEME = "openai-codex";
const CODEX_CONVERSATION_AUTHORITY = "route";
const SESSION_INDEX_FILE = "session_index.jsonl";
const RUNNING_TURNS_FILE = "codex-manager-running-turns.json";
const SESSION_DIRECTORY = "sessions";
const SESSION_LOCK_DIRECTORY = "thread-writer-locks";
const MAX_SESSION_INDEX_BYTES = 5 * 1024 * 1024;
const MAX_SESSION_TRANSCRIPT_READ_BYTES = 25 * 1024 * 1024;
const MAX_VISIBLE_CLI_SESSIONS = 30;
const MAX_VISIBLE_SESSION_MESSAGES = 250;
const MAX_SESSION_MESSAGE_CHARS = 12_000;
const MAX_SESSION_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_SCAN_ENTRIES = 10_000;
const MAX_MODELS_CACHE_BYTES = 5 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CLI_PROMPT_CHARS = 64_000;
const MAX_CLI_OUTPUT_BYTES = 2 * 1024 * 1024;
const CLI_TURN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TRACKED_TURN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_CLI_TURNS = 30;
const MAX_RUNNING_TURNS_BYTES = 256 * 1024;
const JOURNAL_LOCK_RETRIES = 5;
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const APP_SERVER_MODEL_LIST_TIMEOUT_MS = 5_000;
const CLI_AVAILABILITY_TIMEOUT_MS = 10_000;
const CLI_UTILITY_TIMEOUT_MS = 30_000;
const CLI_AVAILABILITY_CACHE_TTL_MS = 60_000;
const CLI_UNAVAILABLE_CACHE_TTL_MS = 5_000;
const CLI_MODEL_LIST_CACHE_TTL_MS = 60_000;
const CLI_MODEL_LIST_FAILURE_TTL_MS = 5_000;
const CLI_TRANSCRIPT_PATH_CACHE_TTL_MS = 60_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Codex model IDs may be provider-qualified (for example 9router's
// `cx/gpt-5.2-codex`). They are passed as argv values, never shell text.
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const REASONING_EFFORT_PATTERN = /^(minimal|low|medium|high|xhigh|max|ultra)$/;
const activeCliTurns = new Map<string, ChildProcessWithoutNullStreams>();
let runningTurnWrite: Promise<void> = Promise.resolve();
let cliAvailabilityCache: { key: string; available: boolean; checkedAt: number } | undefined;
let cliAvailabilityProbe: Promise<boolean> | undefined;
let cliAvailabilityProbeKey: string | undefined;
let cliModelListCache: { codexHome: string; models: DashboardCliComposerConfig["models"]; fetchedAt: number } | undefined;
let cliModelListProbe: Promise<DashboardCliComposerConfig["models"]> | undefined;
let cliModelListProbeHome: string | undefined;
const cliTranscriptPathCache = new Map<string, { path?: string; expiresAt: number }>();
type CliTranscriptMessageCache = {
  size: number;
  mtimeMs: number;
  offset: number;
  remainder: Buffer;
  nextSequence: number;
  messages: DashboardCliSessionMessage[];
  windowed: boolean;
};
type CliTranscriptReadResult = {
  messages: DashboardCliSessionMessage[];
  transcriptBytes: number;
  bytesRead: number;
  cacheHit: boolean;
  partialLine: boolean;
  windowed: boolean;
};
const cliTranscriptMessageCache = new Map<string, CliTranscriptMessageCache>();
const cliTranscriptMetadataCache = new Map<string, {
  projectPath?: string;
  sessionSurface?: DashboardCliSessionSummary["sessionSurface"];
  expiresAt: number;
}>();
const CLI_TRANSCRIPT_METADATA_CACHE_TTL_MS = 60_000;
let cliExecutableCache: { signature: string; executable: CodexCliExecutable; resolvedAt: number } | undefined;

export class CodexCliTurnCancelledError extends Error {
  constructor() {
    super("Codex stopped this turn before it completed.");
    this.name = "CodexCliTurnCancelledError";
  }
}

export type TrackedCliTurn = {
  id: string;
  projectPath: string;
  startedAt: number;
  ownerPid?: number;
  childPid?: number;
  observedRunning?: boolean;
};

type CliSessionIndexEntry = { id: string; thread_name?: string; updated_at?: string };

/** Read local Codex session metadata without resuming or subscribing to a thread. */
export async function readCodexCliSessions(
  codexHome = resolveCodexHome(),
  limit = MAX_VISIBLE_CLI_SESSIONS
): Promise<DashboardCliSessionSummary[]> {
  const entries = await readCodexCliSessionIndex(codexHome);
  if (!entries.length) return [];
  const archivedIds = await readArchivedSessionIds(codexHome);
  const cappedLimit = Math.max(1, Math.min(MAX_VISIBLE_CLI_SESSIONS, Math.round(limit)));
  const activeEntries = entries.filter((entry) => !archivedIds.has(entry.id)).slice(0, cappedLimit);
  const archivedEntries = entries.filter((entry) => archivedIds.has(entry.id)).slice(0, cappedLimit);
  const visibleEntries = [...activeEntries, ...archivedEntries];
  // Only scan transcripts that can actually be rendered. Large histories may
  // contain thousands of index entries while the dashboard shows at most 30
  // active and 30 archived sessions.
  const transcriptPaths = await findCliSessionTranscripts(
    codexHome,
    new Set(visibleEntries.map((entry) => entry.id))
  );
  return Promise.all(
    visibleEntries.map((entry) =>
      toCliSessionSummary(codexHome, entry, archivedIds.has(entry.id), transcriptPaths.get(entry.id))
    )
  );
}

export async function readCodexCliSessionSummary(
  sessionId: string,
  codexHome = resolveCodexHome()
): Promise<DashboardCliSessionSummary | undefined> {
  validateSessionId(sessionId);
  const entry = (await readCodexCliSessionIndex(codexHome)).find((candidate) => candidate.id === sessionId);
  if (!entry) return undefined;
  const [archivedIds, transcriptPaths] = await Promise.all([
    readArchivedSessionIds(codexHome),
    findCliSessionTranscripts(codexHome, new Set([sessionId]))
  ]);
  return toCliSessionSummary(codexHome, entry, archivedIds.has(entry.id), transcriptPaths.get(entry.id));
}

async function readCodexCliSessionIndex(codexHome: string): Promise<CliSessionIndexEntry[]> {
  const indexPath = path.join(codexHome, SESSION_INDEX_FILE);
  let snapshot;
  try {
    snapshot = await readSafeFileSnapshot(indexPath, {
      maxBytes: MAX_SESSION_INDEX_BYTES,
      rejectIfLarger: true
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    if ((error as Error)?.name === "SafeFileReadLimitError") {
      throw new Error("The session index is too large to read safely.");
    }
    throw error;
  }
  const raw = snapshot.buffer.toString("utf8");
  const entries = raw
    .split(/\r?\n/)
    .map(parseCliSessionEntry)
    .filter((entry): entry is CliSessionIndexEntry => Boolean(entry))
    .sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
  const unique = new Map<string, CliSessionIndexEntry>();
  for (const entry of entries) {
    if (!unique.has(entry.id)) unique.set(entry.id, entry);
  }

  return [...unique.values()];
}

async function toCliSessionSummary(
  codexHome: string,
  entry: CliSessionIndexEntry,
  archived: boolean,
  transcriptPath?: string
): Promise<DashboardCliSessionSummary> {
  const metadata = await readCliSessionMetadata(codexHome, entry.id, transcriptPath);
  const running = !archived && await isCliSessionRunning(codexHome, entry.id, transcriptPath);
  const canStop = running && activeCliTurns.has(entry.id);
  return {
    id: entry.id,
    title: normalizeSessionTitle(entry.thread_name, entry.id),
    updatedAt: normalizeTimestamp(entry.updated_at),
    status: running ? "running" : "idle",
    ...(metadata.projectPath ? { projectPath: metadata.projectPath } : {}),
    ...(metadata.sessionSurface ? { sessionSurface: metadata.sessionSurface } : {}),
    ...(running ? { runningBy: canStop ? "Codex Manager" : "another Codex process", canStop } : {}),
    archived
  };
}

async function readCliSessionMetadata(
  codexHome: string,
  sessionId: string,
  knownTranscriptPath?: string
): Promise<{ projectPath?: string; sessionSurface?: DashboardCliSessionSummary["sessionSurface"] }> {
  const transcriptPath = knownTranscriptPath ?? (await findCliSessionTranscript(codexHome, sessionId));
  if (!transcriptPath) return {};
  const metadataKey = path.resolve(transcriptPath);
  const cached = cliTranscriptMetadataCache.get(metadataKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }
  const raw = await readSafeFileSnapshot(transcriptPath, { maxBytes: 16 * 1024 })
    .then((snapshot) => snapshot.buffer.toString("utf8"))
    .catch(() => "");
  // The first record is normally `session_meta`, but Codex versions and
  // imported transcripts have used both nested and top-level project keys.
  // Read a small bounded prefix so a persisted project is still recoverable
  // after the dashboard is reopened without scanning the whole transcript.
  let projectPath: string | undefined;
  let sessionSurface: DashboardCliSessionSummary["sessionSurface"];
  for (const line of raw.split(/\r?\n/).slice(0, 12)) {
    try {
      const value = JSON.parse(line) as {
        cwd?: unknown;
        projectPath?: unknown;
        project_path?: unknown;
        workdir?: unknown;
        workspacePath?: unknown;
        originator?: unknown;
        source?: unknown;
        payload?: Record<string, unknown>;
      };
      const candidates: Array<Record<string, unknown>> = [value.payload ?? {}, value as Record<string, unknown>];
      for (const candidate of candidates) {
        if (!sessionSurface) sessionSurface = resolveCliSessionSurface(candidate["originator"], candidate["source"]);
        for (const key of ["cwd", "projectPath", "project_path", "workdir", "workspacePath"]) {
          const candidatePath = candidate[key];
          if (!projectPath && typeof candidatePath === "string" && candidatePath.trim()) {
            projectPath = candidatePath.trim().slice(0, 1024);
          }
        }
      }
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  const metadata = { projectPath, sessionSurface, expiresAt: Date.now() + CLI_TRANSCRIPT_METADATA_CACHE_TTL_MS };
  cliTranscriptMetadataCache.set(metadataKey, metadata);
  while (cliTranscriptMetadataCache.size > 64) {
    const oldest = cliTranscriptMetadataCache.keys().next().value as string | undefined;
    if (!oldest) break;
    cliTranscriptMetadataCache.delete(oldest);
  }
  return metadata;
}

function resolveCliSessionSurface(originator: unknown, source: unknown): DashboardCliSessionSummary["sessionSurface"] {
  const sourceLabel = typeof source === "string" ? source.toLowerCase() : "";
  const originatorLabel = typeof originator === "string" ? originator.toLowerCase() : "";
  if (sourceLabel === "vscode" || originatorLabel.includes("vscode")) return "vscode";
  if (sourceLabel === "exec" || sourceLabel === "cli" || originatorLabel.includes("cli") || originatorLabel.includes("sdk")) return "cli";
  return originatorLabel || sourceLabel ? "other" : undefined;
}

export async function readCodexCliComposerConfig(
  codexHome = resolveCodexHome()
): Promise<DashboardCliComposerConfig> {
  const [modelsRaw, configRaw] = await Promise.all([
    readSmallOptionalFile(path.join(codexHome, "models_cache.json"), MAX_MODELS_CACHE_BYTES),
    readSmallOptionalFile(path.join(codexHome, "config.toml"), MAX_CONFIG_BYTES)
  ]);
  let models = parseCliModels(modelsRaw);
  // The local cache is the fast path. Newer Codex builds can expose a richer
  // live catalog through app-server (including provider-qualified IDs from
  // OpenAI-compatible routers such as 9router), so recover from that source
  // when the cache has not been created yet or contains no visible models.
  if (!models.length && path.resolve(codexHome) === path.resolve(resolveCodexHome())) {
    models = await readLiveCliModels(codexHome);
  }
  const configuredModel = readTomlString(configRaw, "model");
  const configuredEffort = readTomlString(configRaw, "model_reasoning_effort");
  const configuredSandbox = readTomlString(configRaw, "sandbox_mode");
  return {
    models,
    ...(vscode.workspace.workspaceFolders?.length ? {
      projects: vscode.workspace.workspaceFolders.map((folder) => ({
        id: folder.uri.fsPath,
        label: folder.name,
        path: folder.uri.fsPath
      }))
    } : {}),
    defaultModel: models.some((model) => model.id === configuredModel) ? configuredModel : models[0]?.id,
    defaultReasoningEffort: REASONING_EFFORT_PATTERN.test(configuredEffort ?? "")
      ? configuredEffort
      : models[0]?.defaultReasoningEffort,
    defaultSandboxMode: isCliSandboxMode(configuredSandbox) ? configuredSandbox : "workspace-write"
  };
}

export async function sendCodexCliSessionMessage(options: {
  sessionId: string;
  text: string;
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: DashboardCliSandboxMode;
  projectPath?: string;
}): Promise<void> {
  validateSessionId(options.sessionId);
  const text = options.text.trim();
  if (!text) throw new Error("Write a message before sending it to Codex.");
  if (text.length > MAX_CLI_PROMPT_CHARS) {
    throw new Error(`The message is too long. Keep it under ${MAX_CLI_PROMPT_CHARS.toLocaleString()} characters.`);
  }
  if (options.model && !MODEL_ID_PATTERN.test(options.model)) throw new Error("The selected Codex model is invalid.");
  if (options.reasoningEffort && !REASONING_EFFORT_PATTERN.test(options.reasoningEffort)) {
    throw new Error("The selected reasoning effort is invalid.");
  }
  if (options.sandboxMode && !isCliSandboxMode(options.sandboxMode)) {
    throw new Error("The selected access mode is invalid.");
  }
  await runCliSessionMutation(options.sessionId, "Codex turn", async () => {
    if (activeCliTurns.has(options.sessionId)) {
      throw new Error("Codex is already working in this session. Wait for it to finish or stop the current turn.");
    }
    const executable = await resolveCodexCliExecutable();
    const cwd = resolveCliProjectPath(options.projectPath);
    await assertUsableCliProjectPath(cwd);
    const startedAt = Date.now();
    await claimTrackedCliTurn({ id: options.sessionId, projectPath: cwd, startedAt, ownerPid: process.pid });
    const sessionRef = toSessionLogRef(options.sessionId);
    recordPersistentEvent("info", "session-resume", "Codex resume command invoked", {
      sessionRef,
      source: "dashboard-session-message",
      projectPath: cwd
    });
    const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check"];
    if (options.model) args.push("--model", options.model);
    if (options.reasoningEffort) args.push("--config", `model_reasoning_effort=\"${options.reasoningEffort}\"`);
    if (options.sandboxMode) args.push("--sandbox", options.sandboxMode);
    args.push("resume", options.sessionId, "-");

    await new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(executable.command, [...executable.prefixArgs, ...args], {
          cwd,
          env: process.env,
          windowsHide: true,
          shell: executable.shell,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (error) {
        const launchError = error instanceof Error ? error : new Error(String(error));
        void forgetTrackedCliTurn(options.sessionId, startedAt).catch(() => undefined);
        recordPersistentEvent("error", "session-resume", "Codex resume command failed to start", {
          sessionRef,
          reason: launchError.message
        }, launchError);
        reject(launchError);
        return;
      }
      activeCliTurns.set(options.sessionId, child);
      if (child.pid) {
        void rememberTrackedCliTurn({
          id: options.sessionId,
          projectPath: cwd,
          startedAt,
          ownerPid: process.pid,
          childPid: child.pid
        }).catch((journalError) => {
          console.warn("[codexManager] unable to record the CLI child process", journalError);
          recordPersistentEvent("error", "session-resume", "CLI child process could not be recorded in the recovery journal", {
            sessionRef,
            reason: journalError instanceof Error ? journalError.message : String(journalError)
          }, journalError);
        });
      }
      let stderr = "";
      let timedOut = false;
      let resultSettled = false;
      const settleResult = (callback: () => void): void => {
        if (resultSettled) return;
        resultSettled = true;
        clearTimeout(timeout);
        callback();
      };
      const cleanupProcess = async (): Promise<void> => {
        activeCliTurns.delete(options.sessionId);
        await forgetTrackedCliTurn(options.sessionId, startedAt).catch((cleanupError) => {
          console.warn("[codexManager] unable to clear the completed CLI turn journal entry", cleanupError);
          recordPersistentEvent("error", "session-resume", "Completed CLI recovery record could not be cleared", {
            sessionRef,
            reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }, cleanupError);
        });
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
        const error = new Error("Codex did not finish within 15 minutes. The turn was stopped; try a smaller request.");
        recordPersistentEvent("error", "session-resume", "Codex resume command timed out", {
          sessionRef,
          reason: error.message
        }, error);
        // Resolve the dashboard action immediately instead of waiting forever
        // for a misbehaving process to acknowledge the stop signal. The child
        // stays registered until its close/error event, preventing a new turn.
        settleResult(() => reject(error));
      }, CLI_TURN_TIMEOUT_MS);
      // Keep stdout drained so a verbose JSON event stream cannot block the child process.
      child.stdout.on("data", () => undefined);
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stderr, "utf8") < MAX_CLI_OUTPUT_BYTES) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        void cleanupProcess().then(() => {
          if (resultSettled) return;
          recordPersistentEvent("error", "session-resume", "Codex resume command failed to start", {
            sessionRef,
            reason: error.message
          }, error);
          settleResult(() => reject(error));
        });
      });
      child.on("close", (code, signal) => {
        void cleanupProcess().then(() => {
          if (resultSettled) return;
          if (signal !== null && !timedOut) {
            const error = new CodexCliTurnCancelledError();
            recordPersistentEvent("warning", "session-resume", "Codex resume command was cancelled", {
              sessionRef,
              reason: error.message
            }, error);
            settleResult(() => reject(error));
          } else if (code === 0) {
            recordPersistentEvent("info", "session-resume", "Codex resume command completed successfully", {
              sessionRef,
              exitCode: code
            });
            settleResult(resolve);
          } else {
            const error = new Error(normalizeCliError(stderr) || `Codex exited with code ${code ?? "unknown"}.`);
            recordPersistentEvent("error", "session-resume", "Codex resume command failed", {
              sessionRef,
              exitCode: code,
              signal,
              reason: error.message
            }, error);
            settleResult(() => reject(error));
          }
        });
      });
      child.stdin.on("error", (error) => {
        if (resultSettled) return;
        child.kill();
        const writeError = new Error(`Codex could not receive the prompt: ${error.message}`);
        recordPersistentEvent("error", "session-resume", "Codex prompt write failed", {
          sessionRef,
          reason: writeError.message
        }, error);
        settleResult(() => reject(writeError));
      });
      try {
        child.stdin.end(text, "utf8");
      } catch (error) {
        child.kill();
        const detail = error instanceof Error ? error.message : String(error);
        const writeError = new Error(`Codex could not receive the prompt: ${detail}`);
        recordPersistentEvent("error", "session-resume", "Codex prompt write failed", {
          sessionRef,
          reason: writeError.message
        }, error);
        settleResult(() => reject(writeError));
      }
    });
  });
}

async function readLiveCliModels(codexHome: string): Promise<DashboardCliComposerConfig["models"]> {
  const normalizedHome = path.resolve(codexHome);
  const now = Date.now();
  const cache = cliModelListCache;
  const cacheTtl = cache?.models.length ? CLI_MODEL_LIST_CACHE_TTL_MS : CLI_MODEL_LIST_FAILURE_TTL_MS;
  if (cache?.codexHome === normalizedHome && now - cache.fetchedAt < cacheTtl) return cache.models;
  if (cliModelListProbe && cliModelListProbeHome === normalizedHome) return cliModelListProbe;
  cliModelListProbeHome = normalizedHome;
  cliModelListProbe = (async () => {
    try {
      const response = await runCodexAppServerRequest<{ data?: unknown }>("model/list", {
        includeHidden: false,
        limit: 100
      }, APP_SERVER_MODEL_LIST_TIMEOUT_MS);
      return parseCliModels(JSON.stringify(response));
    } catch {
      // The composer can still open with an empty model list when the live
      // catalog is unavailable (for example while the CLI is signing in).
      return [];
    }
  })()
    .then((models) => {
      cliModelListCache = { codexHome: normalizedHome, models, fetchedAt: Date.now() };
      return models;
    })
    .finally(() => {
      cliModelListProbe = undefined;
      cliModelListProbeHome = undefined;
    });
  return cliModelListProbe;
}

export async function startCodexCliSession(options: {
  text: string;
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: DashboardCliSandboxMode;
  projectPath?: string;
}): Promise<string> {
  const text = options.text.trim();
  if (!text) throw new Error("Write a message before starting a Codex chat.");
  if (text.length > MAX_CLI_PROMPT_CHARS) {
    throw new Error(`The message is too long. Keep it under ${MAX_CLI_PROMPT_CHARS.toLocaleString()} characters.`);
  }
  if (options.model && !MODEL_ID_PATTERN.test(options.model)) throw new Error("The selected Codex model is invalid.");
  if (options.reasoningEffort && !REASONING_EFFORT_PATTERN.test(options.reasoningEffort)) {
    throw new Error("The selected reasoning effort is invalid.");
  }
  if (options.sandboxMode && !isCliSandboxMode(options.sandboxMode)) {
    throw new Error("The selected access mode is invalid.");
  }
  const cwd = resolveCliProjectPath(options.projectPath);
  await assertUsableCliProjectPath(cwd);
  const executable = await resolveCodexCliExecutable();
  const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check"];
  if (options.model) args.push("--model", options.model);
  if (options.reasoningEffort) args.push("--config", `model_reasoning_effort=\"${options.reasoningEffort}\"`);
  if (options.sandboxMode) args.push("--sandbox", options.sandboxMode);
  args.push("-");
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable.command, [...executable.prefixArgs, ...args], {
        cwd,
        env: process.env,
        windowsHide: true,
        shell: executable.shell,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("Codex did not start the new session within 15 minutes. Try again.")));
    }, CLI_TURN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, "utf8") < MAX_CLI_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < MAX_CLI_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        finish(() => reject(new CodexCliTurnCancelledError()));
        return;
      }
      let sessionId: string | undefined;
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const candidate = event["thread_id"] ?? event["threadId"] ??
            (event["thread"] as Record<string, unknown> | undefined)?.["id"];
          if (typeof candidate === "string" && SESSION_ID_PATTERN.test(candidate)) {
            sessionId = candidate;
            break;
          }
        } catch {
          // Ignore non-JSON diagnostics; the CLI's stderr supplies failures.
        }
      }
      if (code === 0 && sessionId) {
        finish(() => resolve(sessionId!));
      } else {
        const detail = normalizeCliError(stderr) || normalizeCliError(stdout);
        finish(() => reject(new Error(detail || `Codex exited with code ${code ?? "unknown"}.`)));
      }
    });
    child.stdin.on("error", (error) => {
      child.kill();
      finish(() => reject(new Error(`Codex could not receive the prompt: ${error.message}`)));
    });
    try {
      child.stdin.end(text, "utf8");
    } catch (error) {
      child.kill();
      finish(() => reject(new Error(`Codex could not receive the prompt: ${error instanceof Error ? error.message : String(error)}`)));
    }
  });
}

export function cancelCodexCliSessionTurn(sessionId: string): boolean {
  validateSessionId(sessionId);
  const child = activeCliTurns.get(sessionId);
  if (!child) return false;
  // Treat an already-exiting process as successfully stopped. Node can emit
  // `close` a tick after `kill()` returns false, and reporting failure here
  // would leave the dashboard showing a false error for a completed stop.
  return child.kill() || child.killed || child.exitCode !== null || child.signalCode !== null;
}

/** Open an interactive Codex session in a visible terminal. */
export async function openCodexCliSessionInVsCode(sessionId: string): Promise<void> {
  validateSessionId(sessionId);
  if (!vscode.extensions.getExtension(CODEX_EXTENSION_ID)) {
    throw new Error("Install or enable the official Codex extension before opening this session.");
  }
  await vscode.commands.executeCommand(
    "vscode.openWith",
    createLocalCodexConversationUri(sessionId),
    CODEX_CONVERSATION_VIEW_TYPE,
    vscode.ViewColumn.Active
  );
}

export async function renameCodexCliSession(sessionId: string, name: string): Promise<void> {
  validateSessionId(sessionId);
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Enter a session name before saving.");
  if (normalized.length > 160) throw new Error("Keep the session name under 160 characters.");
  await runCliSessionMutation(sessionId, "Codex session rename", () =>
    runCodexAppServerRequest("thread/name/set", { threadId: sessionId, name: normalized })
  );
}

export async function forkCodexCliSession(sessionId: string): Promise<string> {
  validateSessionId(sessionId);
  const result = await runCliSessionMutation(sessionId, "Codex session fork", () =>
    runCodexAppServerRequest<{ thread?: { id?: unknown } }>("thread/fork", {
      threadId: sessionId,
      excludeTurns: true
    })
  );
  const forkedId = result?.thread?.id;
  if (typeof forkedId !== "string" || !SESSION_ID_PATTERN.test(forkedId)) {
    throw new Error("Codex created the fork but did not return its session ID. Refresh the session list.");
  }
  return forkedId;
}

export async function archiveCodexCliSession(sessionId: string): Promise<void> {
  validateSessionId(sessionId);
  await runCliSessionMutation(sessionId, "Codex session archive", () =>
    runCodexCliUtility(["archive", sessionId], "archive the session")
  );
}

export async function unarchiveCodexCliSession(sessionId: string): Promise<void> {
  validateSessionId(sessionId);
  await runCliSessionMutation(sessionId, "Codex session restore", () =>
    runCodexCliUtility(["unarchive", sessionId], "restore the session")
  );
}

export async function deleteCodexCliSession(sessionId: string): Promise<void> {
  validateSessionId(sessionId);
  if (activeCliTurns.has(sessionId)) throw new Error("Stop the active Codex turn before deleting this session.");
  await runCliSessionMutation(sessionId, "Codex session deletion", async () => {
    if (activeCliTurns.has(sessionId)) throw new Error("Stop the active Codex turn before deleting this session.");
    await runCodexCliUtility(["delete", "--force", sessionId], "delete the session");
  });
}

export async function readCodexCliSessionMessages(
  sessionId: string,
  codexHome = resolveCodexHome()
): Promise<DashboardCliSessionMessage[]> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("The session identifier is invalid.");
  }
  const sessionRef = toSessionLogRef(sessionId);
  const startedAt = Date.now();
  recordPersistentEvent("info", "session-viewer", "Workspace session read started", {
    sessionRef,
    reader: "direct-jsonl"
  });
  try {
    const transcriptPath = await findCliSessionTranscript(codexHome, sessionId);
    if (!transcriptPath) throw new Error("The session transcript was not found on this PC.");
    const result = await readCachedCliTranscriptMessages(transcriptPath);
    recordPersistentEvent("info", "session-viewer", "Workspace session read completed", {
      sessionRef,
      reader: "direct-jsonl",
      transcriptBytes: result.transcriptBytes,
      bytesRead: result.bytesRead,
      messageCount: result.messages.length,
      cacheHit: result.cacheHit,
      partialLine: result.partialLine,
      windowed: result.windowed,
      durationMs: Date.now() - startedAt
    });
    const messages = await hydrateSessionImages(result.messages);
    recordPersistentEvent("info", "session-viewer", "Workspace session media resolved", {
      sessionRef,
      imageCount: messages.reduce((count, message) => count + (message.images?.length ?? 0), 0)
    });
    return messages;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    recordPersistentEvent("error", "session-viewer", "Workspace session read failed", {
      sessionRef,
      reader: "direct-jsonl",
      reason,
      durationMs: Date.now() - startedAt
    }, error);
    throw error;
  }
}

type AppServerThreadReadResponse = {
  thread?: {
    turns?: Array<{
      id?: unknown;
      status?: unknown;
      error?: { message?: unknown } | null;
      startedAt?: unknown;
      completedAt?: unknown;
      durationMs?: unknown;
      items?: Array<Record<string, unknown>>;
    }>;
  };
};

export function parseCodexAppServerThreadItems(value: unknown): DashboardCliSessionMessage[] {
  const response = value as AppServerThreadReadResponse;
  const output: DashboardCliSessionMessage[] = [];
  for (const [turnIndex, turn] of (response.thread?.turns ?? []).entries()) {
    const status = normalizeCliItemStatus(turn.status);
    const timestamp = unixSecondsToIso(turn.startedAt);
    for (const [itemIndex, item] of (turn.items ?? []).entries()) {
      const parsed = parseAppServerThreadItem(item, `${turnIndex}-${itemIndex}`, status, timestamp);
      if (parsed) output.push(parsed);
    }
    if (turn.error?.message && typeof turn.error.message === "string") {
      const turnId = typeof turn.id === "string" || typeof turn.id === "number" ? String(turn.id) : String(turnIndex);
      output.push({
        id: `${turnId}-error`,
        kind: "error",
        text: turn.error.message.slice(0, MAX_SESSION_MESSAGE_CHARS),
        title: "Turn failed",
        status: "failed",
        timestamp: unixSecondsToIso(turn.completedAt) ?? timestamp
      });
    }
  }
  return output;
}

function parseAppServerThreadItem(
  item: Record<string, unknown>,
  fallbackId: string,
  turnStatus: DashboardCliSessionMessage["status"],
  timestamp: string | undefined
): DashboardCliSessionMessage | undefined {
  const type = typeof item["type"] === "string" ? item["type"] : "";
  const id = typeof item["id"] === "string" ? item["id"] : fallbackId;
  // App-server marks the turn as failed when the turn-level request failed,
  // but historical child items are still completed unless they explicitly
  // carry their own status. Only an in-progress turn should inherit its
  // status; otherwise completed activities were incorrectly rendered as
  // "Failed" throughout a readable transcript.
  const inheritedStatus = turnStatus === "inProgress" ? "inProgress" : "completed";
  const status = normalizeCliItemStatus(item["status"] ?? inheritedStatus);
  const durationMs = typeof item["durationMs"] === "number" ? item["durationMs"] : undefined;
  if (type === "userMessage") {
    const content = parseUserInputs(item["content"]);
    return content.text || content.images.length
      ? { id, kind: "message", role: "user", text: content.text, images: content.images, timestamp }
      : undefined;
  }
  if (type === "agentMessage") {
    const content = parseUserInputs(item["content"]);
    const text = (typeof item["text"] === "string" ? item["text"] : (content.text || readHumanText(item["content"]) || "")).trim();
    return text || content.images.length
      ? { id, kind: "message", role: "assistant", text: text.slice(0, MAX_SESSION_MESSAGE_CHARS), ...(content.images.length ? { images: content.images } : {}), timestamp }
      : undefined;
  }
  if (type === "reasoning") {
    const summary = readStringArray(item["summary"]);
    const content = readStringArray(item["content"]);
    return { id, kind: "reasoning", title: "Reasoning", text: (summary.join("\n\n") || content.join("\n\n") || "Codex reasoned about the next step.").slice(0, MAX_SESSION_MESSAGE_CHARS), status, timestamp };
  }
  if (type === "plan") {
    return { id, kind: "plan", title: "Plan", text: readDisplayText(item["text"], "Codex prepared a plan."), status, timestamp };
  }
  if (type === "commandExecution") {
    const command = readCommandText(item["command"] ?? item["cmd"] ?? item["argv"]);
    const output = typeof item["aggregatedOutput"] === "string" ? item["aggregatedOutput"].slice(0, MAX_SESSION_MESSAGE_CHARS) : undefined;
    return {
      id,
      kind: "command",
      title: status === "inProgress" ? "Running command" : status === "failed" ? "Command failed" : "Ran command",
      text: command,
      command,
      cwd: typeof item["cwd"] === "string" ? item["cwd"] : undefined,
      output,
      exitCode: typeof item["exitCode"] === "number" ? item["exitCode"] : undefined,
      durationMs,
      status,
      timestamp
    };
  }
  if (type === "fileChange") {
    const changes = parseCliFileChanges(item["changes"]);
    return { id, kind: "file-change", title: status === "inProgress" ? "Editing files" : `Edited ${changes.length} ${changes.length === 1 ? "file" : "files"}`, text: changes.map((change) => change.path).join("\n") || "File changes", changes, status, timestamp };
  }
  if (type === "customToolCall" || type === "custom_tool_call") {
    const name = typeof item["name"] === "string" ? item["name"] : "tool";
    const input = typeof item["input"] === "string" ? item["input"].trim() : safeDisplayJson(item["input"]);
    const images = readImageSources(item);
    const error = readHumanError(item["error"]);
    if (images.length) return { id, kind: "image", title: "Generated image", text: `${images.length} image${images.length === 1 ? "" : "s"} generated.`, images: images.map((src) => ({ src, alt: "Generated image" })), status: error ? "failed" : status, timestamp };
    const result = readHumanText(item["result"] ?? item["output"]);
    const failed = Boolean(error) || status === "failed";
    return { id, kind: "tool-call", title: status === "inProgress" ? `Using ${name}` : failed ? `${name} failed` : `Used ${name}`, subtitle: name, text: status === "inProgress" ? `${name} is running.` : error ?? result ?? `${name} completed.`, arguments: input, result: error ?? result, debug: safeDisplayJson(item), status: failed ? "failed" : status, timestamp };
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const server = typeof item["server"] === "string" ? item["server"] : typeof item["namespace"] === "string" ? item["namespace"] : "Tool";
    const tool = typeof item["tool"] === "string" ? item["tool"] : "call";
    const error = readHumanError(item["error"]);
    const debug = safeDisplayJson({ arguments: item["arguments"], error: item["error"], result: item["result"] ?? item["contentItems"] ?? item["success"] });
    const failed = Boolean(error) || status === "failed";
    return { id, kind: "tool-call", title: status === "inProgress" ? `Using ${tool}` : failed ? `${tool} failed` : `Used ${tool}`, subtitle: server, text: error ?? `${server} used ${tool}.`, arguments: safeDisplayJson(item["arguments"]), result: error ?? readHumanText(item["result"] ?? item["contentItems"] ?? item["success"]), debug, durationMs, status: failed ? "failed" : status, timestamp };
  }
  if (type === "collabToolCall" || type === "collabAgentToolCall" || type === "subAgentActivity") {
    const tool = typeof item["tool"] === "string" ? item["tool"] : typeof item["kind"] === "string" ? item["kind"] : "Agent activity";
    return { id, kind: "collaboration", title: status === "inProgress" ? "Working with an agent" : "Agent activity", text: typeof item["prompt"] === "string" ? item["prompt"].slice(0, MAX_SESSION_MESSAGE_CHARS) : tool, subtitle: tool, status, timestamp };
  }
  if (type === "webSearch") {
    const query = typeof item["query"] === "string" ? item["query"] : safeDisplayJson(item["action"]);
    return { id, kind: "web-search", title: "Searched the web", text: query || "Web search", status: status === "unknown" ? "completed" : status, timestamp };
  }
  if (type === "imageView" || type === "ImageView" || type === "imageGeneration" || type === "ImageGeneration") {
    const viewed = type === "imageView" || type === "ImageView";
    const images = readImageSources(item).map((src) => ({ src, alt: viewed ? "Viewed image" : "Generated image" }));
    return { id, kind: "image", title: viewed ? "Viewed image" : "Generated image", text: images.length ? mediaDisplayLabel(images[0]!.src) : readDisplayText(item["path"], viewed ? "Image" : "Image generation"), ...(images.length ? { images } : {}), status, timestamp };
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    return { id, kind: "review", title: type === "enteredReviewMode" ? "Started review" : "Completed review", text: readDisplayText(item["review"], "Code review"), status, timestamp };
  }
  if (type === "contextCompaction") {
    return { id, kind: "compaction", title: "Compacted conversation", text: "Codex condensed earlier context to continue working.", status: "completed", timestamp };
  }
  if (type === "sleep") {
    return { id, kind: "tool-call", title: "Waited", text: `Waited ${formatDuration(typeof item["durationMs"] === "number" ? item["durationMs"] : 0)}.`, durationMs, status, timestamp };
  }
  return undefined;
}

function parseCliFileChanges(value: unknown): NonNullable<DashboardCliSessionMessage["changes"]> {
  if (Array.isArray(value)) {
    return value.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const detail = change as Record<string, unknown>;
      if (typeof detail["path"] !== "string") return [];
      return [{
        path: detail["path"],
        kind: typeof detail["kind"] === "string" ? detail["kind"] : "update",
        diff: typeof detail["diff"] === "string" ? detail["diff"].slice(0, MAX_SESSION_MESSAGE_CHARS) : undefined
      }];
    });
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).map(([filePath, change]) => {
    const detail = change && typeof change === "object" ? change as Record<string, unknown> : {};
    const diff = detail["diff"] ?? detail["unified_diff"];
    return {
      path: filePath,
      kind: typeof detail["kind"] === "string" ? detail["kind"] : typeof detail["type"] === "string" ? detail["type"] : "update",
      diff: typeof diff === "string" ? diff.slice(0, MAX_SESSION_MESSAGE_CHARS) : undefined
    };
  });
}

function parseUserInputs(value: unknown): { text: string; images: Array<{ src: string; alt?: string }> } {
  const parts: string[] = [];
  const images: Array<{ src: string; alt?: string }> = [];
  if (!Array.isArray(value)) return { text: "", images };
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if ((item["type"] === "text" || item["type"] === "Text" || item["type"] === "input_text" || item["type"] === "output_text") && typeof item["text"] === "string") parts.push(item["text"]);
    else if (item["type"] === "image" || item["type"] === "Image" || item["type"] === "localImage" || item["type"] === "input_image" || item["type"] === "output_image") {
      const src = readSafeImageSource(item);
      if (src) images.push({ src, alt: typeof item["alt"] === "string" ? item["alt"].slice(0, 200) : "Attached image" });
      else parts.push("[Image unavailable]");
    } else if (item["type"] === "skill" && typeof item["name"] === "string") parts.push(`[Skill: ${item["name"]}]`);
  }
  return { text: parts.join("\n\n").trim().slice(0, MAX_SESSION_MESSAGE_CHARS), images: images.slice(0, 20) };
}

function readSafeImageSource(item: Record<string, unknown>): string | undefined {
  const nested = item["image"] && typeof item["image"] === "object" ? item["image"] as Record<string, unknown> : undefined;
  // MCP and Responses image content commonly carries raw base64 in `data`
  // alongside an image MIME type rather than a complete data URL.
  const rawData = item["data"];
  const rawMime = typeof item["mimeType"] === "string" ? item["mimeType"].trim().toLowerCase() : "";
  if (typeof rawData === "string" && rawMime.startsWith("image/") && /^[a-z0-9+/=\r\n]+$/i.test(rawData.trim())) {
    const compact = rawData.replace(/\s+/g, "");
    if (compact.length > 0 && compact.length <= Math.ceil(MAX_SESSION_IMAGE_BYTES / 3) * 4) {
      return `data:${rawMime};base64,${compact}`;
    }
  }
  for (const candidate of [item["image_url"], item["imageUrl"], item["url"], item["data"], item["path"], item["output_path"], nested?.["url"], nested?.["path"]]) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (/^(?:https?:\/\/|file:\/\/|data:image\/(?:png|jpeg|jpg|gif|webp);base64,)/i.test(value) || path.isAbsolute(value)) return value;
  }
  return undefined;
}

function readImageSources(item: Record<string, unknown>): string[] {
  const sources: string[] = [];
  const visited = new Set<unknown>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const source = readSafeImageSource({ url: value });
    if (source && !sources.includes(source)) sources.push(source);
  };
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 4 || sources.length >= 20 || value === null || value === undefined) return;
    if (typeof value === "string") { add(value); return; }
    if (typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
    const record = value as Record<string, unknown>;
    add(readSafeImageSource(record));
    for (const key of ["image", "images", "result", "output", "content", "contentItems", "content_items", "data"]) visit(record[key], depth + 1);
  };
  visit(item);
  return sources.slice(0, 20);
}

function mediaDisplayLabel(source: string): string {
  try {
    const parsed = source.startsWith("file:") ? localPathFromSource(source) : source.startsWith("http") ? new URL(source).pathname : source;
    return path.basename(parsed) || "Image";
  } catch {
    return "Image";
  }
}

async function hydrateSessionImages(messages: DashboardCliSessionMessage[]): Promise<DashboardCliSessionMessage[]> {
  let totalBytes = 0;
  return Promise.all(messages.map(async (message) => {
    if (!message.images?.length) return message;
    const images: Array<{ src: string; alt?: string }> = [];
    for (const image of message.images) {
      if (/^(?:https?:\/\/|data:image\/)/i.test(image.src)) {
        images.push(image);
        continue;
      }
      if (totalBytes >= MAX_SESSION_IMAGE_TOTAL_BYTES) continue;
      let localPath: string;
      try { localPath = image.src.startsWith("file:") ? localPathFromSource(image.src) : image.src; } catch { continue; }
      try {
        const snapshot = await readSafeFileSnapshot(localPath, {
          maxBytes: MAX_SESSION_IMAGE_BYTES,
          rejectIfLarger: true
        });
        if (totalBytes + snapshot.size > MAX_SESSION_IMAGE_TOTAL_BYTES) continue;
        totalBytes += snapshot.size;
        const buffer = snapshot.buffer;
        const mimeType = sniffImageMime(buffer);
        if (!mimeType) { totalBytes -= snapshot.size; continue; }
        images.push({ src: `data:${mimeType};base64,${buffer.toString("base64")}`, alt: image.alt ?? mediaDisplayLabel(image.src) });
      } catch { /* A deleted temp image is a normal unavailable preview. */ }
    }
    if (images.length) return { ...message, images };
    return message;
  }));
}

function localPathFromSource(source: string): string {
  const url = new URL(source);
  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
  return pathname.replace(/\//g, path.sep);
}

function sniffImageMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0) return "image/x-icon";
  return undefined;
}

function readStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())) : [];
}

function readDisplayText(value: unknown, fallback: string): string {
  return (typeof value === "string" && value.trim() ? value.trim() : fallback).slice(0, MAX_SESSION_MESSAGE_CHARS);
}

function readCommandText(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
    if (parts.length) return parts.join(" ").slice(0, MAX_SESSION_MESSAGE_CHARS);
  }
  if (value && typeof value === "object") {
    const command = value as Record<string, unknown>;
    const executable = readCommandText(command["command"] ?? command["cmd"] ?? command["program"] ?? command["executable"]);
    const args = readStringArray(command["args"] ?? command["arguments"] ?? command["argv"]);
    const combined = [executable === "Command" ? "" : executable, ...args].filter(Boolean).join(" ").trim();
    if (combined) return combined.slice(0, MAX_SESSION_MESSAGE_CHARS);
  }
  return "Command";
}

function safeDisplayJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.slice(0, MAX_SESSION_MESSAGE_CHARS);
  try {
    const serialized = JSON.stringify(value, null, 2);
    return typeof serialized === "string" ? serialized.slice(0, MAX_SESSION_MESSAGE_CHARS) : undefined;
  } catch {
    return "[Unserializable value]";
  }
}

function readHumanError(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  for (const key of ["message", "error", "text"]) {
    if (typeof candidate[key] === "string" && candidate[key].trim()) return candidate[key].trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  }
  const content = candidate["content"];
  if (Array.isArray(content)) {
    const text = content.find((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>)["text"] === "string") as Record<string, unknown> | undefined;
    if (typeof text?.["text"] === "string" && text["text"].trim()) return text["text"].trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  }
  return undefined;
}

function readHumanText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  if (Array.isArray(value)) {
    const parts = value.map((entry) => readHumanText(entry)).filter((entry): entry is string => Boolean(entry));
    return parts.length ? parts.join("\n\n").slice(0, MAX_SESSION_MESSAGE_CHARS) : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["message"] === "string" && candidate["message"].trim()) return candidate["message"].trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  if (typeof candidate["text"] === "string" && candidate["text"].trim()) return candidate["text"].trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  if (candidate["content"] !== undefined) return readHumanText(candidate["content"]);
  return readHumanError(value);
}

function isLegacyToolOutputFailure(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (normalizeCliItemStatus(record["status"]) === "failed" || record["error"] !== undefined) return true;
    const type = typeof record["type"] === "string" ? record["type"].toLowerCase() : "";
    if (type.includes("error") || type.includes("failure")) return true;
    return false;
  }
  if (typeof value !== "string") return false;
  const text = value.trim();
  return /^(?:execution\s+)?error\s*:/i.test(text)
    || /^error\b/i.test(text)
    || /^tool\s+(?:call\s+)?failed\b/i.test(text)
    || /^command\s+failed\b/i.test(text);
}

function normalizeCliItemStatus(value: unknown): DashboardCliSessionMessage["status"] {
  if (value === "inProgress" || value === "in_progress") return "inProgress";
  if (value === "completed" || value === "complete") return "completed";
  if (value === "failed" || value === "error") return "failed";
  if (value === "declined") return "declined";
  if (value === "interrupted" || value === "cancelled" || value === "canceled") return "interrupted";
  return "unknown";
}

function unixSecondsToIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`;
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("The session identifier is invalid.");
}

function runCliSessionMutation<T>(
  sessionId: string,
  operationLabel: string,
  task: () => Promise<T>
): Promise<T> {
  return runCrossWindowExclusive(`codex:session:${sessionId.toLowerCase()}`, operationLabel, task);
}

function resolveCliProjectPath(projectPath: string | undefined): string {
  const fallback = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  if (!projectPath) return fallback;
  const requested = path.resolve(projectPath);
  const allowed = (vscode.workspace.workspaceFolders ?? []).map((folder) => path.resolve(folder.uri.fsPath));
  if (allowed.length === 0 || allowed.some((root) => requested === root || requested.startsWith(`${root}${path.sep}`))) {
    return requested;
  }
  throw new Error("The selected project is not an open workspace folder.");
}

function isCliSandboxMode(value: string | undefined): value is DashboardCliSandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

async function readSmallOptionalFile(filePath: string, maxBytes: number): Promise<string | undefined> {
  return readSafeFileSnapshot(filePath, { maxBytes, rejectIfLarger: true })
    .then((snapshot) => snapshot.buffer.toString("utf8"))
    .catch(() => undefined);
}

/**
 * Validate the working directory before spawning Codex. A session can retain
 * a cwd that was deleted, moved to an offline drive, or replaced by a file;
 * letting the CLI discover that itself can block resume for a long time.
 */
async function assertUsableCliProjectPath(projectPath: string): Promise<void> {
  try {
    const stat = await fs.stat(projectPath);
    if (!stat.isDirectory()) throw new Error("The selected project path is not a folder.");
  } catch (error) {
    if (error instanceof Error && error.message === "The selected project path is not a folder.") throw error;
    throw new Error("The selected project folder is unavailable. Choose an open, accessible workspace folder and try again.");
  }
}

function parseCliModels(raw: string | undefined): DashboardCliComposerConfig["models"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as {
      models?: unknown;
      data?: unknown;
    };
    const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed.models) ? parsed.models : parsed.data;
    if (!Array.isArray(source)) return [];
    const models = source
      .map((value) => value as Record<string, unknown>)
      .map((model) => {
        const id = [model["slug"], model["id"], model["model"]].find(
          (candidate): candidate is string => typeof candidate === "string" && MODEL_ID_PATTERN.test(candidate.trim())
        )?.trim();
        if (!id) return undefined;
        const hidden = model["hidden"] === true || model["visibility"] === "hide" || model["visibility"] === "hidden";
        const visibility = model["visibility"];
        if (hidden || (visibility !== undefined && visibility !== "list")) return undefined;
        const reasoningLevels = Array.isArray(model["supported_reasoning_levels"])
          ? model["supported_reasoning_levels"]
          : Array.isArray(model["supportedReasoningEfforts"])
            ? model["supportedReasoningEfforts"]
            : [];
        const defaultReasoning = [model["default_reasoning_level"], model["defaultReasoningEffort"]].find(
          (candidate): candidate is string => typeof candidate === "string" && REASONING_EFFORT_PATTERN.test(candidate)
        );
        const label = [model["display_name"], model["displayName"], model["name"]].find(
          (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0
        );
        return {
          id,
          label: label?.trim() ?? id,
          description: typeof model["description"] === "string" ? model["description"] : undefined,
          defaultReasoningEffort: defaultReasoning,
          reasoningEfforts: reasoningLevels
            .map((level) => {
              if (!level || typeof level !== "object") return undefined;
              const value = level as Record<string, unknown>;
              return [value["effort"], value["reasoningEffort"]].find(
                (candidate): candidate is string => typeof candidate === "string" && REASONING_EFFORT_PATTERN.test(candidate)
              );
            })
            .filter((effort): effort is string => Boolean(effort))
        };
      })
      .filter((model): model is NonNullable<typeof model> => Boolean(model))
      .map((model) => ({
        ...model,
        defaultReasoningEffort:
          model.defaultReasoningEffort ?? model.reasoningEfforts[0]
      }));
    // Routers commonly merge static, live, alias and custom catalogs. Keep the
    // first visible definition for a model ID so the picker remains stable.
    const uniqueModels = new Map<string, (typeof models)[number]>();
    for (const model of models) {
      if (!uniqueModels.has(model.id)) uniqueModels.set(model.id, model);
    }
    return [...uniqueModels.values()];
  } catch {
    return [];
  }
}

function readTomlString(raw: string | undefined, key: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*[\"']([^\"']+)[\"']\\s*(?:#.*)?$`, "m"));
  return match?.[1]?.trim();
}

type CodexCliExecutable = { command: string; prefixArgs: string[]; shell?: boolean };

/**
 * Return the executable locations that are commonly available to a user but
 * not necessarily visible in the environment of an already-running VS Code
 * process. In particular, the desktop Codex installer puts the CLI under
 * %LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin.
 */
export function getCodexCliPathCandidates(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const candidates: Array<string | undefined> = [
    environment["CODEX_CLI_PATH"]
  ];
  if (platform === "win32") {
    const localAppData = environment["LOCALAPPDATA"] ?? pathApi.join(os.homedir(), "AppData", "Local");
    const appData = environment["APPDATA"] ?? pathApi.join(os.homedir(), "AppData", "Roaming");
    const programFiles = environment["ProgramFiles"];
    const programFilesX86 = environment["ProgramFiles(x86)"];
    for (const root of [localAppData, programFiles, programFilesX86]) {
      if (!root) continue;
      candidates.push(
        pathApi.join(root, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
        pathApi.join(root, "OpenAI", "Codex", "bin", "codex.exe"),
        pathApi.join(root, "OpenAI Codex", "bin", "codex.exe")
      );
    }
    if (appData) {
      candidates.push(
        pathApi.join(appData, "npm", "codex.exe"),
        pathApi.join(appData, "npm", "codex.cmd"),
        pathApi.join(appData, "npm", "codex.bat"),
        pathApi.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      );
    }
  }
  const pathEntries = (environment["PATH"] ?? "").split(pathDelimiter).filter(Boolean);
  for (const entry of pathEntries) {
    candidates.push(
      pathApi.join(entry, platform === "win32" ? "codex.exe" : "codex"),
      ...(platform === "win32" ? [pathApi.join(entry, "codex.cmd"), pathApi.join(entry, "codex.bat")] : [])
    );
  }
  return candidates.filter((candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index);
}

async function resolveCodexCliExecutable(): Promise<CodexCliExecutable> {
  const configuredPath = (vscode.workspace.getConfiguration("codexManager").get<string>("codexCliPath", "") ?? "").trim();
  const bundledExtensionPath = vscode.extensions?.getExtension(CODEX_EXTENSION_ID)?.extensionPath;
  const signature = JSON.stringify({
    configuredPath,
    codexCliPath: process.env["CODEX_CLI_PATH"],
    localAppData: process.env["LOCALAPPDATA"],
    appData: process.env["APPDATA"],
    path: process.env["PATH"],
    bundledExtensionPath
  });
  if (cliExecutableCache?.signature === signature && Date.now() - cliExecutableCache.resolvedAt < CLI_AVAILABILITY_CACHE_TTL_MS) {
    const cachedCandidate = cliExecutableCache.executable.prefixArgs[0] ?? cliExecutableCache.executable.command;
    if (cachedCandidate === process.execPath || await fs.stat(cachedCandidate).then((stat) => stat.isFile()).catch(() => false)) {
      return cliExecutableCache.executable;
    }
    cliExecutableCache = undefined;
  }
  const candidates = [
    configuredPath || undefined,
    ...getCodexCliPathCandidates(),
    bundledExtensionPath
      ? path.join(
          bundledExtensionPath,
          "bin",
          process.platform === "win32"
            ? process.arch === "arm64" ? "windows-arm64" : "windows-x86_64"
            : process.platform === "darwin"
              ? process.arch === "arm64" ? "macos-aarch64" : "macos-x86_64"
              : process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64",
          process.platform === "win32" ? "codex.exe" : "codex"
        )
      : undefined
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then((stat) => stat.isFile()).catch(() => false)) {
      const extension = path.extname(candidate).toLowerCase();
      const executable = extension === ".js" || extension === ".cjs" || extension === ".mjs"
        ? { command: process.execPath, prefixArgs: [candidate] }
        : { command: candidate, prefixArgs: [], shell: extension === ".cmd" || extension === ".bat" };
      cliExecutableCache = { signature, executable, resolvedAt: Date.now() };
      return executable;
    }
  }
  if (process.platform === "win32") {
    const npmScript = process.env["APPDATA"]
      ? path.join(process.env["APPDATA"], "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      : undefined;
    if (npmScript && await fs.stat(npmScript).then((stat) => stat.isFile()).catch(() => false)) {
      const executable = { command: process.execPath, prefixArgs: [npmScript] };
      cliExecutableCache = { signature, executable, resolvedAt: Date.now() };
      return executable;
    }
  }
  return { command: "codex", prefixArgs: [] };
}

/** Check whether the Codex CLI can be launched on this PC without changing state. */
export async function isCodexCliAvailable(): Promise<boolean> {
  let executable: CodexCliExecutable;
  try {
    executable = await resolveCodexCliExecutable();
  } catch {
    return false;
  }
  const cacheKey = `${executable.command}\u0000${executable.prefixArgs.join("\u0000")}\u0000${executable.shell ? "shell" : "direct"}`;
  const now = Date.now();
  const cacheTtl = cliAvailabilityCache?.available ? CLI_AVAILABILITY_CACHE_TTL_MS : CLI_UNAVAILABLE_CACHE_TTL_MS;
  if (cliAvailabilityCache?.key === cacheKey && now - cliAvailabilityCache.checkedAt < cacheTtl) {
    return cliAvailabilityCache.available;
  }
  if (cliAvailabilityProbe && cliAvailabilityProbeKey === cacheKey) return cliAvailabilityProbe;
  cliAvailabilityProbe = probeCodexCliAvailability(executable)
    .then((available) => {
      cliAvailabilityCache = { key: cacheKey, available, checkedAt: Date.now() };
      return available;
    })
    .finally(() => {
      cliAvailabilityProbe = undefined;
      cliAvailabilityProbeKey = undefined;
    });
  cliAvailabilityProbeKey = cacheKey;
  return cliAvailabilityProbe;
}

function probeCodexCliAvailability(executable: CodexCliExecutable): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(available);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable.command, [...executable.prefixArgs, "--version"], {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        env: process.env,
        windowsHide: true,
        shell: executable.shell,
        stdio: "ignore"
      });
    } catch {
      resolve(false);
      return;
    }
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, CLI_AVAILABILITY_TIMEOUT_MS);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

async function runCodexCliUtility(args: string[], label: string): Promise<void> {
  const executable = await resolveCodexCliExecutable();
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable.command, [...executable.prefixArgs, ...args], {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        env: process.env,
        windowsHide: true,
        shell: executable.shell
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`Codex did not ${label} within 30 seconds. Try again.`)));
    }, CLI_UTILITY_TIMEOUT_MS);
    // Some CLI versions write progress to stdout. Drain it even though utility
    // actions only need the exit code, otherwise a full pipe can deadlock.
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < MAX_CLI_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => code === 0
      ? resolve()
      : reject(new Error(normalizeCliError(stderr) || `Codex could not ${label}.`))));
  });
}

async function runCodexAppServerRequest<T = unknown>(
  method: string,
  params: unknown,
  timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS
): Promise<T> {
  const executable = await resolveCodexCliExecutable();
  return new Promise<T>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable.command, [...executable.prefixArgs, "app-server", "--stdio"], {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        env: process.env,
        windowsHide: true,
        shell: executable.shell,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const lines = readline.createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.kill();
      callback();
    };
    const write = (value: unknown): void => {
      try {
        child.stdin.write(`${JSON.stringify(value)}\n`, "utf8");
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    };
    const timeout = setTimeout(() => finish(() => reject(new Error("Codex did not respond to the session action in time."))), timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < MAX_CLI_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", (error) => finish(() => reject(error)));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (!settled) finish(() => reject(new Error(normalizeCliError(stderr) || `Codex app server exited with code ${code ?? "unknown"}.`)));
    });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as {
          id?: unknown;
          method?: unknown;
          result?: unknown;
          error?: { message?: unknown };
        };
        if (message.id === 1 && Object.prototype.hasOwnProperty.call(message, "result")) {
          write({ method: "initialized" });
          write({ method, id: 2, params });
        } else if (message.id === 2) {
          if (message.error) {
            const detail = typeof message.error.message === "string" ? message.error.message : "Codex rejected the session action.";
            finish(() => reject(new Error(detail)));
          } else {
            finish(() => resolve(message.result as T));
          }
        } else if (typeof message.method === "string" && message.id !== undefined) {
          // Non-interactive requests must not deadlock if a newer app-server
          // asks for approval or another callback this client cannot service.
          write({
            id: message.id,
            error: { code: -32601, message: `Codex Manager does not support app-server request ${message.method}.` }
          });
        }
      } catch {
        // Ignore non-protocol diagnostic lines and wait for the requested response.
      }
    });
    write({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "codex-manager", title: "Codex Manager", version: "1.0.0" },
        capabilities: null
      }
    });
  });
}

function normalizeCliError(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/).filter(Boolean).slice(-4).join(" ").slice(0, 1200);
}

function parseCliSessionEntry(line: string): CliSessionIndexEntry | undefined {
  try {
    const value = JSON.parse(line) as Partial<CliSessionIndexEntry>;
    return typeof value.id === "string" && value.id.length > 0
      ? { id: value.id, thread_name: value.thread_name, updated_at: value.updated_at }
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCodexHome(): string {
  const configured = process.env["CODEX_HOME"]?.trim().replace(/^['"]|['"]$/g, "");
  return configured || path.join(os.homedir(), ".codex");
}

function normalizeSessionTitle(value: string | undefined, id: string): string {
  const title = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (title || `Codex session ${id.slice(0, 8)}`).slice(0, 160);
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/** Read the local journal of dashboard-started CLI turns interrupted by a reload. */
export async function readTrackedCliTurns(codexHome = resolveCodexHome()): Promise<TrackedCliTurn[]> {
  return (await readTrackedCliTurnsWithDiagnostics(codexHome)).turns;
}

async function readTrackedCliTurnsWithDiagnostics(codexHome: string = resolveCodexHome()): Promise<{
  turns: TrackedCliTurn[];
  failure?: string;
}> {
  const filePath = path.join(codexHome, RUNNING_TURNS_FILE);
  let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { turns: [] };
    return { turns: [], failure: `recovery journal could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!stat) return { turns: [] };
  if (!stat.isFile()) return { turns: [], failure: "recovery journal path is not a file" };
  if (stat.size > MAX_RUNNING_TURNS_BYTES) return { turns: [], failure: "recovery journal is too large to read safely" };
  const raw = await fs.readFile(filePath, "utf8").catch(() => undefined);
  if (raw === undefined) return { turns: [], failure: "recovery journal could not be read" };
  if (!raw.trim()) return { turns: [] };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return { turns: [], failure: "recovery journal does not contain an array" };
    const unique = new Map<string, TrackedCliTurn>();
    for (const entry of value) {
      if (isTrackedCliTurn(entry) && !unique.has(entry.id)) unique.set(entry.id, entry);
    }
    return { turns: [...unique.values()].slice(0, MAX_TRACKED_CLI_TURNS) };
  } catch (error) {
    return { turns: [], failure: `recovery journal contains invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function claimTrackedCliTurn(turn: TrackedCliTurn): Promise<void> {
  if (await isCliSessionRunning(resolveCodexHome(), turn.id)) {
    throw new Error("Codex is already working in this session. Wait for it to finish before sending another turn.");
  }
  await updateTrackedCliTurns((turns) => {
    const existing = turns.find((candidate) => candidate.id === turn.id);
    if (existing && Date.now() - existing.startedAt <= MAX_TRACKED_TURN_AGE_MS &&
      ((existing.childPid && isProcessAlive(existing.childPid)) ||
        (!existing.childPid && existing.ownerPid && isProcessAlive(existing.ownerPid)))) {
      throw new Error("Codex is already working in this session (possibly in another VS Code window). Wait for it to finish or stop the current turn.");
    }
    return [turn, ...turns.filter((candidate) => candidate.id !== turn.id)].slice(0, MAX_TRACKED_CLI_TURNS);
  });
  recordPersistentEvent("info", "session-resume", "Session recorded for recovery", {
    sessionRef: toSessionLogRef(turn.id),
    source: "dashboard-started-turn"
  });
}

async function rememberTrackedCliTurn(turn: TrackedCliTurn): Promise<void> {
  await updateTrackedCliTurns((turns) => {
    const current = turns.find((candidate) => candidate.id === turn.id);
    if (current && current.startedAt !== turn.startedAt) return turns;
    return [turn, ...turns.filter((candidate) => candidate.id !== turn.id)].slice(0, MAX_TRACKED_CLI_TURNS);
  });
  recordPersistentEvent("info", "session-resume", "CLI recovery record updated with child process", {
    sessionRef: toSessionLogRef(turn.id),
    childProcessRecorded: turn.childPid !== undefined
  });
}

async function forgetTrackedCliTurn(sessionId: string, startedAt?: number): Promise<void> {
  await updateTrackedCliTurns((turns) => turns.filter((turn) => turn.id !== sessionId || (startedAt !== undefined && turn.startedAt !== startedAt)));
}

async function updateTrackedCliTurns(transform: (turns: TrackedCliTurn[]) => TrackedCliTurn[]): Promise<void> {
  const codexHome = resolveCodexHome();
  const filePath = path.join(codexHome, RUNNING_TURNS_FILE);
  const operation = runningTurnWrite.then(async () => {
    await runJournalExclusive(async () => {
      const tracked = await readTrackedCliTurnsWithDiagnostics(codexHome);
      if (tracked.failure) {
        throw new Error(`Cannot update the recovery journal because it is unreadable: ${tracked.failure}`);
      }
      const current = tracked.turns;
      const next = transform(current);
      await fs.mkdir(codexHome, { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(temporaryPath, JSON.stringify(next), "utf8");
        await replaceFile(temporaryPath, filePath);
      } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
  });
  runningTurnWrite = operation.catch(() => undefined);
  await operation;
}

async function runJournalExclusive(task: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runCrossWindowExclusive(
        "codex:running-turn-journal",
        "Codex CLI recovery journal update",
        task
      );
    } catch (error) {
      if (!(error instanceof CrossWindowOperationBusyError) || attempt >= JOURNAL_LOCK_RETRIES) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function replaceFile(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await fs.rm(destination, { force: true });
    await fs.rename(source, destination);
  }
}

function isTrackedCliTurn(value: unknown): value is TrackedCliTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<TrackedCliTurn>;
  return typeof turn.id === "string" && SESSION_ID_PATTERN.test(turn.id) &&
    typeof turn.projectPath === "string" && turn.projectPath.length > 0 &&
    typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt) && turn.startedAt > 0 &&
    turn.startedAt <= Date.now() + 5 * 60 * 1000 &&
    (turn.ownerPid === undefined || isValidPid(turn.ownerPid)) &&
    (turn.childPid === undefined || isValidPid(turn.childPid)) &&
    (turn.observedRunning === undefined || typeof turn.observedRunning === "boolean");
}

function isValidPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function toSessionLogRef(sessionIdOrUri: string): string {
  return createHash("sha256").update(sessionIdOrUri).digest("hex").slice(0, 12);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isCliSessionRunning(codexHome: string, sessionId: string, knownTranscriptPath?: string): Promise<boolean> {
  const lockPath = path.join(codexHome, SESSION_LOCK_DIRECTORY, `${sessionId}.lock`);
  const stat = await fs.stat(lockPath).catch(() => undefined);
  if (!stat) return false;
  // A writer lock can survive an interrupted/stopped Codex process. Treat it
  // as live only for a short lease, then require recent transcript activity
  // as corroboration instead of blocking resume for 15 minutes.
  const lockLeaseWindow = 2 * 60 * 1000;
  if (Date.now() - stat.mtimeMs < lockLeaseWindow) return true;
  const activeWindow = 5 * 60 * 1000;
  // Some CLI versions keep the lock mtime fixed while the transcript is
  // actively appended. Use a recent transcript write as a secondary signal.
  const transcript = knownTranscriptPath ?? (await findCliSessionTranscript(codexHome, sessionId));
  if (!transcript) return false;
  const transcriptStat = await fs.stat(transcript).catch(() => undefined);
  return Boolean(transcriptStat && Date.now() - transcriptStat.mtimeMs < activeWindow);
}

/** Locate all visible session transcripts in one bounded walk. The previous
 * implementation repeated the recursive walk once per session, which made a
 * large session history turn a dashboard refresh into O(sessions * files).
 */
async function findCliSessionTranscripts(codexHome: string, sessionIds: ReadonlySet<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (sessionIds.size === 0) return found;
  const homeKey = path.resolve(codexHome);
  const missing = new Set(sessionIds);
  for (const sessionId of sessionIds) {
    const cached = cliTranscriptPathCache.get(`${homeKey}\u0000${sessionId}`);
    if (cached?.path && cached.expiresAt > Date.now()) {
      found.set(sessionId, cached.path);
      missing.delete(sessionId);
    }
  }
  if (missing.size === 0) return found;
  // Push archived first so the LIFO walk examines the active session tree
  // before falling back to archived transcripts, matching the old resolver.
  const roots = [path.join(codexHome, "archived_sessions"), path.join(codexHome, SESSION_DIRECTORY)];
  const pending = [...roots];
  let scanned = 0;
  while (pending.length > 0 && scanned < MAX_SESSION_SCAN_ENTRIES && missing.size > 0) {
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_SESSION_SCAN_ENTRIES) break;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const match = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      const sessionId = match?.[0];
      if (sessionId && missing.has(sessionId)) {
        found.set(sessionId, candidate);
        missing.delete(sessionId);
        cliTranscriptPathCache.set(`${homeKey}\u0000${sessionId}`, {
          path: candidate,
          expiresAt: Date.now() + CLI_TRANSCRIPT_PATH_CACHE_TTL_MS
        });
      }
    }
  }
  return found;
}

async function findCliSessionTranscript(codexHome: string, sessionId: string): Promise<string | undefined> {
  const cacheKey = `${path.resolve(codexHome)}\u0000${sessionId}`;
  const cached = cliTranscriptPathCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.path || await fs.stat(cached.path).then((stat) => stat.isFile()).catch(() => false)) return cached.path;
    cliTranscriptPathCache.delete(cacheKey);
  }
  const root = path.join(codexHome, SESSION_DIRECTORY);
  const pending = [root];
  let scanned = 0;
  while (pending.length > 0 && scanned < MAX_SESSION_SCAN_ENTRIES) {
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_SESSION_SCAN_ENTRIES) break;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
        cliTranscriptPathCache.set(cacheKey, { path: candidate, expiresAt: Date.now() + CLI_TRANSCRIPT_PATH_CACHE_TTL_MS });
        return candidate;
      }
    }
  }
  const archived = await fs.readdir(path.join(codexHome, "archived_sessions"), { withFileTypes: true }).catch(() => []);
  const archivedEntry = archived.find(
    (entry) => !entry.isSymbolicLink() && entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)
  );
  const result = archivedEntry ? path.join(codexHome, "archived_sessions", archivedEntry.name) : undefined;
  cliTranscriptPathCache.set(cacheKey, { path: result, expiresAt: Date.now() + CLI_TRANSCRIPT_PATH_CACHE_TTL_MS });
  return result;
}

async function readArchivedSessionIds(codexHome: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const pending = [path.join(codexHome, "archived_sessions")];
  let scanned = 0;
  while (pending.length && scanned < MAX_SESSION_SCAN_ENTRIES) {
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_SESSION_SCAN_ENTRIES || entry.isSymbolicLink()) break;
      if (entry.isDirectory()) {
        pending.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const match = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (match) ids.add(match[0]);
    }
  }
  return ids;
}

async function readCachedCliTranscriptMessages(transcriptPath: string): Promise<CliTranscriptReadResult> {
  const cacheKey = path.resolve(transcriptPath);
  const cached = cliTranscriptMessageCache.get(cacheKey);
  let readMode: "cached" | "appended" | "window" = "window";
  const snapshot = await readSafeFileSnapshot(transcriptPath, {
    maxBytes: MAX_SESSION_TRANSCRIPT_READ_BYTES,
    startOffset: (stat) => {
      if (cached && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
        readMode = "cached";
        return stat.size;
      }
      if (cached && stat.size >= cached.size && stat.mtimeMs >= cached.mtimeMs &&
          stat.size - cached.offset <= MAX_SESSION_TRANSCRIPT_READ_BYTES) {
        readMode = "appended";
        return cached.offset;
      }
      readMode = "window";
      return Math.max(0, stat.size - MAX_SESSION_TRANSCRIPT_READ_BYTES);
    }
  });
  if ((readMode as string) === "cached" && cached) {
    return {
      messages: cached.messages,
      transcriptBytes: snapshot.size,
      bytesRead: 0,
      cacheHit: true,
      partialLine: cached.remainder.length > 0,
      windowed: cached.windowed
    };
  }

  let next: CliTranscriptMessageCache;
  if ((readMode as string) === "appended" && cached) {
    const combined = Buffer.concat([cached.remainder, snapshot.buffer]);
    const split = splitCompleteJsonlRecords(combined);
    let remainder = split.remainder;
    const addedMessages = parseCliTranscriptLines(split.complete.toString("utf8"), cached.nextSequence);
    const trailingText = remainder.toString("utf8");
    const trailingMessage = trailingText.trim()
      ? parseCliSessionMessage(trailingText, cached.nextSequence + addedMessages.length)
      : undefined;
    if (trailingMessage) {
      mergeCliTranscriptMessage(addedMessages, trailingMessage);
      remainder = Buffer.alloc(0);
    }
    const mergedMessages = [...cached.messages];
    for (const message of addedMessages) mergeCliTranscriptMessage(mergedMessages, message);
    next = {
      size: snapshot.endOffset,
      mtimeMs: snapshot.mtimeMs,
      offset: snapshot.endOffset,
      remainder,
      nextSequence: cached.nextSequence + addedMessages.length,
      messages: mergedMessages.slice(-MAX_VISIBLE_SESSION_MESSAGES),
      windowed: cached.windowed
    };
  } else {
    let raw = snapshot.buffer;
    if (snapshot.startOffset > 0) {
      const firstNewline = raw.indexOf(0x0a);
      raw = firstNewline >= 0 ? raw.subarray(firstNewline + 1) : Buffer.alloc(0);
    }
    const split = splitCompleteJsonlRecords(raw);
    let remainder = split.remainder;
    const messages = parseCliTranscriptLines(split.complete.toString("utf8"), 0);
    const trailingText = remainder.toString("utf8");
    const trailingMessage = trailingText.trim() ? parseCliSessionMessage(trailingText, messages.length) : undefined;
    if (trailingMessage) {
      mergeCliTranscriptMessage(messages, trailingMessage);
      remainder = Buffer.alloc(0);
    }
    next = {
      size: snapshot.endOffset,
      mtimeMs: snapshot.mtimeMs,
      offset: snapshot.endOffset,
      remainder,
      nextSequence: messages.length,
      messages: messages.slice(-MAX_VISIBLE_SESSION_MESSAGES),
      windowed: snapshot.startOffset > 0
    };
  }
  cliTranscriptMessageCache.delete(cacheKey);
  cliTranscriptMessageCache.set(cacheKey, next);
  while (cliTranscriptMessageCache.size > 32) {
    const oldest = cliTranscriptMessageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    cliTranscriptMessageCache.delete(oldest);
  }
  return {
    messages: next.messages,
    transcriptBytes: snapshot.size,
    bytesRead: snapshot.bytesRead,
    cacheHit: false,
    partialLine: next.remainder.length > 0,
    windowed: next.windowed
  };
}

function splitCompleteJsonlRecords(buffer: Buffer): { complete: Buffer; remainder: Buffer } {
  const newline = buffer.lastIndexOf(0x0a);
  return newline >= 0
    ? { complete: buffer.subarray(0, newline + 1), remainder: buffer.subarray(newline + 1) }
    : { complete: Buffer.alloc(0), remainder: buffer };
}

function parseCliTranscriptLines(raw: string, startingSequence: number): DashboardCliSessionMessage[] {
  const messages: DashboardCliSessionMessage[] = [];
  let sequence = startingSequence;
  for (const line of raw.split(/\r?\n/)) {
    const message = parseCliSessionMessage(line, sequence);
    if (!message) continue;
    if (mergeCliTranscriptMessage(messages, message)) sequence += 1;
  }
  return messages;
}

function mergeCliTranscriptMessage(messages: DashboardCliSessionMessage[], message: DashboardCliSessionMessage): boolean {
  // The JSON event stream reports an activity more than once (for example
  // item_started followed by item_completed). Replace the earlier snapshot
  // in place so the workspace shows the live command/reasoning without
  // duplicating it when the final result arrives.
  let existingIndex = message.kind && message.kind !== "message"
    ? messages.findIndex((candidate) => candidate.id === message.id && candidate.kind !== "message" && (candidate.kind === message.kind || message.kind === "image" || message.kind === "tool-call"))
    : -1;
  if (existingIndex < 0 && message.kind && message.kind !== "message" && message.kind !== "reasoning" && message.kind !== "tool-call") {
    for (let index = messages.length - 1; index >= Math.max(0, messages.length - 2); index -= 1) {
      const candidate = messages[index]!;
      if (candidate.kind === "tool-call" && candidate.status === "inProgress") { existingIndex = index; break; }
    }
  }
  if (existingIndex < 0 && (!message.kind || message.kind === "message")) {
    for (let index = messages.length - 1; index >= Math.max(0, messages.length - 3); index -= 1) {
      const candidate = messages[index]!;
      if (candidate.role === message.role && candidate.text.trim() === message.text.trim()) { existingIndex = index; break; }
    }
  }
  if (existingIndex >= 0) {
    const existing = messages[existingIndex]!;
    const images = [...(existing.images ?? [])];
    for (const image of message.images ?? []) if (!images.some((candidate) => candidate.src === image.src)) images.push(image);
    const keepConcreteActivity = existing.kind && existing.kind !== "tool-call" && message.kind === "tool-call";
    const terminalStatus = existing.status === "failed" || existing.status === "declined" || existing.status === "interrupted"
      ? existing.status
      : message.status;
    messages[existingIndex] = keepConcreteActivity
      ? { ...message, ...existing, id: existing.id, status: terminalStatus, result: message.result ?? existing.result, debug: existing.debug ?? message.debug, ...(images.length ? { images: images.slice(0, 20) } : {}) }
      : { ...existing, ...message, id: existing.id, ...(images.length ? { images: images.slice(0, 20) } : {}) };
    return false;
  }
  messages.push(message);
  return true;
}

function parseCliSessionMessage(line: string, sequence: number): DashboardCliSessionMessage | undefined {
  try {
    const value = JSON.parse(line) as {
      timestamp?: unknown;
      type?: unknown;
      payload?: Record<string, unknown>;
    };
    const timestamp = typeof value.timestamp === "string" ? normalizeTimestamp(value.timestamp) : undefined;
    const eventPayload = value.type === "event_msg" ? value.payload : undefined;
    if (eventPayload?.["type"] === "user_message") {
      return parsePersistedUserMessage(eventPayload, `${sequence}-${typeof value.timestamp === "string" ? value.timestamp : "user"}`, timestamp);
    }
    if (eventPayload && ["item_started", "item_updated", "item_completed"].includes(String(eventPayload["type"]))) {
      const item = normalizePersistedActivity(eventPayload["item"]);
      const activityTimestamp = typeof value.timestamp === "string" ? value.timestamp : "activity";
      if (!item) return undefined;
      const eventType = String(eventPayload["type"]);
      const status = eventType === "item_started"
        ? "inProgress"
        : eventType === "item_completed"
          ? "completed"
          : (normalizeCliItemStatus(item["status"]) === "unknown" ? "inProgress" : normalizeCliItemStatus(item["status"]));
      return parseAppServerThreadItem(item, `${sequence}-${activityTimestamp}`, status, timestamp);
    }
    const payload = value.type === "response_item" ? value.payload : undefined;
    if (payload?.["type"] === "custom_tool_call" || payload?.["type"] === "function_call" || payload?.["type"] === "tool_search_call") {
      const callId = typeof payload["call_id"] === "string" ? payload["call_id"] : typeof payload["id"] === "string" ? payload["id"] : `${sequence}-tool`;
      const name = typeof payload["name"] === "string" ? payload["name"] : "tool";
      const rawInput = payload["input"] ?? payload["arguments"];
      const input = typeof rawInput === "string" ? rawInput.trim() : safeDisplayJson(rawInput);
      return {
        id: callId,
        kind: "tool-call",
        title: `Using ${name}`,
        subtitle: name,
        text: input ? `${name} is running.` : `${name} is running…`,
        arguments: input,
        debug: safeDisplayJson({ name, input: rawInput, callId }),
        status: "inProgress",
        timestamp
      };
    }
    if (payload?.["type"] === "custom_tool_call_output" || payload?.["type"] === "function_call_output" || payload?.["type"] === "tool_search_output") {
      const callId = typeof payload["call_id"] === "string" ? payload["call_id"] : typeof payload["id"] === "string" ? payload["id"] : `${sequence}-tool`;
      const output = payload["output"];
      const images = readImageSources({ output });
      const outputStatus = normalizeCliItemStatus(payload["status"]);
      const failure = outputStatus === "failed" || Boolean(payload["error"]) || isLegacyToolOutputFailure(output);
      if (images.length) {
        return { id: callId, kind: "image", title: "Generated image", text: `${images.length} image${images.length === 1 ? "" : "s"} generated.`, images: images.map((src) => ({ src, alt: "Generated image" })), status: failure ? "failed" : "completed", timestamp };
      }
      const result = readHumanText(output) || "Tool completed.";
      return { id: callId, kind: "tool-call", title: failure ? "Tool failed" : "Tool completed", text: result.slice(0, MAX_SESSION_MESSAGE_CHARS), result: result.slice(0, MAX_SESSION_MESSAGE_CHARS), status: failure ? "failed" : "completed", timestamp };
    }
    const role = payload?.["role"];
    if (payload?.["type"] !== "message" || (role !== "user" && role !== "assistant")) return undefined;
    if (role === "assistant" && payload["phase"] && payload["phase"] !== "commentary" && payload["phase"] !== "final_answer") {
      return undefined;
    }
    if (!Array.isArray(payload["content"])) return undefined;
    const parts: string[] = [];
    const images: Array<{ src: string; alt?: string }> = [];
    for (const item of payload["content"]) {
      if (!item || typeof item !== "object") continue;
      const content = item as { type?: unknown; text?: unknown; image_url?: unknown; imageUrl?: unknown; url?: unknown; data?: unknown; path?: unknown };
      if ((content.type === "input_text" || content.type === "output_text") && typeof content.text === "string") {
        const text = content.text.trim();
        if (text) parts.push(text);
      } else if (content.type === "input_image" || content.type === "output_image" || content.type === "image") {
        const src = readSafeImageSource(content as Record<string, unknown>);
        if (src) images.push({ src, alt: "Attached image" });
        else parts.push("[Image unavailable]");
      }
    }
    const text = parts.join("\n\n").trim();
    if (!text && images.length === 0) return undefined;
    if (role === "user" && isInternalSessionContext(text, payload)) return undefined;
    return {
      id: `${sequence}-${typeof value.timestamp === "string" ? value.timestamp : "message"}`,
      role,
      text: text.slice(0, MAX_SESSION_MESSAGE_CHARS),
      ...(images.length ? { images: images.slice(0, 20) } : {}),
      timestamp
    };
  } catch {
    return undefined;
  }
}

function isInternalSessionContext(text: string, payload: Record<string, unknown>): boolean {
  const metadata = payload["internal_chat_message_metadata_passthrough"];
  if (metadata && typeof metadata === "object") {
    const kinds = (metadata as Record<string, unknown>)["content_item_kinds"];
    if (Array.isArray(kinds) && kinds.length > 0 && !kinds.includes("user.text") && !kinds.includes("user.image")) return true;
  }
  const trimmed = text.trimStart();
  return trimmed.startsWith("<recommended_plugins>")
    || trimmed.startsWith("<skills_instructions>")
    || trimmed.startsWith("<environment_context>")
    || trimmed.startsWith("The following is the Codex agent history whose request action you are assessing.")
    || trimmed.startsWith("The following is the Codex agent history added since your last approval assessment.");
}

function parsePersistedUserMessage(payload: Record<string, unknown>, id: string, timestamp?: string): DashboardCliSessionMessage | undefined {
  const item = payload["item"] && typeof payload["item"] === "object" ? payload["item"] as Record<string, unknown> : payload;
  const content = parseUserInputs(item["content"] ?? payload["content"]);
  const directImages: unknown[] = [
    ...(Array.isArray(payload["images"]) ? payload["images"] as unknown[] : []),
    ...(Array.isArray(payload["local_images"]) ? payload["local_images"] as unknown[] : [])
  ];
  for (const image of directImages) {
    const src = typeof image === "string" ? readSafeImageSource({ url: image }) : image && typeof image === "object" ? readSafeImageSource(image as Record<string, unknown>) : undefined;
    if (src && !content.images.some((candidate) => candidate.src === src)) content.images.push({ src, alt: "Attached image" });
  }
  const text = content.text || (typeof payload["message"] === "string" ? payload["message"].trim() : "");
  return text || content.images.length ? { id, kind: "message", role: "user", text: text.slice(0, MAX_SESSION_MESSAGE_CHARS), ...(content.images.length ? { images: content.images.slice(0, 20) } : {}), timestamp } : undefined;
}

function normalizePersistedActivity(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const persistedType = typeof item["type"] === "string" ? item["type"] : "";
  const type = ({
    Reasoning: "reasoning",
    reasoning: "reasoning",
    CommandExecution: "commandExecution",
    commandExecution: "commandExecution",
    command_execution: "commandExecution",
    FileChange: "fileChange",
    fileChange: "fileChange",
    file_change: "fileChange",
    McpToolCall: "mcpToolCall",
    mcpToolCall: "mcpToolCall",
    mcp_tool_call: "mcpToolCall",
    CollabAgentToolCall: "collabAgentToolCall",
    collabAgentToolCall: "collabAgentToolCall",
    SubAgentActivity: "subAgentActivity",
    subAgentActivity: "subAgentActivity",
    ImageView: "imageView",
    imageView: "imageView",
    ContextCompaction: "contextCompaction",
    contextCompaction: "contextCompaction",
    UserMessage: "userMessage",
    userMessage: "userMessage",
    user_message: "userMessage",
    AgentMessage: "agentMessage",
    agentMessage: "agentMessage",
    agent_message: "agentMessage",
    ImageGeneration: "imageGeneration",
    imageGeneration: "imageGeneration",
    image_generation: "imageGeneration",
    GeneratedImage: "imageGeneration",
    generatedImage: "imageGeneration",
    dynamicToolCall: "dynamicToolCall",
    DynamicToolCall: "dynamicToolCall",
    Extension: item["kind"] === "web.search" ? "webSearch" : ""
  } as Record<string, string>)[persistedType];
  if (!type) return undefined;
  const changes = item["changes"] && typeof item["changes"] === "object" && !Array.isArray(item["changes"])
    ? Object.entries(item["changes"] as Record<string, unknown>).map(([filePath, change]) => {
        const detail = change && typeof change === "object" ? change as Record<string, unknown> : {};
        return { path: filePath, kind: detail["type"] ?? "update", diff: detail["unified_diff"] };
      })
    : item["changes"];
  return {
    ...item,
    type,
    summary: item["summary"] ?? item["summary_text"],
    content: item["content"] ?? item["raw_content"],
    aggregatedOutput: item["aggregatedOutput"] ?? item["aggregated_output"] ?? item["formatted_output"],
    exitCode: item["exitCode"] ?? item["exit_code"],
    durationMs: item["durationMs"] ?? item["duration"],
    changes,
    query: item["query"] ?? item["action"]
  };
}

function createLocalCodexConversationUri(sessionId: string): vscode.Uri {
  return vscode.Uri.file(`/local/${sessionId}`).with({
    scheme: CODEX_CONVERSATION_SCHEME,
    authority: CODEX_CONVERSATION_AUTHORITY
  });
}
