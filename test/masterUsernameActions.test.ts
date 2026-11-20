import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeDashboardActionMessage, type DashboardActionContext } from "../src/presentation/dashboard/actionHandlers";
import { configureCrossWindowOperationCoordinator } from "../src/utils/crossWindowOperations";
import { removeTestDirectory } from "./testFilesystem";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "master-username-actions-"));
  vi.stubEnv("CODEX_MANAGER_STORAGE_ROOT", root);
  vi.stubEnv("CODEX_MANAGER_ADMIN_USERNAME", undefined);
  await configureCrossWindowOperationCoordinator(root);
});
afterEach(async () => { vi.unstubAllEnvs(); await removeTestDirectory(root); });
function context(hostKind: "webview" | "browser", localMasterAccess = false): DashboardActionContext {
  return { context: {} as never, repo: {} as never, hostKind, localMasterAccess, oauth: {} as never,
    resolveLanguage: () => "en", publishState: async () => undefined, schedulePublishState: vi.fn() };
}
const read = { type: "dashboard:action", action: "getMasterUsername", requestId: "username-read", payload: { targetDeviceId: "local" } } as const;

it("returns the same identity in VS Code and the trusted local browser", async () => {
  const webview = await executeDashboardActionMessage(context("webview"), read);
  expect(webview.status).toBe("completed");
  expect(webview.payload?.masterUsername).toMatch(/^manager-[a-f0-9]{32}$/);
  const browser = await executeDashboardActionMessage(context("browser", true), read);
  expect(browser.payload?.masterUsername).toBe(webview.payload?.masterUsername);
});

it("blocks remote browsers, peers, and API requests without returning the identity", async () => {
  const result = await executeDashboardActionMessage(context("browser"), read);
  expect(result).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("authenticated master session") });
  expect(result.payload?.masterUsername).toBeUndefined();
  expect(await fs.readdir(root)).not.toContain("codex-manager.env");
});

it("allows authenticated remote master reads while keeping rotation local", async () => {
  const ctx = { ...context("browser"), authenticatedMasterAccess: true };
  const result = await executeDashboardActionMessage(ctx, read);
  expect(result.status).toBe("completed");
  expect(result.payload?.masterUsername).toMatch(/^manager-[a-f0-9]{32}$/);
  const rotate = await executeDashboardActionMessage(ctx, { ...read, action: "rotateMasterUsername", payload: { targetDeviceId: "local", masterUsername: result.payload!.masterUsername, confirmed: true } });
  expect(rotate.status).toBe("failed");
  expect(rotate.payload?.masterUsername).toBeUndefined();
});

it("requires confirmation and rejects stale rotation requests", async () => {
  const ctx = context("webview");
  const first = (await executeDashboardActionMessage(ctx, read)).payload!.masterUsername!;
  const rotate = { ...read, action: "rotateMasterUsername" as const, requestId: "username-rotate", payload: { targetDeviceId: "local", masterUsername: first } };
  expect(await executeDashboardActionMessage(ctx, rotate)).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("Confirm rotation") });
  const changed = await executeDashboardActionMessage(ctx, { ...rotate, payload: { ...rotate.payload, confirmed: true } });
  expect(changed.status).toBe("completed");
  expect(changed.payload?.masterUsername).not.toBe(first);
  expect(changed.payload?.notice?.message).toContain("rotated");
  expect(await executeDashboardActionMessage(ctx, { ...rotate, payload: { ...rotate.payload, confirmed: true } })).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("changed in another window") });
});
