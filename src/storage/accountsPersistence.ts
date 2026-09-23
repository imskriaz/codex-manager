import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { CodexManagerIndex } from "../core/types";
import { getBackupPath, parseAccountsIndex, readCurrentIndexForBackupSync } from "./accountsIndex";

// Windows can briefly keep the previous index handle open during extension
// host replacement/update. Give the owner enough time to release it before
// surfacing a startup-fatal storage error.
const REPLACE_RETRY_DELAYS_MS = [20, 50, 100, 200, 400, 800, 1_200, 1_800, 2_500, 3_500];
const TRANSIENT_REPLACE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export async function readIndexSnapshot(filePath: string): Promise<CodexManagerIndex> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseAccountsIndex(raw, filePath);
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

export function backupCurrentIndexSync(indexPath: string, backupCount: number): void {
  const current = readCurrentIndexForBackupSync(indexPath);
  if (!current) {
    return;
  }

  for (let slot = backupCount; slot >= 2; slot -= 1) {
    const from = getBackupPath(indexPath, slot - 1);
    const to = getBackupPath(indexPath, slot);
    try {
      const raw = fsSync.readFileSync(from, "utf8");
      const snapshot = parseAccountsIndex(raw, from);
      writeIndexAtomicallySync(to, snapshot, ".tmp");
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        console.error(`[codexManager] failed to rotate backup ${slot - 1} -> ${slot}:`, error);
      }
    }
  }

  writeIndexAtomicallySync(getBackupPath(indexPath, 1), parseAccountsIndex(current, indexPath), ".tmp");
}

export async function writeIndexAtomically(
  indexPath: string,
  index: CodexManagerIndex,
  tempSuffix: string,
  operations: { rename?: typeof fs.rename; wait?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const serialized = JSON.stringify(index, null, 2);
  const tempPath = createUniqueTempPath(indexPath, tempSuffix);
  parseAccountsIndex(serialized, tempPath);
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replaceFileWithRetry(tempPath, indexPath, operations);
  await fs.chmod(indexPath, 0o600).catch(() => undefined);
}

export function writeIndexAtomicallySync(indexPath: string, index: CodexManagerIndex, tempSuffix: string): void {
  const serialized = JSON.stringify(index, null, 2);
  const tempPath = createUniqueTempPath(indexPath, tempSuffix);
  parseAccountsIndex(serialized, tempPath);
  const descriptor = fsSync.openSync(tempPath, "wx", 0o600);
  try {
    fsSync.writeFileSync(descriptor, serialized, "utf8");
    fsSync.fsyncSync(descriptor);
  } finally {
    fsSync.closeSync(descriptor);
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
      if (!isTransientReplaceError(error) || attempt === REPLACE_RETRY_DELAYS_MS.length) {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, REPLACE_RETRY_DELAYS_MS[attempt]!);
    }
  }

  // Asynchronous persistence owns normal writes. Shutdown must not truncate a
  // shared live index merely because another process still has it open.
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

export function countAvailableBackupsSyncSafe(indexPath: string, backupCount: number): number {
  let count = 0;
  for (let slot = 1; slot <= backupCount; slot += 1) {
    const backupPath = getBackupPath(indexPath, slot);
    try {
      parseAccountsIndex(fsSync.readFileSync(backupPath, "utf8"), backupPath);
      count += 1;
    } catch {
      // Only validated backups are reported as available.
    }
  }
  return count;
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
