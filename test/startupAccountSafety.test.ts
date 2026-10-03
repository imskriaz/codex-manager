import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("authentication stays loaded until explicit unload", () => {
  it("does not schedule unloading disabled authentication during activation or reload", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/presentation/workbench/accountsWorkbench.ts"), "utf8");
    expect(source).not.toContain("unloadDisabledActiveAccountOnStartup");
    expect(source).not.toContain("unloadAuthFile");
  });
  it("explains that postponing an unload also preserves authentication across restart", () => {
    const source = readFileSync(path.resolve(__dirname, "../webview-src/dashboard/main.tsx"), "utf8");
    expect(source).toContain("stays loaded until you manually choose Unload, including after restart");
    expect(source).not.toContain("unloaded automatically after restart");
  });
});
