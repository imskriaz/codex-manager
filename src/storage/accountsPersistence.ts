import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { CodexManagerIndex } from "../core/types";
import { getBackupPath, parseAccountsIndex } from "./accountsIndex";
import { readSqliteStateFile, sqliteStoreForFile, writeSqliteStateFile } from "./sqliteState";
import { hasAccountRows, readAccountIndex, saveAccountIndex } from "./sqliteAccounts";

// Windows can briefly keep the previous index handle open during extension
// host replacement/update. Give the owner enough time to release it before
// surfacing a startup-fatal storage error.
const REPLACE_RETRY_DELAYS_MS = [20, 50, 100, 200, 400, 800, 1_200, 1_800, 2_500, 3_500];
const TRANSIENT_REPLACE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export async function readIndexSnapshot(filePath: string): Promise<CodexManagerIndex> {
  const store = sqliteStoreForFile(filePath);
  const main = path.basename(filePath) === "accounts-index.json";
  if (store && main && hasAccountRows(store)) return readAccountIndex(store);
  const raw = store ? readSqliteStateFile(filePath) : await fs.readFile(filePath, "utf8");
  const index = parseAccountsIndex(raw, filePath);
  if (store && main) { saveAccountIndex(store, index, 0, true); return readAccountIndex(store); }
  return index;
}

export async function countAvailableBackups(indexPath: string, backupCount: number): Promise<number> {
  const results = await Promise.all(
    Array.from({ length: backupCount }, (_, index) =>
      readIndexSnapshot(getBackupPath(indexPath, index + 1))
        .then(() => true)
        .catch(() => false)
    )
  );
  return results.filter(Boolean).length;
}

export async function backupCurrentIndex(indexPath: string, backupCount: number): Promise<void> {
  const current = await readCurrentIndexForBackup(indexPath);
  if (!current) {
    return;
  }

  console.info("[codexManager] creating accounts index backup");
  for (let slot = backupCount; slot >= 2; slot -= 1) {
    const from = getBackupPath(indexPath, slot - 1);
    const to = getBackupPath(indexPath, slot);
    try {
      const snapshot = await readIndexSnapshot(from);
      await writeIndexAtomically(to, snapshot, ".tmp");
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        console.error(`[codexManager] failed to rotate backup ${slot - 1} -> ${slot}:`, error);
      }
    }
  }

  await writeIndexAtomically(getBackupPath(indexPath, 1), current, ".tmp");
}

export async function writeIndexAtomically(
  indexPath: string,
  index: CodexManagerIndex,
  tempSuffix: string,
  operations: { rename?: typeof fs.rename; wait?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const serialized = JSON.stringify(index, null, 2);
  if (sqliteStoreForFile(indexPath)) {
    parseAccountsIndex(serialized, indexPath);
    const store = sqliteStoreForFile(indexPath)!;
    if (path.basename(indexPath) === "accounts-index.json") saveAccountIndex(store, index);
    else writeSqliteStateFile(indexPath, serialized);
    return;
  }
  const tempPath = createUniqueTempPath(indexPath, tempSuffix);
  parseAccountsIndex(serialized, tempPath);
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await replaceFileWithRetry(tempPath, indexPath, operations);
  await fs.chmod(indexPath, 0o600).catch(() => undefined);
}

export function writeIndexAtomicallySync(indexPath: string, index: CodexManagerIndex, tempSuffix: string): void {
  const serialized = JSON.stringify(index, null, 2);
  if (sqliteStoreForFile(indexPath)) {
    parseAccountsIndex(serialized, indexPath);
    const store = sqliteStoreForFile(indexPath)!;
    if (path.basename(indexPath) === "accounts-index.json") saveAccountIndex(store, index);
    else writeSqliteStateFile(indexPath, serialized);
    return;
  }
  const tempPath = createUniqueTempPath(indexPath, tempSuffix);
  parseAccountsIndex(serialized, tempPath);
  const descriptor = fsSync.openSync(tempPath, "wx", 0o600);
  try {
    try {
      fsSync.writeFileSync(descriptor, serialized, "utf8");
      fsSync.fsyncSync(descriptor);
    } finally {
      fsSync.closeSync(descriptor);
    }
  } catch (error) {
    try { fsSync.unlinkSync(tempPath); } catch { /* The live index remains untouched. */ }
    throw error;
  }
  replaceFileWithRetrySync(tempPath, indexPath);
  try {
    fsSync.chmodSync(indexPath, 0o600);
  } catch {
    // Windows protects the user-owned folder through inherited ACLs.
  }
}

/** Recover a validated snapshot left behind when shutdown interrupted replacement. */
export async function readLatestValidTempIndex(
  indexPath: string,
  tempSuffix: string
): Promise<CodexManagerIndex | undefined> {
  const directory = path.dirname(indexPath);
  const prefix = `${path.basename(indexPath)}${tempSuffix}-`;
  const store = sqliteStoreForFile(indexPath);
  if (store) {
    const archived = store.keys("legacy-files").filter(key => key.startsWith(prefix))
      .map(key => store.get<{ path: string; modifiedAt?: number; base64: string }>("legacy-files", key)!)
      .filter(record => record.path.startsWith(prefix) && typeof record.base64 === "string")
      .sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0));
    for (const record of archived) {
      try { return parseAccountsIndex(Buffer.from(record.base64, "base64").toString("utf8"), record.path); }
      catch { /* Older validated snapshots may still recover the account list. */ }
    }
  }
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }

  const candidates = await Promise.all(
    entries
      .filter((name) => name.startsWith(prefix))
      .map(async (name) => {
        const filePath = path.join(directory, name);
        const stat = await fs.stat(filePath).catch(() => undefined);
        return stat?.isFile() ? { filePath, modifiedAt: stat.mtimeMs } : undefined;
      })
  );
  for (const candidate of candidates
    .filter((value): value is { filePath: string; modifiedAt: number } => Boolean(value))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)) {
    try {
      return await readIndexSnapshot(candidate.filePath);
    } catch {
      // Keep searching older candidates; invalid files remain available for diagnostics.
    }
  }
  return undefined;
}

function createUniqueTempPath(indexPath: string, tempSuffix: string): string {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${indexPath}${tempSuffix}-${nonce}`;
}

async function replaceFileWithRetry(
  tempPath: string,
  indexPath: string,
  operations: { rename?: typeof fs.rename; wait?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const rename = operations.rename ?? fs.rename;
  const wait = operations.wait ?? delay;
  let lastError: unknown;
  for (let attempt = 0; attempt <= REPLACE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await rename(tempPath, indexPath);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientReplaceError(error) || attempt === REPLACE_RETRY_DELAYS_MS.length) {
        break;
      }
      await wait(REPLACE_RETRY_DELAYS_MS[attempt]!);
    }
  }

  // Never copy over the live file as a fallback. copyFile truncates the
  // destination first and an extension update can terminate the host before
  // bytes are copied, leaving a full-length all-zero index. Keep the validated
  // temp snapshot for startup recovery and leave the previous live file intact.
  throw lastError;
}

function replaceFileWithRetrySync(tempPath: string, indexPath: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt <= REPLACE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      fsSync.renameSync(tempPath, indexPath);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientReplaceError(error) || attempt === REPLACE_RETRY_DELAYS_MS.length) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, REPLACE_RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw lastError;
}

function isTransientReplaceError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    TRANSIENT_REPLACE_CODES.has(String((error as { code?: unknown }).code))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
  );
}

async function readCurrentIndexForBackup(indexPath: string): Promise<CodexManagerIndex | undefined> {
  try {
    return await readIndexSnapshot(indexPath);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      console.warn("[codexManager] skipped index backup because current index is unreadable");
    }
    return undefined;
  }
}
