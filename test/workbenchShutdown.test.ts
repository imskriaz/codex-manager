import { expect, it, vi } from "vitest";
import { AccountsWorkbench } from "../src/presentation/workbench/accountsWorkbench";

it("commits pending account metadata before disposing the repository", async () => {
  let finish!: () => void;
  const flush = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const dispose = vi.fn();
  const workbench = { autoResumeTracking: { dispose: vi.fn() }, encryptedSync: { shutdown: vi.fn() }, repo: { flush }, dispose };
  const shutdown = AccountsWorkbench.prototype.shutdown.call(workbench as never);
  expect(flush).toHaveBeenCalledOnce();
  expect(dispose).not.toHaveBeenCalled();
  finish();
  await shutdown;
  expect(dispose).toHaveBeenCalledOnce();
});

it("still disposes after a final save fails and preserves the error", async () => {
  const dispose = vi.fn();
  const workbench = { encryptedSync: { shutdown: vi.fn() }, repo: { flush: vi.fn().mockRejectedValue(new Error("Storage full")) }, dispose };
  await expect(AccountsWorkbench.prototype.shutdown.call(workbench as never)).rejects.toThrow("Storage full");
  expect(dispose).toHaveBeenCalledOnce();
});

it("bounds a stalled shutdown write and disposes without claiming success", async () => {
  vi.useFakeTimers();
  try {
    const dispose = vi.fn();
    const workbench = { encryptedSync: { shutdown: vi.fn() }, repo: { flush: vi.fn(() => new Promise<void>(() => undefined)) }, dispose };
    const shutdown = AccountsWorkbench.prototype.shutdown.call(workbench as never);
    const failed = expect(shutdown).rejects.toThrow("did not finish before shutdown");
    await vi.advanceTimersByTimeAsync(1500);
    await failed;
    expect(dispose).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
