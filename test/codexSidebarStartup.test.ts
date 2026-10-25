import * as vscode from "vscode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.unmock("../src/services/codexSidebarStartup");
vi.mock("../src/utils/safeFileReads", () => ({ readSafeFileSnapshot: vi.fn() }));
import { readSafeFileSnapshot } from "../src/utils/safeFileReads";
import { codexSidebarStartupState, waitForCodexSidebarStartup } from "../src/services/codexSidebarStartup";
const ready = "client.performance.span hostType=extension name=app_start outcome=success";
const failure = "renderer_ready_timeout role=sidebar";
const record = (message: string, time = Date.now()) => `${new Date(time - new Date(time).getTimezoneOffset() * 60_000).toISOString().slice(0, 23).replace("T", " ")} [info] ${message}\n`;
const logUri = { scheme: "file", fsPath: "C:/logs/window1/exthost/imskriaz.codex-manager" } as vscode.Uri;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(vscode.extensions.getExtension).mockReturnValue({ activate: vi.fn(async () => undefined) } as never);
  vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue(undefined);
  Object.assign(vscode.window, { tabGroups: { all: [] } });
  vi.mocked(readSafeFileSnapshot).mockReset().mockResolvedValue({ buffer: Buffer.from("") } as never);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("ignores stale, malformed, partial, non-extension, and non-startup records", () => {
  const now = Date.now();
  expect(codexSidebarStartupState(record(ready, now - 10) + "invalid\n" + record(ready.replace("extension", "desktop")) + record("renderer_ready") + record(ready).trimEnd(), now)).toBeUndefined();
  expect(codexSidebarStartupState(record(ready), now)).toBe("ready");
});
it("resets on reactivation and cannot mistake an editor success for recovery from a sidebar timeout", () => {
  const now = Date.now();
  expect(codexSidebarStartupState(record(ready) + record("Activating Codex extension"), now)).toBeUndefined();
  expect(codexSidebarStartupState(record(failure) + record(ready), now)).toBe("failed");
  expect(codexSidebarStartupState(record(failure.replace("sidebar", "panel")) + record(ready), now)).toBe("ready");
  expect(codexSidebarStartupState(record(failure, now - 10) + record(ready), now, now - 20)).toBe("failed");
});
it("opens the sidebar and waits for a fresh renderer trace from this window", async () => {
  const work = waitForCodexSidebarStartup(logUri, Date.now(), new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2_000);
  vi.mocked(readSafeFileSnapshot).mockResolvedValue({ buffer: Buffer.from(record(ready)) } as never);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(work).resolves.toBe("ready");
  expect(vscode.commands.executeCommand).toHaveBeenCalledExactlyOnceWith("chatgpt.openSidebar");
  expect(readSafeFileSnapshot).toHaveBeenCalledWith(expect.stringMatching(/window1.*openai\.chatgpt.*Codex\.log/), expect.objectContaining({ maxBytes: 256 * 1024 }));
});
it.each(["missing", "unreadable", "unavailable URI"])("uses the three-minute fallback when the trace is %s", async kind => {
  if (kind === "unreadable") vi.mocked(readSafeFileSnapshot).mockRejectedValue(new Error("Storage unavailable"));
  let finished = false;
  const work = waitForCodexSidebarStartup(kind === "unavailable URI" ? undefined : logUri, undefined, new AbortController().signal).then(result => { finished = true; return result; });
  await vi.advanceTimersByTimeAsync(179_999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(work).resolves.toBe("fallback");
});
it("keeps recovery on an explicit sidebar failure", async () => {
  vi.mocked(readSafeFileSnapshot).mockResolvedValue({ buffer: Buffer.from(record(failure)) } as never);
  await expect(waitForCodexSidebarStartup(logUri, undefined, new AbortController().signal)).rejects.toThrow("opened no tabs");
});
it("cancels during the wait without opening conversation panels", async () => {
  const controller = new AbortController();
  const work = expect(waitForCodexSidebarStartup(logUri, undefined, controller.signal)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1_000);
  controller.abort(); await work;
  expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("chatgpt.newCodexPanel");
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds a stalled sidebar command and keeps recovery instead of replaying it", async () => {
  vi.mocked(vscode.commands.executeCommand).mockImplementation(() => new Promise(() => {}));
  const work = expect(waitForCodexSidebarStartup(logUri, undefined, new AbortController().signal)).rejects.toThrow("sidebar did not open");
  await vi.advanceTimersByTimeAsync(180_000); await work;
  expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
});
it("keeps recovery when an editor is opened manually during the wait", async () => {
  const work = expect(waitForCodexSidebarStartup(logUri, undefined, new AbortController().signal)).rejects.toThrow("competing tabs");
  await vi.advanceTimersByTimeAsync(1_000);
  Object.assign(vscode.window, { tabGroups: { all: [{ tabs: [{ input: { viewType: "chatgpt.panelView" } }] }] } });
  await vi.advanceTimersByTimeAsync(1_000); await work;
});
it("keeps recovery if an editor appears during a pending trace read", async () => {
  vi.mocked(readSafeFileSnapshot).mockImplementation(async () => {
    Object.assign(vscode.window, { tabGroups: { all: [{ tabs: [{ input: { viewType: "chatgpt.conversationEditor" } }] }] } });
    return { buffer: Buffer.from(record(ready)) } as never;
  });
  await expect(waitForCodexSidebarStartup(logUri, undefined, new AbortController().signal)).rejects.toThrow("inspecting sidebar readiness");
});
