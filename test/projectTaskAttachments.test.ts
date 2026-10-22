import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import {
  saveProjectTaskWithAttachments,
  addProjectCommentWithAttachments,
  readProjectTask,
  readProjectTasks,
  readProjectAttachment,
  projectTaskKey,
  publicProjectBoard
} from "../src/services/projectTasks";
import { readProjectAttachmentInput } from "../src/services/projectTaskAttachments";
import { projectAttachmentPath } from "../src/domain/projectTasks";
import type { ChatAttachment } from "../src/domain/chatAttachments";
import { removeTestDirectory } from "./testFilesystem";

const lease = vi.hoisted(() => ({ signal: undefined as AbortSignal | undefined }));
vi.mock("../src/utils/crossWindowOperations", () => ({
  runCrossWindowExclusive: async (_key: string, _label: string, work: (signal: AbortSignal) => Promise<unknown>) =>
    work(lease.signal ?? new AbortController().signal)
}));
let root: string, store: SqliteStateStore;
const upload: ChatAttachment = {
  id: "upload-a",
  name: "brief.md",
  kind: "text",
  mimeType: "text/plain",
  data: "Content retained only in the attachment file.",
  size: 1
};
const draft = {
  id: "task",
  title: "Attached task",
  prompt: "Review this file",
  stage: "planned" as const,
  expectedRevision: 0,
  uploads: [upload]
};
const folder = () => join(root, "manager", "attachments", projectTaskKey(root));
beforeEach(async () => {
  lease.signal = undefined;
  root = await fs.mkdtemp(join(tmpdir(), "manager-task-attachments-"));
  store = await SqliteStateStore.open(join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
});
afterEach(async () => {
  vi.restoreAllMocks();
  configureSqliteStateStore(undefined);
  store.close();
  await removeTestDirectory(root);
});

it("stores task/comment bytes under the manager folder and retains metadata through duplicate retries and restart", async () => {
  const task = await saveProjectTaskWithAttachments(root, draft),
    file = task.attachments![0]!;
  expect(file.size).toBe(Buffer.byteLength(upload.data));
  expect(await fs.readFile(join(folder(), file.hash), "utf8")).toBe(upload.data);
  expect(JSON.stringify(readProjectTasks(root))).not.toContain(upload.data);
  expect(await saveProjectTaskWithAttachments(root, draft)).toEqual(task);
  const input = { id: "comment", taskId: task.id, text: "", uploads: [{ ...upload, id: "upload-b" }] };
  const comment = await addProjectCommentWithAttachments(root, input);
  expect(await addProjectCommentWithAttachments(root, input)).toEqual(comment);
  expect(await fs.readdir(folder())).toEqual([file.hash]);
  await expect(
    addProjectCommentWithAttachments(root, { ...input, uploads: [{ ...upload, id: "upload-b", data: "Changed" }] })
  ).rejects.toThrow("already used");
  store.close();
  store = await SqliteStateStore.open(join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
  expect(readProjectTask(root, task.id)?.attachments).toEqual(task.attachments);
  await expect(
    readProjectAttachment(root, task.id, projectAttachmentPath("task", task.id, file))
  ).resolves.toMatchObject({ content: upload.data, path: "brief.md" });
  await expect(readProjectAttachmentInput(projectTaskKey(root), file)).resolves.toMatchObject({ data: upload.data });
});

it("loads only a reference owned by the requested project/task and permission set", async () => {
  const task = await saveProjectTaskWithAttachments(root, draft),
    file = task.attachments![0]!;
  const comment = await addProjectCommentWithAttachments(root, {
    id: "comment",
    taskId: task.id,
    text: "File",
    uploads: [{ ...upload, id: "comment-upload" }]
  });
  await expect(readProjectAttachment(root, task.id, projectAttachmentPath("task", "other", file))).rejects.toThrow(
    "outside this task"
  );
  await expect(
    readProjectAttachment(join(root, "other"), task.id, projectAttachmentPath("task", task.id, file))
  ).rejects.toThrow("missing");
  await expect(
    readProjectAttachment(root, task.id, projectAttachmentPath("comment", comment.id, comment.attachments![0]!), false)
  ).rejects.toThrow("outside this task");
  const board = { ...readProjectTasks(root), projectPath: root, sessions: [], updatedAt: Date.now() };
  const hidden = publicProjectBoard(board, {
    projectPath: root,
    permissions: ["comments"],
    expiresAt: Date.now() + 10000
  }) as typeof board;
  expect(hidden.tasks[0]?.attachments).toBeUndefined();
  expect(hidden.comments[0]?.attachments).toBeUndefined();
  expect(JSON.stringify(hidden)).not.toContain(file.hash);
});

it("rejects unsupported, oversized and forged uploads before creating task records", async () => {
  await expect(
    saveProjectTaskWithAttachments(root, { ...draft, uploads: [{ ...upload, name: "../escape.md" }] })
  ).rejects.toThrow("invalid");
  await expect(
    saveProjectTaskWithAttachments(root, { ...draft, uploads: [{ ...upload, data: "x".repeat(32769) }] })
  ).rejects.toThrow("32 KB");
  await expect(
    saveProjectTaskWithAttachments(root, { ...draft, uploads: [{ ...upload, id: "../escape" }] })
  ).rejects.toThrow("identifier");
  expect(readProjectTask(root, draft.id)).toBeUndefined();
});

it("surfaces storage exhaustion, removes partial staging files, and preserves the task draft", async () => {
  vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("private filesystem path"), { code: "ENOSPC" }));
  await expect(saveProjectTaskWithAttachments(root, draft)).rejects.toThrow(
    "Attachment storage is full. Your draft was kept."
  );
  expect(await fs.readdir(folder())).toEqual([]);
  expect(readProjectTask(root, draft.id)).toBeUndefined();
  expect((await saveProjectTaskWithAttachments(root, draft)).attachments).toHaveLength(1);
});

it("rejects directory links before creating files outside the managed directory", async () => {
  const outside = join(root, "elsewhere");
  await fs.mkdir(outside);
  await fs.symlink(outside, join(root, "manager"), "junction");
  await expect(saveProjectTaskWithAttachments(root, draft)).rejects.toThrow("inside the manager folder");
  expect(await fs.readdir(outside)).toEqual([]);
  expect(readProjectTask(root, draft.id)).toBeUndefined();
});

it("detects missing/corrupt files and repairs them only from a validated matching upload", async () => {
  const task = await saveProjectTaskWithAttachments(root, draft),
    file = task.attachments![0]!,
    target = join(folder(), file.hash);
  await fs.writeFile(target, "corrupt");
  await expect(readProjectAttachment(root, task.id, projectAttachmentPath("task", task.id, file))).rejects.toThrow(
    "changed"
  );
  await expect(saveProjectTaskWithAttachments(root, draft)).resolves.toMatchObject({ revision: 1 });
  expect(await fs.readFile(target, "utf8")).toBe(upload.data);
  await fs.unlink(target);
  await expect(readProjectAttachment(root, task.id, projectAttachmentPath("task", task.id, file))).rejects.toThrow(
    "missing"
  );
  expect(readProjectTask(root, task.id)?.attachments).toHaveLength(1);
});

it("checks authorization again after file persistence and never commits revoked submissions", async () => {
  const authorize = vi
    .fn()
    .mockImplementationOnce(() => undefined)
    .mockImplementation(() => {
      throw new Error("Link revoked");
    });
  await expect(saveProjectTaskWithAttachments(root, draft, authorize)).rejects.toThrow("Link revoked");
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(readProjectTask(root, draft.id)).toBeUndefined();
  expect(await fs.readdir(folder())).toEqual([]);
  const task = await saveProjectTaskWithAttachments(root, draft);
  authorize
    .mockReset()
    .mockImplementationOnce(() => undefined)
    .mockImplementation(() => {
      throw new Error("Link revoked");
    });
  await expect(
    addProjectCommentWithAttachments(root, { id: "guest", taskId: task.id, text: "", uploads: [upload] }, authorize)
  ).rejects.toThrow("Link revoked");
  expect(readProjectTasks(root).comments).toEqual([]);
});

it("returns image snapshots without embedding their bytes in board metadata", async () => {
  const image = {
    id: "image",
    name: "pixel.png",
    kind: "image" as const,
    mimeType: "image/png",
    size: 1,
    data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
  };
  const task = await saveProjectTaskWithAttachments(root, { ...draft, uploads: [image] }),
    file = task.attachments![0]!;
  expect(JSON.stringify(readProjectTasks(root))).not.toContain("base64");
  await expect(
    readProjectAttachment(root, task.id, projectAttachmentPath("task", task.id, file))
  ).resolves.toMatchObject({ kind: "image", dataUrl: image.data });
});

it("bounds attachment storage and can recover after capacity is available", async () => {
  await fs.mkdir(folder(), { recursive: true });
  const fullFile = join(folder(), "0".repeat(64));
  await fs.writeFile(fullFile, "");
  const actual = fs.lstat.bind(fs);
  const stat = vi.spyOn(fs, "lstat").mockImplementation(async (value) => {
    const info = await actual(value);
    if (String(value) === fullFile) info.size = 64 * 1024 * 1024;
    return info;
  });
  await expect(saveProjectTaskWithAttachments(root, draft)).rejects.toThrow("storage is full");
  expect(readProjectTask(root, draft.id)).toBeUndefined();
  stat.mockRestore();
  await expect(saveProjectTaskWithAttachments(root, draft)).resolves.toMatchObject({ revision: 1 });
});

it("rejects invalid drafts before writing blobs", async () => {
  await expect(saveProjectTaskWithAttachments(root, { ...draft, title: "" })).rejects.toThrow("title");
  await expect(
    addProjectCommentWithAttachments(root, { id: "missing", taskId: "absent", text: "", uploads: [upload] })
  ).rejects.toThrow("missing");
  await expect(fs.stat(join(root, "manager"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps a changed storage context from linking files into another database", async () => {
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
    await rename(...args);
    configureSqliteStateStore(undefined);
  });
  await expect(saveProjectTaskWithAttachments(root, draft)).rejects.toThrow("Manager storage changed");
  configureSqliteStateStore(store);
  expect(readProjectTask(root, draft.id)).toBeUndefined();
  expect(await fs.readdir(folder())).toHaveLength(1);
});

it("does not commit or remove uncertain files after its upload lease is cancelled", async () => {
  const controller = new AbortController();
  lease.signal = controller.signal;
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
    await rename(...args);
    controller.abort(new Error("Upload lease lost"));
  });
  await expect(saveProjectTaskWithAttachments(root, draft)).rejects.toThrow("Upload lease lost");
  expect(readProjectTask(root, draft.id)).toBeUndefined();
  expect(await fs.readdir(folder())).toHaveLength(1);
});
