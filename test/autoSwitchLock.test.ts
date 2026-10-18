import * as vscode from "vscode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAutoSwitchRuntimeSnapshot, initAutoSwitchRuntimeState, updateAutoSwitchLock } from "../src/presentation/workbench/autoSwitchState";

let update = vi.fn();
beforeEach(() => {
  update = vi.fn().mockResolvedValue(undefined);
  initAutoSwitchRuntimeState({ globalState: { get: () => ({ lockedAccountId: "account", lockedUntil: Date.now() + 60_000 }), update } } as unknown as vscode.ExtensionContext);
});
afterEach(() => vi.useRealTimers());

it("acknowledges a durable unlock and rolls back a rejected write", async () => {
  update.mockRejectedValueOnce(new Error("Storage full"));
  await expect(updateAutoSwitchLock("account", 0)).rejects.toThrow("Storage full");
  expect(getAutoSwitchRuntimeSnapshot().lockedAccountId).toBe("account");
  await updateAutoSwitchLock("account", 0);
  expect(update).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ lockedAccountId: undefined, lockedUntil: undefined }));
});
it("rejects another account and invalid durations without writing", async () => {
  await expect(updateAutoSwitchLock("other", 0)).rejects.toThrow("another account");
  await expect(updateAutoSwitchLock("account", -1)).rejects.toThrow("whole lock duration");
  expect(update).not.toHaveBeenCalled();
});
it("bounds stalled storage and prevents conflicting retries until it settles", async () => {
  vi.useFakeTimers(); let finish!: () => void;
  update.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = expect(updateAutoSwitchLock("account", 0)).rejects.toThrow("outcome is unconfirmed");
  await vi.advanceTimersByTimeAsync(5_001); await pending;
  await expect(updateAutoSwitchLock("account", 5)).rejects.toThrow("still saving");
  finish(); await vi.advanceTimersByTimeAsync(0);
  update.mockResolvedValue(undefined);
  await updateAutoSwitchLock("account", 5);
  expect(getAutoSwitchRuntimeSnapshot().lockedAccountId).toBe("account");
});
it("allows an expired lock owned by another account to be replaced", async () => {
  initAutoSwitchRuntimeState({ globalState: { get: () => ({ lockedAccountId: "expired", lockedUntil: 1 }), update } } as unknown as vscode.ExtensionContext);
  await updateAutoSwitchLock("account", 5);
  expect(getAutoSwitchRuntimeSnapshot().lockedAccountId).toBe("account");
});
