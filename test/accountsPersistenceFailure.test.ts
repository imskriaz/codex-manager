import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), unlink: vi.fn().mockResolvedValue(undefined), rename: vi.fn(),
  openSync: vi.fn().mockReturnValue(1), writeFileSync: vi.fn(), fsyncSync: vi.fn(), closeSync: vi.fn(), unlinkSync: vi.fn(), renameSync: vi.fn() }));
vi.mock("fs/promises", () => ({ open: mocks.open, unlink: mocks.unlink, rename: mocks.rename }));
vi.mock("fs", () => ({ openSync: mocks.openSync, writeFileSync: mocks.writeFileSync, fsyncSync: mocks.fsyncSync, closeSync: mocks.closeSync, unlinkSync: mocks.unlinkSync, renameSync: mocks.renameSync }));
import { writeIndexAtomically, writeIndexAtomicallySync } from "../src/storage/accountsPersistence";

describe("atomic persistence under storage failure", () => {
  it("closes and removes a partial snapshot after storage fills without touching the live index", async () => {
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const close = vi.fn();
    mocks.open.mockResolvedValue({ writeFile: vi.fn().mockRejectedValue(error), close });
    await expect(writeIndexAtomically("accounts-index.json", { accounts: [] }, ".tmp")).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/^accounts-index\.json\.tmp-/));
    expect(mocks.rename).not.toHaveBeenCalled();
  });
  it("cleans synchronous partial snapshots while preserving the live index", () => {
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    mocks.writeFileSync.mockImplementation(() => { throw error; });
    expect(() => writeIndexAtomicallySync("accounts-index.json", { accounts: [] }, ".tmp")).toThrow("disk full");
    expect(mocks.closeSync).toHaveBeenCalledOnce();
    expect(mocks.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/^accounts-index\.json\.tmp-/));
    expect(mocks.renameSync).not.toHaveBeenCalled();
  });
});
