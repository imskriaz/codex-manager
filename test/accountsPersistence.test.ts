import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countAvailableBackups,
  readLatestValidTempIndex,
  writeIndexAtomically
} from "../src/storage/accountsPersistence";
import type { CodexManagerIndex } from "../src/core/types";
import { removeTestDirectory } from "./testFilesystem";

describe("accounts index persistence", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => removeTestDirectory(dir)));
  }, 15_000);

  it("replaces an existing index without leaving a shared temp file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-index-write-"));
    tempDirs.push(dir);
    const indexPath = path.join(dir, "accounts-index.json");
    const oldIndex = { version: 1, accounts: [], updatedAt: 1 } as unknown as CodexManagerIndex;
    const newIndex = { version: 1, accounts: [], updatedAt: 2 } as unknown as CodexManagerIndex;
    await fs.writeFile(indexPath, JSON.stringify(oldIndex), "utf8");

    await writeIndexAtomically(indexPath, newIndex, ".tmp");

    expect(JSON.parse(await fs.readFile(indexPath, "utf8"))).toEqual(newIndex);
    expect((await fs.readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("never truncates the live index when replacement stays busy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-index-busy-"));
    tempDirs.push(dir);
    const indexPath = path.join(dir, "accounts-index.json");
    const oldIndex = { accounts: [] } as CodexManagerIndex;
    const newIndex = {
      accounts: [{ id: "new", email: "new@example.com", createdAt: 1, updatedAt: 1 }]
    } as CodexManagerIndex;
    await fs.writeFile(indexPath, JSON.stringify(oldIndex), "utf8");
    const busy = Object.assign(new Error("busy"), { code: "EBUSY" });

    await expect(
      writeIndexAtomically(indexPath, newIndex, ".tmp", {
        rename: async () => Promise.reject(busy),
        wait: async () => undefined
      })
    ).rejects.toBe(busy);

    expect(JSON.parse(await fs.readFile(indexPath, "utf8"))).toEqual(oldIndex);
    expect(await readLatestValidTempIndex(indexPath, ".tmp")).toEqual(newIndex);
  });

  it("counts only parseable backups", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-index-backups-"));
    tempDirs.push(dir);
    const indexPath = path.join(dir, "accounts-index.json");
    await fs.writeFile(path.join(dir, "accounts-index.backup-1.json"), JSON.stringify({ accounts: [] }), "utf8");
    await fs.writeFile(path.join(dir, "accounts-index.backup-2.json"), Buffer.alloc(128));
    await fs.writeFile(path.join(dir, "accounts-index.backup-3.json"), "not json", "utf8");

    await expect(countAvailableBackups(indexPath, 3)).resolves.toBe(1);
  });
});
