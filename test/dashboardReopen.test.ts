import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scheduleDashboardReopen } from "../webview-src/dashboard/reopenView";
import { hasUnsavedCliComposerDrafts } from '../webview-src/dashboard/cliSessionCache';
vi.mock('../webview-src/dashboard/cliSessionCache', () => ({ hasUnsavedCliComposerDrafts: vi.fn(() => false) }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(hasUnsavedCliComposerDrafts).mockReturnValue(false);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("requests reopening only after reconnecting remains stuck for 15 seconds", async () => {
  const reopen = vi.fn();
  scheduleDashboardReopen(true, false, reopen);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(reopen).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(reopen).toHaveBeenCalledOnce();
});
it('keeps unsaved drafts intact while storage is full or a write is pending', async () => {
  const reopen = vi.fn(), cancel = scheduleDashboardReopen(true, false, reopen);
  vi.mocked(hasUnsavedCliComposerDrafts).mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(reopen).not.toHaveBeenCalled();
  vi.mocked(hasUnsavedCliComposerDrafts).mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(reopen).toHaveBeenCalledOnce();
  cancel();
});
it.each(["pending", "healthy", "hidden", "recovered"])("keeps the dashboard intact when %s", async (reason) => {
  const reopen = vi.fn();
  if (reason === "hidden") Object.assign(document, { visibilityState: "hidden" });
  const cancel = scheduleDashboardReopen(reason !== "healthy", reason === "pending", reopen);
  if (reason === "recovered") cancel();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(reopen).not.toHaveBeenCalled();
});

it("restarts the recovery deadline when a hidden dashboard becomes visible", async () => {
  Object.assign(document, { visibilityState: "hidden" });
  const reopen = vi.fn(),
    cancel = scheduleDashboardReopen(true, false, reopen);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(reopen).not.toHaveBeenCalled();
  Object.assign(document, { visibilityState: "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(reopen).toHaveBeenCalledOnce();
  cancel();
});
