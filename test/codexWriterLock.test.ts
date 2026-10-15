import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexCliSessionSummary, readRunningCodexSessionIds } from "../src/services/codexSessionResume";

const probe = vi.hoisted(() => ({ code: undefined as string | undefined, nativeMode: "", calls: [] as { args: string[]; options: { windowsHide: boolean; timeout: number } }[] }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFile: (...args: any[]) => {
    if (args[0] === "powershell.exe" && probe.nativeMode) {
      probe.calls.push({ args: args[1], options: args[2] });
      if (probe.nativeMode === "slow") { setTimeout(() => args.at(-1)(null, "[]"), 5200); return {}; }
      if (probe.nativeMode === "incomplete") { args.at(-1)(null, "{}"); return {}; }
      if (probe.nativeMode === "spawn-denied") throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
      const startupFailure = probe.calls.length === 1 || probe.nativeMode === "always-fail";
      args.at(-1)(startupFailure ? Object.assign(new Error("runtime startup failed"), { code: 0xc0000142 }) : null, "[]");
      return {};
    }
    return (actual.execFile as any)(...args);
  } };
});
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
afterEach(async () => { probe.code = undefined; probe.nativeMode = ""; probe.calls = []; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-writer-probe-"));
  roots.push(root);
  await mkdir(path.join(root, "thread-writer-locks"));
  await writeFile(path.join(root, "thread-writer-locks", `${id}.lock`), "");
  await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Writer", updated_at: new Date().toISOString() }));
  return root;
}

describe("writer lock evidence", () => {
  it.skipIf(process.platform !== "win32")("lets a Windows probe finish after the old five-second deadline", async () => {
    const root = await fixture();
    probe.nativeMode = "slow";
    await expect(readRunningCodexSessionIds(root)).resolves.toEqual([]);
    expect(probe.calls).toHaveLength(1);
  });
  it.skipIf(process.platform !== "win32")("keeps incomplete native output inconclusive and retries after recovery", async () => {
    const root = await fixture();
    probe.nativeMode = "incomplete";
    await expect(readRunningCodexSessionIds(root)).rejects.toThrow("incomplete data");
    probe.nativeMode = "recover";
    await expect(readRunningCodexSessionIds(root)).resolves.toEqual([]);
    expect(probe.calls).toHaveLength(2);
  });
  it.skipIf(process.platform !== "win32")("discards a failed spawn so the same session can recover after permissions return", async () => {
    const root = await fixture();
    probe.nativeMode = "spawn-denied";
    await expect(readRunningCodexSessionIds(root)).rejects.toThrow("Windows session writer inspection failed");
    expect(probe.calls).toHaveLength(2);
    probe.nativeMode = "recover";
    await expect(readRunningCodexSessionIds(root)).resolves.toEqual([]);
    expect(probe.calls).toHaveLength(3);
  });
  it.skipIf(process.platform !== "win32")("retries a Windows runtime startup failure with PowerShell hiding its own window", async () => {
    const root = await fixture();
    probe.nativeMode = "recover";
    probe.code = "EBUSY";
    await expect(readRunningCodexSessionIds(root)).resolves.toEqual([id]);
    expect(probe.calls).toHaveLength(2);
    expect(probe.calls.map(call => call.options.windowsHide)).toEqual([true, false]);
    expect(probe.calls[1]!.args).toEqual(expect.arrayContaining(["-WindowStyle", "Hidden"]));
    expect(probe.calls[1]!.options.timeout).toBeLessThanOrEqual(probe.calls[0]!.options.timeout);
  });
  it.skipIf(process.platform !== "win32")("keeps failed retry inconclusive instead of reporting an idle session", async () => {
    const root = await fixture();
    probe.nativeMode = "always-fail";
    await expect(readRunningCodexSessionIds(root)).rejects.toThrow("Windows session writer inspection failed");
    expect(probe.calls).toHaveLength(2);
  });
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
