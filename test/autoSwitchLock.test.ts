import * as vscode from "vscode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { consumeAutoSwitchLockRelease, getAutoSwitchRuntimeSnapshot, initAutoSwitchRuntimeState, isAutoSwitchLocked, lockAutoSwitchForManualSelection, updateAutoSwitchLock } from "../src/presentation/workbench/autoSwitchState";

let update = vi.fn();
let saved: Record<string, unknown> | undefined;
beforeEach(() => {
  saved = { lockedAccountId: "account", lockedUntil: Date.now() + 60_000 };
  update = vi.fn(async (_key, value) => { saved = value; });
  initAutoSwitchRuntimeState({ globalState: { get: () => saved, update } } as unknown as vscode.ExtensionContext);
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
  update.mockImplementation((_key, value) => new Promise<void>(resolve => { finish = () => { saved = value; resolve(); }; }));
  const pending = expect(updateAutoSwitchLock("account", 0)).rejects.toThrow("outcome is unconfirmed");
  await vi.advanceTimersByTimeAsync(5_001); await pending;
  await expect(updateAutoSwitchLock("account", 5)).rejects.toThrow("still saving");
  finish(); await vi.advanceTimersByTimeAsync(0);
  update.mockImplementation(async (_key, value) => { saved = value; });
  await updateAutoSwitchLock("account", 5);
  expect(getAutoSwitchRuntimeSnapshot().lockedAccountId).toBe("account");
});
it("allows an expired lock owned by another account to be replaced", async () => {
  saved = { lockedAccountId: "expired", lockedUntil: 1 };
  initAutoSwitchRuntimeState({ globalState: { get: () => saved, update } } as unknown as vscode.ExtensionContext);
  await updateAutoSwitchLock("account", 5);
  expect(getAutoSwitchRuntimeSnapshot().lockedAccountId).toBe("account");
});

it("shares lock changes across windows and requests a single retry on unlock or expiry", async () => {
  saved = { lockedAccountId: 'other-window', lockedUntil: Date.now() + 900000 };
  expect(isAutoSwitchLocked('other-window')).toBe(true);
  saved = { lockedAccountId: 'other-window', lockedUntil: Date.now() - 1 };
  expect(consumeAutoSwitchLockRelease()).toBe(true);
  expect(consumeAutoSwitchLockRelease()).toBe(false);
  await updateAutoSwitchLock('other-window', 15);
  await updateAutoSwitchLock('other-window', 0);
  expect(consumeAutoSwitchLockRelease()).toBe(true);
  expect(consumeAutoSwitchLockRelease()).toBe(false);
});

it("keeps a failed manual lock visible as an unconfirmed action and permits retry", async () => {
  const account = { id: 'account', email: 'account@example.test', createdAt: 1, updatedAt: 1 };
  update.mockRejectedValueOnce(new Error('storage full'));
  await expect(lockAutoSwitchForManualSelection(account)).rejects.toThrow('storage full');
  await lockAutoSwitchForManualSelection(account);
  expect(getAutoSwitchRuntimeSnapshot().lockedUntil).toBeGreaterThan(Date.now() + 899000);
  expect(saved).toMatchObject({ lockedAccountId: account.id });
});
