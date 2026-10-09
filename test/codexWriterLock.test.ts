import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexCliSessionSummary, readRunningCodexSessionIds } from "../src/services/codexSessionResume";

const probe = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (String(args[0]).endsWith(".lock") && probe.code)
      throw Object.assign(new Error("Writer lock probe failed"), { code: probe.code });
    return actual.open(...args);
  } };
});

const id = "01a04882-d037-7a42-ad24-9afb61901188";
const roots: string[] = [];
afterEach(async () => { probe.code = undefined; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-writer-probe-"));
  roots.push(root);
  await mkdir(path.join(root, "thread-writer-locks"));
  await writeFile(path.join(root, "thread-writer-locks", `${id}.lock`), "");
  await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Writer", updated_at: new Date().toISOString() }));
  return root;
}

describe("writer lock evidence", () => {
  it("uses a held OS lock without a transcript start marker and clears it when released", async () => {
    const root = await fixture();
    probe.code = "EBUSY";
    await expect(readCodexCliSessionSummary(id, root)).resolves.toMatchObject({ status: "running", locked: true });
    await expect(readRunningCodexSessionIds(root)).resolves.toEqual([id]);
    probe.code = undefined;
    await expect(readCodexCliSessionSummary(id, root)).resolves.toMatchObject({ status: "idle", locked: false });
    await expect(readRunningCodexSessionIds(root)).resolves.toEqual([]);
  });
  it("handles a removed lock and surfaces unreadable locks without claiming running", async () => {
    const root = await fixture();
    probe.code = "ENOENT";
    await expect(readCodexCliSessionSummary(id, root)).resolves.toMatchObject({ status: "idle", locked: false });
    probe.code = "EACCES";
    await expect(readRunningCodexSessionIds(root)).rejects.toMatchObject({ code: "EACCES" });
  });
});
