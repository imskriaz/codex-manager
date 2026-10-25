import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeTestDirectory } from "./testFilesystem";
const mocks = vi.hoisted(() => ({ home: "", open: vi.fn() }));
vi.mock("../src/services/codexSessionResume", () => ({ resolveCodexHome: () => mocks.home, openNewCodexWebview: mocks.open }));
import { inspectCodexUi, reopenCodexUi } from "../src/services/codexUiRecovery";
beforeEach(async () => {
  mocks.home = await mkdtemp(path.join(tmpdir(), "codex-ui-recovery-"));
  mocks.open.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await removeTestDirectory(mocks.home); });
it("checks entry assets and storage without opening Codex or reading conversation contents", async () => {
  await mkdir(path.join(mocks.home, "webview", "assets"), { recursive: true });
  await writeFile(path.join(mocks.home, "webview", "index.html"), '<script src="./assets/index.js"></script>');
  await writeFile(path.join(mocks.home, "webview", "assets", "index.js"), "bundle");
  await writeFile(path.join(mocks.home, "thread_history_1.sqlite"), "not-read-as-sqlite");
  vi.mocked(vscode.extensions.getExtension).mockReturnValue({ extensionPath: mocks.home, packageJSON: { version: "test" }, isActive: true } as never);
  const report = await inspectCodexUi();
  expect(report.items).toContainEqual({ label: "thread_history_1.sqlite", value: "0.0 MB" });
  expect(report.items).toContainEqual(expect.objectContaining({ label: "UI entry files", value: expect.stringContaining("Present") }));
  expect(mocks.open).not.toHaveBeenCalled();
});
it("reports missing UI files and disabled extensions without changing data", async () => {
  vi.mocked(vscode.extensions.getExtension).mockReturnValue({ extensionPath: mocks.home } as never);
  expect((await inspectCodexUi()).items).toContainEqual(expect.objectContaining({ label: "UI entry files", value: expect.stringContaining("Unavailable") }));
  vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined);
  expect((await inspectCodexUi()).items).toContainEqual({ label: "Codex extension", value: "Not installed or disabled in this host" });
});
it("joins duplicate open requests and does not claim renderer readiness", async () => {
  let release!: () => void;
  mocks.open.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
  const first = reopenCodexUi(), second = reopenCodexUi();
  expect(mocks.open).toHaveBeenCalledOnce(); release();
  for (const report of await Promise.all([first, second])) expect(report.items[0]?.value).toContain("Check that the new panel finishes loading");
});
it("retains extension diagnostics when native storage is missing", async () => {
  await removeTestDirectory(mocks.home);
  vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined);
  const report = await inspectCodexUi();
  expect(report.items).toContainEqual(expect.objectContaining({ label: "Native storage", value: expect.stringContaining("Unavailable") }));
  expect(report.items).toContainEqual(expect.objectContaining({ label: "Codex extension" }));
});
it("rejects UI asset paths outside the installed webview", async () => {
  await mkdir(path.join(mocks.home, "webview"));
  await writeFile(path.join(mocks.home, "webview", "index.html"), '<script src="../outside.js"></script>');
  await writeFile(path.join(mocks.home, "outside.js"), "private data");
  vi.mocked(vscode.extensions.getExtension).mockReturnValue({ extensionPath: mocks.home } as never);
  const report = await inspectCodexUi();
  expect(report.items).toContainEqual(expect.objectContaining({ label: "UI entry files", value: expect.stringContaining("outside the installed extension") }));
  expect(report.items.some(item => item.label === "outside.js")).toBe(false);
});
it("reports open failures and bounds a stalled command without replaying it", async () => {
  mocks.open.mockRejectedValueOnce(new Error("Extension disabled"));
  await expect(reopenCodexUi()).rejects.toThrow("Extension disabled");
  vi.useFakeTimers();
  let release!: () => void;
  mocks.open.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
  const work = expect(reopenCodexUi()).rejects.toThrow("request may still finish");
  await vi.advanceTimersByTimeAsync(20_001); await work;
  const duplicate = expect(reopenCodexUi()).rejects.toThrow("request may still finish");
  await vi.advanceTimersByTimeAsync(20_001); await duplicate;
  expect(mocks.open).toHaveBeenCalledTimes(2); release();
});
