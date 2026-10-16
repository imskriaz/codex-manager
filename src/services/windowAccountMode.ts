import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { readSafeFileSnapshot } from "../utils/safeFileReads";
import * as vscode from "vscode";
import type { CodexManagerAccountRecord } from "../core/types";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";
import { readSqliteStateFile, sqliteStoreForFile, writeSqliteStateFile } from "../storage/sqliteState";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import { createKeyedMutex } from "../utils/concurrency";

const SETTING = "crossWindowAccountModeEnabled";
const REGISTRY_FILE = "window-account-slots-v1.json";
const HEARTBEAT_MS = 5_000;
const STALE_AFTER_MS = 30_000;
const HOME_DIRECTORY = "window-codex-homes-v1";

type WindowSlot = {
  slotId: string;
  accountId?: string;
  home: string;
  pid: number;
  heartbeatAt: number;
};

type Registry = { slots: WindowSlot[] };

let slot: WindowSlot | undefined;
let heartbeat: NodeJS.Timeout | undefined;
let originalHome: string | undefined;
const lifecycle = createKeyedMutex();

export function isCrossWindowAccountModeEnabled(): boolean {
  return getCodexManagerConfiguration().get<boolean>(SETTING, false) === true;
}

export function initializeCrossWindowAccountMode(): Promise<void> {
  return lifecycle.runExclusive("window-mode", initializeWindowMode);
}

async function initializeWindowMode(): Promise<void> {
  if (!isCrossWindowAccountModeEnabled() || slot) return;
  const session = vscode.env.sessionId || "unknown-session";
  const workspaceIdentity =
    vscode.workspace.workspaceFile?.toString() ??
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.toString()).sort().join("|") ??
    "empty-window";
  // Keep a window on the same isolated home when its extension host reloads.
  // The session id is stable across that reload boundary, so the selected
  // auth.json and its scoped active-account state cannot silently revert.
  const slotId = hash(`${session}:${workspaceIdentity}`).slice(0, 24);
  const home = path.join(getCodexManagerStorageRoot(), HOME_DIRECTORY, slotId);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700).catch(() => undefined);
  const initializedSlot = { slotId, home, pid: process.pid, heartbeatAt: Date.now() };
  await writeRegistry((registry) => {
    registry.slots = registry.slots.filter((candidate) => candidate.slotId !== slotId);
    registry.slots.push(initializedSlot);
  });
  originalHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = home;
  slot = initializedSlot;
  heartbeat = setInterval(() => {
    if (!slot) return;
    const currentSlot = slot;
    currentSlot.heartbeatAt = Date.now();
    void writeRegistry((registry) => {
      if (slot !== currentSlot) return;
      const current = registry.slots.find((candidate) => candidate.slotId === currentSlot.slotId);
      if (current) Object.assign(current, currentSlot);
      else registry.slots.push(currentSlot);
    }).catch((error) => console.warn("[codexManager] parallel window heartbeat failed:", error));
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

export function disposeCrossWindowAccountMode(): Promise<void> {
  return lifecycle.runExclusive("window-mode", disposeWindowMode);
}

async function disposeWindowMode(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  if (!slot) return;
  if (slot) {
    const released = slot.slotId;
    slot = undefined;
    await writeRegistry((registry) => {
      registry.slots = registry.slots.filter((candidate) => candidate.slotId !== released);
    }).catch(() => undefined);
  }
  if (originalHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = originalHome;
  originalHome = undefined;
}

export function getCrossWindowHome(): string | undefined {
  return slot?.home;
}

export function getCrossWindowAccountId(): string | undefined {
  return slot?.accountId;
}

/** Keep another live window's current account reserved when this window switches. */
export async function readCrossWindowActiveAccountIds(): Promise<string[]> {
  if (!isCrossWindowAccountModeEnabled()) return [];
  const snapshot = await readSafeFileSnapshot(path.join(getCodexManagerStorageRoot(), REGISTRY_FILE), { maxBytes: 1024 * 1024, rejectIfLarger: true })
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!snapshot) return [];
  const value = JSON.parse(snapshot.buffer.toString("utf8")) as Partial<Registry>;
  if (!Array.isArray(value.slots) || !value.slots.every(isValidSlot)) throw new Error("Other window account state could not be verified. Its claims were retained; retry after the window registry is available.");
  return [...new Set(value.slots.filter(isLive).flatMap((candidate) => candidate.accountId ? [candidate.accountId] : []))];
}

export function claimCrossWindowAccount(accountId: string): Promise<void> {
  return lifecycle.runExclusive("window-mode", () => claimWindowAccount(accountId));
}

async function claimWindowAccount(accountId: string): Promise<void> {
  if (!isCrossWindowAccountModeEnabled()) return;
  if (!slot) throw new Error("Parallel window isolation is not ready. Reload this window before switching accounts.");
  await writeRegistry((registry) => {
    const current = registry.slots.find((candidate) => candidate.slotId === slot!.slotId);
    if (!current) throw new Error("This VS Code window is no longer registered for parallel accounts.");
    current.accountId = accountId;
  });
  slot.accountId = accountId;
}

export function releaseCrossWindowAccount(accountId?: string): Promise<void> {
  return lifecycle.runExclusive("window-mode", () => releaseWindowAccount(accountId));
}

async function releaseWindowAccount(accountId?: string): Promise<void> {
  if (!isCrossWindowAccountModeEnabled() || !slot) return;
  await writeRegistry((registry) => {
    const current = registry.slots.find((candidate) => candidate.slotId === slot!.slotId);
    if (current && (!accountId || current.accountId === accountId)) current.accountId = undefined;
  });
  if (!accountId || slot.accountId === accountId) slot.accountId = undefined;
}

export async function ensureCrossWindowAccountAssignment(
  accounts: readonly CodexManagerAccountRecord[],
  switchAccount: (accountId: string) => Promise<unknown>
): Promise<{ accountId?: string; assigned: boolean }> {
  if (!isCrossWindowAccountModeEnabled()) return { assigned: false };
  if (!slot) throw new Error("Parallel window isolation is not ready. Reload this window before assigning an account.");
  const existing = slot.accountId;
  const active = accounts.find((account) => account.isActive);
  // Disabling controls automation eligibility, not loaded authentication.
  // Keep even a disabled active account across restart until explicit Unload.
  // auth.json is authoritative on load. If Codex changed accounts outside the
  // manager, bind the window slot to what Codex actually loaded.
  if (active) {
    await claimCrossWindowAccount(active.id);
    return { accountId: active.id, assigned: true };
  }
  if (existing && accounts.some((account) => account.id === existing && account.enabled !== false)) {
    await claimCrossWindowAccount(existing);
    try {
      await switchAccount(existing);
    } catch (error) {
      await releaseCrossWindowAccount(existing);
      throw error;
    }
    return { accountId: existing, assigned: true };
  }
  const candidate = accounts.find((account) => account.enabled !== false && Boolean(account.id));
  if (!candidate) return { assigned: false };
  await claimCrossWindowAccount(candidate.id);
  // `isActive` is scoped to the managed CODEX_HOME. A newly-created window
  // must load its claimed account even when that account is active elsewhere.
  try {
    await switchAccount(candidate.id);
  } catch (error) {
    await releaseCrossWindowAccount(candidate.id);
    throw error;
  }
  return { accountId: candidate.id, assigned: true };
}

async function writeRegistry(mutator: (registry: Registry) => void): Promise<void> {
  const file = path.join(getCodexManagerStorageRoot(), REGISTRY_FILE);
  await runCrossWindowExclusive("accounts:window-slot-registry", "Parallel window account registry", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const registry = await readRegistry(file);
    registry.slots = registry.slots.filter(isLive);
    mutator(registry);
    if (sqliteStoreForFile(file)) { writeSqliteStateFile(file, JSON.stringify(registry)); return; }
    const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temp, JSON.stringify(registry, null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  });
}

async function readRegistry(file: string): Promise<Registry> {
  try {
    const value = JSON.parse(sqliteStoreForFile(file) ? readSqliteStateFile(file) : await fs.readFile(file, "utf8")) as Partial<Registry>;
    if (!Array.isArray(value.slots) || !value.slots.every(isValidSlot)) throw new Error("Parallel window registry is incomplete. Restore its storage before retrying.");
    return { slots: value.slots };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { slots: [] };
    throw error;
  }
}

function isValidSlot(value: unknown): value is WindowSlot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WindowSlot>;
  return (
    typeof candidate.slotId === "string" &&
    (candidate.accountId === undefined || (typeof candidate.accountId === "string" && candidate.accountId.length > 0)) &&
    typeof candidate.home === "string" &&
    typeof candidate.pid === "number" && Number.isInteger(candidate.pid) && candidate.pid > 0 &&
    typeof candidate.heartbeatAt === "number" && Number.isFinite(candidate.heartbeatAt)
  );
}

function isLive(candidate: WindowSlot): boolean {
  const age = Date.now() - candidate.heartbeatAt;
  if (age < 0 || candidate.heartbeatAt < Date.now() - os.uptime() * 1000) return false;
  if (age <= STALE_AFTER_MS) return true;
  try { process.kill(candidate.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
