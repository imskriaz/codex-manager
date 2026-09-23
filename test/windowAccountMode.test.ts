import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTestDirectory } from "./testFilesystem";

const testState = vi.hoisted(() => ({ root: "", enabled: false }));

vi.mock("../src/utils/storageRoot", () => ({
  getCodexManagerStorageRoot: () => testState.root
}));

import { configureCrossWindowOperationCoordinator } from "../src/utils/crossWindowOperations";
import {
  canWindowUseAccount,
  claimCrossWindowAccount,
  disposeCrossWindowAccountMode,
  ensureCrossWindowAccountAssignment,
  getCrossWindowAccountId,
  getCrossWindowHome,
  initializeCrossWindowAccountMode
} from "../src/services/windowAccountMode";

describe("parallel window account mode", () => {
  let originalHome: string | undefined;

  beforeEach(async () => {
    testState.root = await fs.mkdtemp(path.join(os.tmpdir(), "parallel-window-accounts-"));
    testState.enabled = false;
    originalHome = process.env["CODEX_HOME"];
    process.env["CODEX_HOME"] = path.join(testState.root, "normal-home");
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => (key === "crossWindowAccountModeEnabled" ? testState.enabled : fallback),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);
    Object.assign(vscode.env, { sessionId: "test-session" });
    await configureCrossWindowOperationCoordinator(testState.root);
  });

  afterEach(async () => {
    await disposeCrossWindowAccountMode();
    if (originalHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = originalHome;
    await removeTestDirectory(testState.root);
  });

  it("leaves the existing CODEX_HOME and account policy unchanged while disabled", async () => {
    const normalHome = process.env["CODEX_HOME"];
    await initializeCrossWindowAccountMode();
    expect(process.env["CODEX_HOME"]).toBe(normalHome);
    expect(getCrossWindowHome()).toBeUndefined();
    expect(canWindowUseAccount("account-a")).toBe(true);
    await expect(fs.stat(path.join(testState.root, "window-account-slots-v1.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("uses an isolated home and stores only account identifiers in its registry", async () => {
    testState.enabled = true;
    await initializeCrossWindowAccountMode();
    await claimCrossWindowAccount("account-a");
    const home = getCrossWindowHome();
    expect(home).toContain("window-codex-homes-v1");
    expect(process.env["CODEX_HOME"]).toBe(home);
    expect(getCrossWindowAccountId()).toBe("account-a");
    const registry = await fs.readFile(path.join(testState.root, "window-account-slots-v1.json"), "utf8");
    expect(registry).toContain("account-a");
    expect(registry).not.toMatch(/access.?token|refresh.?token|id.?token/i);
  });

  it("rejects an account claimed by another live window", async () => {
    testState.enabled = true;
    await initializeCrossWindowAccountMode();
    const registryPath = path.join(testState.root, "window-account-slots-v1.json");
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as { slots: unknown[] };
    registry.slots.push({
      slotId: "other-window",
      accountId: "account-b",
      home: path.join(testState.root, "other-home"),
      pid: 999,
      heartbeatAt: Date.now()
    });
    await fs.writeFile(registryPath, JSON.stringify(registry), "utf8");
    await expect(claimCrossWindowAccount("account-b")).rejects.toThrow("already assigned to another VS Code window");
  });

  it("loads the selected account and releases its claim if loading fails", async () => {
    testState.enabled = true;
    await initializeCrossWindowAccountMode();
    const account = { id: "account-c", email: "c@example.com", enabled: true, isActive: false } as never;
    const switchAccount = vi.fn(async () => {
      throw new Error("auth write failed");
    });
    await expect(ensureCrossWindowAccountAssignment([account], switchAccount)).rejects.toThrow("auth write failed");
    expect(getCrossWindowAccountId()).toBeUndefined();
  });
});
