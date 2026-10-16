import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SqliteStateStore } from "../src/storage/sqliteState";
import { removeTestDirectory } from "./testFilesystem";

const source = fs.readFileSync("tools/uninstall.js", "utf8");
let root: string;
let store: SqliteStateStore;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "manager-uninstall-"));
  store = await SqliteStateStore.open(path.join(root, ".codex", "manager.sqlite"));
  fs.writeFileSync(path.join(root, ".codex", "always-online-relay.json"), JSON.stringify({ adminToken: "legacy-token" }));
});
afterEach(async () => { store.close(); await removeTestDirectory(root); });

async function run() {
  const requests: Array<{ headers: Record<string, string> }> = [];
  const processStub = { env: {}, exitCode: 0 };
  const errors = vi.fn();
  vm.runInNewContext(source, { console: { error: errors }, process: processStub, Buffer,
    require: (id: string) => {
      if (id === "node:fs") return fs;
      if (id === "node:os") return { homedir: () => root };
      if (id === "node:path") return path;
      if (id === "node:sqlite") return require("node:sqlite");
      if (id === "node:http") return { request: (options: typeof requests[number], callback: (response: EventEmitter & { resume(): void }) => void) => {
        requests.push(options);
        const request = new EventEmitter() as EventEmitter & { end(): void };
        request.end = () => {
          const response = Object.assign(new EventEmitter(), { resume() {} });
          callback(response);
          response.emit("end");
        };
        return request;
      } };
      throw new Error(`Unexpected module: ${id}`);
    }
  });
  await Promise.resolve();
  await Promise.resolve();
  return { requests, errors, processStub };
}

it("stops the relay with SQLite's current token instead of the retained legacy file", async () => {
  store.set("files", "always-online-relay.json", { text: JSON.stringify({ adminToken: "current-token" }) });
  const result = await run();
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]!.headers["X-Codex-Admin"]).toBe("current-token");
  expect(result.processStub.exitCode).toBe(0);
});

it("uses legacy config only when no migrated record exists", async () => {
  const result = await run();
  expect(result.requests[0]!.headers["X-Codex-Admin"]).toBe("legacy-token");
});

it("does not resurrect deleted config or silently replace unreadable SQLite state", async () => {
  store.set("files", "always-online-relay.json", { text: null });
  expect((await run()).requests).toHaveLength(0);
  store.set("files", "always-online-relay.json", { text: "invalid JSON" });
  const result = await run();
  expect(result.requests).toHaveLength(0);
  expect(result.errors).toHaveBeenCalledOnce();
  expect(result.processStub.exitCode).toBe(1);
});
