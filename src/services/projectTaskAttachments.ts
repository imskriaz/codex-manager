import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { MAX_CHAT_ATTACHMENT_BYTES, validateChatAttachments, type ChatAttachment } from "../domain/chatAttachments";
import type { ProjectAttachment } from "../domain/projectTasks";
import type { DashboardWorkspaceFile } from "../domain/dashboard/types";
import { getSqliteStateStore, type SqliteStateStore } from "../storage/sqliteState";
import { getCodexHomeStateKey } from '../codex/authFile';
import { runCrossWindowExclusive, CrossWindowOperationBusyError } from '../utils/crossWindowOperations';
import { createReadStream } from 'node:fs';
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
  if (!/^[a-f0-9]{64}$/.test(file.hash) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_CHAT_ATTACHMENT_BYTES)
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
      file.kind !== "text"
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
  signal?: AbortSignal,
  owner?: { home: string; sessionId: string; pending?: boolean }
): Promise<ProjectAttachment[] | undefined> {
  try {
    signal?.throwIfAborted();
    if (value === undefined) return;
    const files = validateChatAttachments(value);
    if (files.some((file) => !/^[a-zA-Z0-9:_-]{1,160}$/.test(file.id)))
      throw new Error("The attachment identifier is invalid. Attach the file again.");
    if (!files.length) return [];
    const store = getSqliteStateStore();
    if (!store) throw new Error('Attachment storage is unavailable. Your draft was kept.');
    store.transaction(() => {
      if (owner && store.get('deleted-codex-sessions', `${getCodexHomeStateKey(owner.home)}:${owner.sessionId.toLowerCase()}`) !== undefined)
        throw new Error('This conversation was deleted. Your attachments were not sent.');
      store.set('attachment-folders', project, { kind: owner ? 'session' : 'project', ...(owner ? { home: path.resolve(owner.home) } : {}) });
      if (owner) store.set('session-attachment-owners', JSON.stringify([getCodexHomeStateKey(owner.home), owner.sessionId.toLowerCase(), project]), project);
      if (owner?.pending) store.set('pending-session-attachments', JSON.stringify([getCodexHomeStateKey(owner.home), owner.sessionId.toLowerCase()]), { expiresAt: Date.now() + 86_400_000 });
    });
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
        file.kind !== "text"
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
/** Session uploads reuse the verified, content-addressed private attachment store. */
export async function saveCodexAttachmentFiles(projectPath: string, files: ChatAttachment[], signal?: AbortSignal, owner?: { home: string; sessionId: string; pending?: boolean }): Promise<Array<{ name: string; path: string }>> {
  const store = getSqliteStateStore();
  if (!store || !owner) throw new Error('Choose a conversation before saving session attachments.');
  if (!path.isAbsolute(owner.home) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(owner.sessionId)) throw new Error('Session attachment ownership is invalid.');
  const identity = createHash('sha256').update(`session-uploads:${projectPath}\0${getCodexHomeStateKey(owner.home)}:${owner.sessionId.toLowerCase()}\0`);
  for (const file of files) identity.update(file.name).update('\0').update(file.data).update('\0');
  const project = identity.digest('hex');
  return runCrossWindowExclusive(`project-attachments:${store.file}:${project}`, 'Save session attachments', async lease => {
    const combined = signal ? AbortSignal.any([signal, lease]) : lease;
    combined.throwIfAborted();
    if (getSqliteStateStore() !== store) throw new Error('Manager storage changed before saving attachments.');
    const saved = await saveProjectAttachments(project, files, combined, owner);
    combined.throwIfAborted();
    if (getSqliteStateStore() !== store) throw new Error("Manager storage changed while saving attachments. Refresh before sending.");
    const folder = await directory(project);
    return (saved ?? []).map(file => ({ name: file.name, path: path.join(folder, file.hash) }));
  });
}

export function adoptCodexAttachmentFiles(home: string, pendingId: string, sessionId: string): void {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Session attachment ownership could not be saved. No message was sent.');
  const scope = getCodexHomeStateKey(home);
  store.transaction(() => {
    for (const row of store.prepare("SELECT key,value FROM state WHERE namespace='session-attachment-owners' AND json_valid(key) AND json_extract(key,'$[0]')=? AND json_extract(key,'$[1]')=?").all(scope, pendingId)) {
      const folder = JSON.parse(String(row['value'])) as string;
      store.set('session-attachment-owners', JSON.stringify([scope, sessionId.toLowerCase(), folder]), folder);
      store.set('session-attachment-owners', String(row['key']), undefined);
    }
    store.set('pending-session-attachments', JSON.stringify([scope, pendingId]), undefined);
  });
}

/** Caller holds this folder's upload lease, so an upload cannot become referenced during deletion. */
export async function pruneProjectAttachmentFiles(project: string, store: SqliteStateStore, signal?: AbortSignal, sessionReferences?: Set<string>): Promise<void> {
  const check = () => { signal?.throwIfAborted(); if (getSqliteStateStore() !== store) throw new Error('Attachment cleanup storage changed. Files were kept.'); };
  check();
  const metadata = store.get<{ kind: string; home?: string }>('attachment-folders', project);
  const referenced = new Set<string>();
  if (metadata?.kind !== 'session' && store.get('project-migrations', project) !== true) throw new Error('Attachment folder ownership is unconfirmed. Files were kept.');
  if (metadata?.kind === 'session') {
    if (!sessionReferences || sessionReferences.has(project) || store.prepare("SELECT 1 FROM state WHERE namespace='session-attachment-owners' AND value=? LIMIT 1").get(JSON.stringify(project))) return;
  } else {
    const tables = new Set(store.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project_tasks','project_comments')").all().map(row => row['name']));
    for (const table of ['project_tasks', 'project_comments']) if (tables.has(table)) {
      if (store.prepare(`SELECT 1 FROM ${table} WHERE project=? AND NOT json_valid(data) LIMIT 1`).get(project)) throw new Error('Attachment references are unreadable. Files were kept.');
      for (const row of store.prepare(`SELECT json_extract(file.value,'$.hash') AS hash FROM ${table},json_each(${table}.data,'$.attachments') AS file WHERE project=?`).all(project)) {
        if (typeof row['hash'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['hash'])) throw new Error('Attachment references are invalid. Files were kept.');
        referenced.add(row['hash']);
      }
    }
  }
  let folder: string;
  try { folder = await directory(project); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { store.set('attachment-folders', project, undefined); return; } throw error; }
  for await (const entry of await fs.opendir(folder)) {
    check();
    const target = path.join(folder, entry.name);
    const temporary = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(entry.name);
    if (!temporary && (!/^[a-f0-9]{64}$/.test(entry.name) || referenced.has(entry.name))) continue;
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || temporary && Date.now() - info.mtimeMs < 86_400_000) continue;
    check(); await fs.unlink(target);
  }
  check();
  try { await fs.rmdir(folder); }
  catch (error) {
    if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  store.set('attachment-folders', project, undefined);
}

/** Native forks can inherit file paths without passing through Manager. An incomplete scan never authorizes deletion. */
async function referencedSessionUploadFolders(home: string, signal: AbortSignal, candidates: ReadonlySet<string>): Promise<Set<string>> {
  const names = await fs.readdir(home);
  if (!names.some(name => name === 'session_index.jsonl' || /^state_\d+\.sqlite$/.test(name))) throw new Error('Native history is unavailable. Session attachments were kept.');
  const database = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
  if (database) {
    const file = path.join(home, database), info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Native history database is linked. Session attachments were kept.');
    const moduleName = 'node:sqlite';
    const sqlite = await import(moduleName) as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => { prepare(sql: string): { all(): Record<string, unknown>[] }; close(): void } };
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare('SELECT rollout_path FROM threads LIMIT 10001').all();
      if (rows.length > 10_000) throw new Error('Native history database scan limit reached. Session attachments were kept.');
      for (const row of rows) {
        signal.throwIfAborted();
        const transcript = row['rollout_path'];
        if (typeof transcript !== 'string' || !/^(?:sessions|archived_sessions)[\\/]/.test(path.relative(home, path.resolve(transcript))))
          throw new Error('Some native history is outside the scanned folders. Session attachments were kept.');
        const stat = await fs.lstat(transcript);
        if (!stat.isFile() || stat.isSymbolicLink() || !transcript.endsWith('.jsonl')) throw new Error('Some native history is unavailable. Session attachments were kept.');
      }
    } finally { db.close(); }
  }
  const referenced = new Set<string>();
  let files = 0, entries = 0, bytes = 0;
  const visit = async (folder: string): Promise<void> => {
    signal.throwIfAborted();
    const info = await fs.lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Native history is linked or unavailable. Session attachments were kept.');
    for await (const entry of await fs.opendir(folder)) {
      signal.throwIfAborted();
      if (++entries > 20_000) throw new Error('Native history scan entry limit reached. Session attachments were kept.');
      const target = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Native history contains a link. Session attachments were kept.');
      if (entry.isDirectory()) { await visit(target); continue; }
      if (!entry.name.endsWith('.jsonl')) continue;
      if (++files > 10_000) throw new Error('Native history scan limit reached. Session attachments were kept.');
      let tail = '';
      for await (const chunk of createReadStream(target, { encoding: 'utf8', signal })) {
        if (typeof chunk !== 'string') throw new Error('Native history could not be decoded. Session attachments were kept.');
        bytes += Buffer.byteLength(chunk);
        if (bytes > 256 * 1024 * 1024) throw new Error('Native history scan byte limit reached. Session attachments were kept.');
        const text = tail + chunk;
        for (const match of text.matchAll(/[a-f0-9]{64}/g)) if (candidates.has(match[0])) referenced.add(match[0]);
        tail = text.slice(-128);
      }
    }
  };
  for (const name of ['sessions', 'archived_sessions']) if (names.includes(name)) await visit(path.join(home, name));
  return referenced;
}

export async function maintainAttachmentStorage(store: SqliteStateStore, signal: AbortSignal): Promise<void> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  bounded.throwIfAborted();
  if (getSqliteStateStore() !== store) return;
  store.transaction(() => {
    for (const row of store.prepare("SELECT key FROM state WHERE namespace='pending-session-attachments' AND json_valid(key) AND json_valid(value) AND json_extract(value,'$.expiresAt')<=? LIMIT 128").all(Date.now())) {
      const [home, id] = JSON.parse(String(row['key'])) as string[];
      store.prepare("DELETE FROM state WHERE namespace='session-attachment-owners' AND json_valid(key) AND json_extract(key,'$[0]')=? AND json_extract(key,'$[1]')=?").run(home!, id!);
      store.set('pending-session-attachments', String(row['key']), undefined);
    }
  });
  const projects = new Set(store.keys('project-migrations'));
  const known = new Set([...projects, ...store.keys('attachment-folders')]);
  const cursor = store.get<string>('attachment-cleanup', 'cursor') ?? '';
  const ordered = [...known].filter(key => /^[a-f0-9]{64}$/.test(key)).sort();
  const batch = [...ordered.filter(key => key > cursor), ...ordered.filter(key => key <= cursor)].slice(0, 128);
  const scans = new Map<string, Set<string> | Error>();
  for (const project of batch) {
    bounded.throwIfAborted();
    if (getSqliteStateStore() !== store) return;
    try {
      const metadata = store.get<{ kind: string; home?: string }>('attachment-folders', project);
      let references: Set<string> | undefined;
      if (metadata?.kind === 'session') {
        if (!metadata.home || store.prepare("SELECT 1 FROM state WHERE namespace='session-attachment-owners' AND value=? LIMIT 1").get(JSON.stringify(project))) continue;
        let scan = scans.get(metadata.home);
        if (!scan) {
          try { scan = await referencedSessionUploadFolders(metadata.home, bounded, known); }
          catch (error) { scan = error instanceof Error ? error : new Error(String(error)); }
          scans.set(metadata.home, scan);
        }
        if (scan instanceof Error) throw scan;
        references = scan;
      }
      await runCrossWindowExclusive(`project-attachments:${store.file}:${project}`, 'Attachment cleanup', async lease => {
        await pruneProjectAttachmentFiles(project, store, AbortSignal.any([bounded, lease]), references);
      }, { background: true });
    } catch (error) { if (!(error instanceof CrossWindowOperationBusyError)) console.warn('[codexManager] attachment cleanup postponed', error); }
    finally { if (getSqliteStateStore() === store) store.set('attachment-cleanup', 'cursor', project); }
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
    kind: file.kind === "image" ? "image" : file.kind === "text" ? "text" : "document",
    language: "plaintext",
    mimeType: file.mimeType,
    revision: file.hash,
    ...(file.kind !== "text" ? { dataUrl: `data:${file.mimeType};base64,${data.toString("base64")}` } : {})
  };
}
export async function readProjectAttachmentInput(project: string, file: ProjectAttachment): Promise<ChatAttachment> {
  const value = await readProjectAttachmentFile(project, file);
  return validateChatAttachments([{ ...file, data: file.kind !== "text" ? value.dataUrl : value.content }])[0]!;
}
