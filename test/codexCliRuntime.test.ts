import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const fixture = vi.hoisted(() => ({ values: new Map<string, unknown>(), exec: vi.fn(), controller: new AbortController() }));
vi.mock("child_process", () => ({ execFile: fixture.exec }));
vi.mock("../src/utils/relayStartup", () => ({ resolveNodeExecutable: async () => process.execPath }));
vi.mock("../src/utils/crossWindowOperations", () => ({ runCrossWindowExclusive: (_key: string, _label: string, task: (signal: AbortSignal) => unknown) => task(fixture.controller.signal) }));
vi.mock("../src/storage/sqliteState", () => ({ getSqliteStateStore: () => ({ get: (_namespace: string, key: string) => fixture.values.get(key), set: (_namespace: string, key: string, value: unknown) => fixture.values.set(key, value) }) }));
vi.mock("../src/utils/persistentLog", () => ({ recordPersistentEvent: vi.fn() }));
import { bundledCodexCli, discoverBundledCodexCli, installManagedCodexCli, managedCodexCli } from "../src/services/codexCliRuntime";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); fixture.values.clear(); fixture.exec.mockReset(); fixture.controller = new AbortController();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("finds bundled CLI versions without a VS Code registry and tolerates missing extension roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manager-cli-discovery-")); roots.push(root);
  for (const name of ["openai.chatgpt-26.9.1", "openai.chatgpt-26.10.1", "other.extension-1.0.0"]) await mkdir(path.join(root, name));
  await writeFile(path.join(root, "openai.chatgpt-99.0.0"), "not a directory");
  expect(await discoverBundledCodexCli([path.join(root, "missing"), root, root])).toEqual([
    bundledCodexCli(path.join(root, "openai.chatgpt-26.10.1")), bundledCodexCli(path.join(root, "openai.chatgpt-26.9.1"))
  ]);
  expect(bundledCodexCli(root, "win32", "arm64")).toBe(path.join(root, "bin", "windows-arm64", "codex.exe"));
  expect(bundledCodexCli(root, "darwin", "arm64")).toBe(path.join(root, "bin", "macos-aarch64", "codex"));
});

async function installFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "manager-cli-install-")); roots.push(root);
  const npm = path.join(root, "npm-cli.js"); await writeFile(npm, "");
  vi.stubEnv("CODEX_MANAGER_STORAGE_ROOT", root); vi.stubEnv("npm_execpath", npm);
  return { root, npm };
}

it("shares an explicit install, verifies it before publishing readiness, and reuses it", async () => {
  const { root, npm } = await installFixture();
  fixture.exec.mockImplementation((_node, _args, _options, callback) => { queueMicrotask(() => callback(null)); });
  const [one, two] = await Promise.all([installManagedCodexCli(), installManagedCodexCli()]);
  expect(one).toBe(two); expect(managedCodexCli()).toBe(one);
  expect(fixture.exec).toHaveBeenCalledTimes(2);
  expect(fixture.exec.mock.calls[0][1]).toEqual(expect.arrayContaining([npm, "install", "--include=optional", "--ignore-scripts", "@openai/codex"]));
  expect(fixture.exec.mock.calls[0][2]).toMatchObject({ timeout: 60_000, windowsHide: true, cwd: path.join(root, "runtime", "codex-cli") });
  expect(fixture.exec.mock.calls[1][1]).toEqual([one, "--version"]);
  await installManagedCodexCli();
  expect(fixture.exec).toHaveBeenCalledTimes(3);
});

it.each(["ENOSPC", "ETIMEDOUT", "offline"])("keeps a failed %s install unready and permits retry", async reason => {
  await installFixture();
  fixture.exec.mockImplementationOnce((_node, _args, _options, callback) => { queueMicrotask(() => callback(new Error(reason))); });
  await expect(installManagedCodexCli()).rejects.toThrow("network access and free disk space");
  expect(managedCodexCli()).toBeUndefined();
  fixture.exec.mockImplementation((_node, _args, _options, callback) => { queueMicrotask(() => callback(null)); });
  await expect(installManagedCodexCli()).resolves.toEqual(expect.any(String));
});

it("does not publish a partially installed CLI when its version check fails", async () => {
  await installFixture();
  fixture.exec.mockImplementation((_node, args, _options, callback) => { queueMicrotask(() => callback(args.includes("--version") ? new Error("missing platform package") : null)); });
  await expect(installManagedCodexCli()).rejects.toThrow("could not be installed or verified");
  expect(managedCodexCli()).toBeUndefined();
});

it("keeps the installation unready after losing ownership", async () => {
  await installFixture();
  fixture.exec.mockImplementation((_node, _args, _options, callback) => {
    fixture.controller.abort(new Error("ownership lost")); queueMicrotask(() => callback(null));
  });
  await expect(installManagedCodexCli()).rejects.toThrow("could not be installed or verified");
  expect(managedCodexCli()).toBeUndefined();
});
