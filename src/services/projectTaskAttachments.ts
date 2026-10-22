import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { validateChatAttachments, type ChatAttachment } from "../domain/chatAttachments";
import type { ProjectAttachment } from "../domain/projectTasks";
import type { DashboardWorkspaceFile } from "../domain/dashboard/types";
import { getSqliteStateStore } from "../storage/sqliteState";
import { waitWithin } from "../utils/concurrency";

function storageError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (!code) return error instanceof Error ? error : new Error("Attachment storage failed. Your draft was kept.");
  return new Error(
    code === "ENOSPC" || code === "EDQUOT"
      ? "Attachment storage is full. Your draft was kept."
      : code === "ENOENT"
        ? "This saved attachment is missing. Reattach the file before retrying."
        : `Attachment storage is unavailable (${code}). Your draft was kept.`
  );
}
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
async function directory(project: string, create = false): Promise<string> {
  const store = getSqliteStateStore();
  if (!store || !path.isAbsolute(store.file) || !/^[a-f0-9]{64}$/.test(project))
    throw new Error("Attachment storage is unavailable. Your draft was kept.");
  let folder = await fs.realpath(path.dirname(store.file));
  for (const part of ["manager", "attachments", project]) {
    folder = path.join(folder, part);
    try {
      if (create) await fs.mkdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await fs.lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Attachment storage must stay inside the manager folder.");
  }
  return folder;
}
async function verifiedFile(folder: string, file: ProjectAttachment): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(file.hash) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 1024 * 1024)
    throw new Error("Saved attachment metadata is invalid.");
  const target = path.join(folder, file.hash);
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size)
    throw new Error("The saved attachment is missing or changed.");
  const handle = await fs.open(target, "r");
  const data = Buffer.alloc(file.size);
  try {
    if ((await handle.stat()).size !== file.size) throw new Error("The saved attachment changed.");
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error("The saved attachment is incomplete.");
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (hash(data) !== file.hash) throw new Error("The saved attachment is incomplete or changed.");
  return data;
}
export function describeProjectAttachments(value: unknown): ProjectAttachment[] | undefined {
  if (value === undefined) return;
  return validateChatAttachments(value).map((file) => {
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(file.id))
      throw new Error("The attachment identifier is invalid. Attach the file again.");
    const data =
      file.kind === "image"
        ? Buffer.from(file.data.slice(file.data.indexOf(",") + 1), "base64")
        : Buffer.from(file.data, "utf8");
    return {
      id: file.id,
      name: file.name,
      kind: file.kind,
      mimeType: file.mimeType,
      size: data.length,
      hash: hash(data)
    };
  });
}
export async function removeProjectAttachmentFiles(project: string, hashes: string[]): Promise<void> {
  if (!hashes.length) return;
  let folder: string;
  try {
    folder = await directory(project);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const value of hashes) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid attachment cleanup reference.");
    await fs.unlink(path.join(folder, value)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
/** Payloads stay on disk; boards and SQLite retain only bounded file metadata. */
export async function saveProjectAttachments(
  project: string,
  value: unknown,
  signal?: AbortSignal
): Promise<ProjectAttachment[] | undefined> {
  try {
    signal?.throwIfAborted();
    if (value === undefined) return;
    const files = validateChatAttachments(value);
    if (files.some((file) => !/^[a-zA-Z0-9:_-]{1,160}$/.test(file.id)))
      throw new Error("The attachment identifier is invalid. Attach the file again.");
    if (!files.length) return [];
    const folder = await waitWithin(directory(project, true), 5000, "Attachment storage is busy. Your draft was kept.");
    const names: string[] = [];
    signal?.throwIfAborted();
    for await (const entry of await fs.opendir(folder)) {
      signal?.throwIfAborted();
      if (
        /^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(entry.name) &&
        Date.now() - (await fs.lstat(path.join(folder, entry.name))).mtimeMs > 86400000
      ) {
        await fs.unlink(path.join(folder, entry.name));
        continue;
      }
      names.push(entry.name);
      if (names.length > 1024) throw new Error("Project attachment storage is full. Your draft was kept.");
    }
    let bytes = 0;
    for (const name of names) if (/^[a-f0-9]{64}$/.test(name)) bytes += (await fs.lstat(path.join(folder, name))).size;
    const result: ProjectAttachment[] = [];
    for (const file of files) {
      signal?.throwIfAborted();
      const data =
        file.kind === "image"
          ? Buffer.from(file.data.slice(file.data.indexOf(",") + 1), "base64")
          : Buffer.from(file.data, "utf8");
      const attachment: ProjectAttachment = {
        id: file.id,
        name: file.name,
        kind: file.kind,
        mimeType: file.mimeType,
        size: data.length,
        hash: hash(data)
      };
      let replacing = 0;
      if (names.includes(attachment.hash)) {
        try {
          await verifiedFile(folder, attachment);
          result.push(attachment);
          continue;
        } catch (error) {
          const previous = await fs.lstat(path.join(folder, attachment.hash));
          if (!previous.isFile() || previous.isSymbolicLink()) throw error;
          replacing = previous.size;
        }
      }
      if (
        bytes + data.length - replacing > 64 * 1024 * 1024 ||
        (!names.includes(attachment.hash) && names.length >= 1024)
      )
        throw new Error("Project attachment storage is full. Your draft was kept.");
      const temporary = path.join(folder, `${attachment.hash}.${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        signal?.throwIfAborted();
        await fs.rename(temporary, path.join(folder, attachment.hash));
      } finally {
        await fs.unlink(temporary).catch(() => undefined);
      }
      bytes += data.length - replacing;
      if (!names.includes(attachment.hash)) names.push(attachment.hash);
      result.push(attachment);
    }
    return result;
  } catch (error) {
    throw storageError(error);
  }
}
export async function readProjectAttachmentFile(
  project: string,
  file: ProjectAttachment
): Promise<DashboardWorkspaceFile> {
  const data = await waitWithin(
    directory(project).then((folder) => verifiedFile(folder, file)),
    5000,
    "Attachment reading timed out. Retry shortly."
  ).catch((error) => {
    throw storageError(error);
  });
  return {
    path: file.name,
    size: data.length,
    content: file.kind === "text" ? data.toString("utf8") : "",
    kind: file.kind === "image" ? "image" : "text",
    language: "plaintext",
    mimeType: file.mimeType,
    revision: file.hash,
    ...(file.kind === "image" ? { dataUrl: `data:${file.mimeType};base64,${data.toString("base64")}` } : {})
  };
}
export async function readProjectAttachmentInput(project: string, file: ProjectAttachment): Promise<ChatAttachment> {
  const value = await readProjectAttachmentFile(project, file);
  return validateChatAttachments([{ ...file, data: file.kind === "image" ? value.dataUrl : value.content }])[0]!;
}
