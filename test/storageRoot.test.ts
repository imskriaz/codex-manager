import * as fs from "fs/promises";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { getCodexManagerStorageRoot } from "../src/utils/storageRoot";

describe("Codex Manager storage root", () => {
  it("uses a version-independent folder below the user home directory", () => {
    expect(getCodexManagerStorageRoot(path.join("C:", "Users", "test"))).toBe(
      path.join("C:", "Users", "test", ".codex-manager")
    );
  });

  it("does not allow production code to use VS Code's extension-owned filesystem storage", async () => {
    const sourceRoot = path.resolve(__dirname, "..", "src");
    const files = await collectTypeScriptFiles(sourceRoot);
    const offenders: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      if (/globalStorageUri/.test(source)) {
        offenders.push(path.relative(sourceRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(target);
      return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
    })
  );
  return nested.flat();
}
