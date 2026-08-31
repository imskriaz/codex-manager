import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  disposePersistentLogging,
  PersistentFileLogger,
  registerPersistentLogging,
  runWithPersistentOperation
} from "../src/utils/persistentLog";
import { removeTestDirectory } from "./testFilesystem";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await disposePersistentLogging();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => removeTestDirectory(directory)));
  vi.restoreAllMocks();
});

describe("persistent diagnostics", () => {
  it("keeps exactly three UTC log days and preserves sanitized error detail", async () => {
    const root = await makeTemporaryDirectory();
    await Promise.all(
      ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"].map(async (day) =>
        fs.writeFile(path.join(root, `codex-manager-${day}.jsonl`), `${day}\n`, "utf8")
      )
    );
    await fs.writeFile(path.join(root, "notes.txt"), "keep me", "utf8");
    let now = new Date("2026-08-29T12:00:00.000Z");
    const logger = new PersistentFileLogger(root, 3, () => now);

    await logger.initialize();
    const cause = new Error("Bearer secret-token-value");
    logger.write(
      "error",
      "test",
      "Request for dev@example.com failed",
      { accessToken: "secret-token-value", accountId: "account-123", safe: "visible" },
      new Error("outer failure", { cause })
    );
    await logger.flush();

    const names = await fs.readdir(root);
    expect(names).not.toContain("codex-manager-2026-08-25.jsonl");
    expect(names).not.toContain("codex-manager-2026-08-26.jsonl");
    expect(names).toContain("codex-manager-2026-08-27.jsonl");
    expect(names).toContain("codex-manager-2026-08-28.jsonl");
    expect(names).toContain("codex-manager-2026-08-29.jsonl");
    expect(names).toContain("notes.txt");

    const currentLog = await fs.readFile(logger.currentLogPath, "utf8");
    expect(currentLog).toContain("Request for [redacted-email] failed");
    expect(currentLog).toContain('"accessToken":"[redacted]"');
    expect(currentLog).toContain('"accountId":"[redacted]"');
    expect(currentLog).toContain('"safe":"visible"');
    expect(currentLog).toContain("outer failure");
    expect(currentLog).toContain("cause");
    expect(currentLog).not.toContain("secret-token-value");
    expect(currentLog).not.toContain("dev@example.com");

    now = new Date("2026-08-30T00:01:00.000Z");
    logger.write("info", "test", "next day");
    await logger.flush();
    const rolloverNames = await fs.readdir(root);
    expect(rolloverNames).not.toContain("codex-manager-2026-08-27.jsonl");
    expect(rolloverNames).toContain("codex-manager-2026-08-28.jsonl");
    expect(rolloverNames).toContain("codex-manager-2026-08-29.jsonl");
    expect(rolloverNames).toContain("codex-manager-2026-08-30.jsonl");
  });

  it("records operation start, failure, duration, and correlation IDs", async () => {
    const root = await makeTemporaryDirectory();
    const subscriptions: Array<{ dispose(): unknown }> = [];
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = vi.fn(() => ({ dispose: vi.fn() }));
    await registerPersistentLogging({
      globalStorageUri: { fsPath: root },
      extensionPath: path.join(root, "extension"),
      subscriptions
    } as never);

    await expect(
      runWithPersistentOperation("command:Refresh quota", async () => {
        throw new Error("network unavailable");
      })
    ).rejects.toThrow("network unavailable");
    await disposePersistentLogging();

    const logDirectory = path.join(root, "logs");
    const [logName] = (await fs.readdir(logDirectory)).filter((name) => name.endsWith(".jsonl"));
    expect(logName).toBeDefined();
    const records = (await fs.readFile(path.join(logDirectory, logName!), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const started = records.find((record) => record.message === "command:Refresh quota started");
    const failed = records.find((record) => record.message === "command:Refresh quota failed");
    expect(started?.operationId).toEqual(expect.any(String));
    expect(started?.traceId).toBe(started?.operationId);
    expect(failed?.operationId).toBe(started?.operationId);
    expect(failed?.durationMs).toEqual(expect.any(Number));
    expect(failed?.error).toMatchObject({ message: "network unavailable" });
  });

  it("correlates nested operations into one trace", async () => {
    const root = await makeTemporaryDirectory();
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = vi.fn(() => ({ dispose: vi.fn() }));
    await registerPersistentLogging({
      globalStorageUri: { fsPath: root },
      extensionPath: path.join(root, "extension"),
      subscriptions: []
    } as never);

    await runWithPersistentOperation("dashboard-message:action:refresh", async () =>
      runWithPersistentOperation("command:Refresh quota", async () => undefined)
    );
    await disposePersistentLogging();

    const logDirectory = path.join(root, "logs");
    const [logName] = (await fs.readdir(logDirectory)).filter((name) => name.endsWith(".jsonl"));
    const records = (await fs.readFile(path.join(logDirectory, logName!), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const parent = records.find((record) => record.message === "dashboard-message:action:refresh started");
    const child = records.find((record) => record.message === "command:Refresh quota started");
    expect(child?.traceId).toBe(parent?.traceId);
    expect(child?.parentOperationId).toBe(parent?.operationId);
  });

  it("keeps logging safe for bigint and oversized diagnostic values", async () => {
    const root = await makeTemporaryDirectory();
    const logger = new PersistentFileLogger(root);
    await logger.initialize();
    expect(() => logger.write("info", "test", "safe bigint", {
      sequence: BigInt("9007199254740993")
    })).not.toThrow();
    expect(() => logger.write("info", "test", "safe oversized value", {
      huge: "x".repeat(70_000)
    })).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
    const content = await fs.readFile(logger.currentLogPath, "utf8");
    expect(content).toContain('"truncated":true');
    expect(content).toContain("[bigint:9007199254740993]");
  }, 30_000);

});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-manager-log-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
