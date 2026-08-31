import { constants, promises as fs } from "fs";
import type { Stats } from "fs";
import type { FileHandle } from "fs/promises";

export const DEFAULT_SAFE_FILE_READ_TIMEOUT_MS = 5_000;

export class SafeFileReadTimeoutError extends Error {
  constructor(readonly filePath: string, timeoutMs: number) {
    super(`The file did not respond within ${Math.ceil(timeoutMs / 1_000)} seconds. Try again after the other app finishes writing it.`);
    this.name = "SafeFileReadTimeoutError";
  }
}

export type SafeFileSnapshot = {
  buffer: Buffer;
  size: number;
  mtimeMs: number;
  startOffset: number;
  endOffset: number;
  bytesRead: number;
};

type SafeFileSnapshotOptions = {
  maxBytes: number;
  rejectIfLarger?: boolean;
  startOffset?: number | ((stat: Stats) => number);
  timeoutMs?: number;
};

/**
 * Take a bounded, read-only snapshot from one file handle. The handle is never
 * locked or upgraded for writing, so another process can keep appending while
 * the snapshot is read. Only the size observed from this handle is consumed;
 * bytes appended later are left for the next refresh.
 */
export async function readSafeFileSnapshot(
  filePath: string,
  options: SafeFileSnapshotOptions
): Promise<SafeFileSnapshot> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SAFE_FILE_READ_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const maxBytes = Math.max(0, Math.floor(options.maxBytes));
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const open = fs.open(filePath, constants.O_RDONLY | noFollow);
  let handle: FileHandle;
  try {
    handle = await beforeDeadline(open, deadline, filePath, timeoutMs);
  } catch (error) {
    // An OS/network filesystem open can finish after the UI timeout. Close that
    // late handle instead of leaking it or retaining a writer-visible reader.
    void open.then((lateHandle) => lateHandle.close()).catch(() => undefined);
    throw error;
  }

  try {
    const stat = await beforeDeadline(handle.stat(), deadline, filePath, timeoutMs);
    if (!stat.isFile()) throw new Error("The selected path is not a regular file.");
    if (options.rejectIfLarger && stat.size > maxBytes) {
      const error = new Error(`The file is larger than the safe ${formatBytes(maxBytes)} read limit.`);
      error.name = "SafeFileReadLimitError";
      throw error;
    }

    const requestedOffset = typeof options.startOffset === "function"
      ? options.startOffset(stat)
      : (options.startOffset ?? 0);
    const startOffset = Math.max(0, Math.min(stat.size, Math.floor(requestedOffset)));
    const requestedBytes = Math.min(maxBytes, Math.max(0, stat.size - startOffset));
    const buffer = Buffer.allocUnsafe(requestedBytes);
    let bytesRead = 0;
    while (bytesRead < requestedBytes) {
      const length = Math.min(64 * 1024, requestedBytes - bytesRead);
      const read = handle.read(buffer, bytesRead, length, startOffset + bytesRead);
      const result = await beforeDeadline(read, deadline, filePath, timeoutMs);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return {
      buffer: buffer.subarray(0, bytesRead),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      startOffset,
      endOffset: startOffset + bytesRead,
      bytesRead
    };
  } finally {
    // close() is intentionally not allowed to extend a user-visible read past
    // its deadline. Node will finish the close after any in-flight read settles.
    const close = handle.close();
    await beforeDeadline(close, deadline, filePath, timeoutMs).catch(() => {
      void close.catch(() => undefined);
    });
  }
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  filePath: string,
  timeoutMs: number
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    void operation.catch(() => undefined);
    throw new SafeFileReadTimeoutError(filePath, timeoutMs);
  }
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void operation.catch(() => undefined);
      reject(new SafeFileReadTimeoutError(filePath, timeoutMs));
    }, remainingMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.floor(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.floor(bytes / 1024)} KB`;
  return `${bytes} byte`;
}
