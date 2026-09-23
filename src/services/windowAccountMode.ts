import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { CodexManagerAccountRecord } from "../core/types";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";

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

export function isCrossWindowAccountModeEnabled(): boolean {
  return getCodexManagerConfiguration().get<boolean>(SETTING, false) === true;
}

export async function initializeCrossWindowAccountMode(): Promise<void> {
  if (!isCrossWindowAccountModeEnabled()) return;
  originalHome ??= process.env["CODEX_HOME"];
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
  process.env["CODEX_HOME"] = home;
  slot = { slotId, home, pid: process.pid, heartbeatAt: Date.now() };
  await writeRegistry((registry) => {
    registry.slots = registry.slots.filter((candidate) => candidate.slotId !== slotId);
    registry.slots.push(slot!);
  });
  heartbeat = setInterval(() => {
    if (!slot) return;
    slot.heartbeatAt = Date.now();
    void writeRegistry((registry) => {
      const current = registry.slots.find((candidate) => candidate.slotId === slot!.slotId);
      if (current) Object.assign(current, slot);
      else registry.slots.push(slot!);
    }).catch((error) => console.warn("[codexManager] parallel window heartbeat failed:", error));
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

export async function disposeCrossWindowAccountMode(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
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

export function getCrossWindowSlotId(): string | undefined {
  return slot?.slotId;
}

export function getCrossWindowAccountId(): string | undefined {
  return slot?.accountId;
}

export function canWindowUseAccount(accountId: string): boolean {
  void accountId;
  // Parallel windows isolate CODEX_HOME; they do not reserve accounts. Two
  // windows may deliberately run the same account, and both manual and
  // automatic switching must remain available in that configuration.
  return true;
}

export async function claimCrossWindowAccount(accountId: string): Promise<void> {
  if (!isCrossWindowAccountModeEnabled() || !slot) return;
  await writeRegistry((registry) => {
    const current = registry.slots.find((candidate) => candidate.slotId === slot!.slotId);
    if (!current) throw new Error("This VS Code window is no longer registered for parallel accounts.");
    current.accountId = accountId;
    slot!.accountId = accountId;
  });
}

export async function releaseCrossWindowAccount(accountId?: string): Promise<void> {
  if (!isCrossWindowAccountModeEnabled() || !slot) return;
  await writeRegistry((registry) => {
    const current = registry.slots.find((candidate) => candidate.slotId === slot!.slotId);
    if (current && (!accountId || current.accountId === accountId)) current.accountId = undefined;
    if (!accountId || slot!.accountId === accountId) slot!.accountId = undefined;
  });
}

export async function ensureCrossWindowAccountAssignment(
  accounts: readonly CodexManagerAccountRecord[],
  switchAccount: (accountId: string) => Promise<unknown>
): Promise<{ accountId?: string; assigned: boolean }> {
  if (!isCrossWindowAccountModeEnabled() || !slot) return { assigned: false };
  const existing = slot.accountId;
  const active = accounts.find((account) => account.isActive && account.enabled !== false);
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
    const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.writeFile(temp, JSON.stringify(registry, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, file);
  });
}

async function readRegistry(file: string): Promise<Registry> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as Partial<Registry>;
    return { slots: Array.isArray(value.slots) ? value.slots.filter(isValidSlot) : [] };
  } catch {
    return { slots: [] };
  }
}

function isValidSlot(value: unknown): value is WindowSlot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WindowSlot>;
  return (
    typeof candidate.slotId === "string" &&
    typeof candidate.home === "string" &&
    typeof candidate.pid === "number" &&
    typeof candidate.heartbeatAt === "number"
  );
}

function isLive(candidate: WindowSlot): boolean {
  return Date.now() - candidate.heartbeatAt <= STALE_AFTER_MS;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
