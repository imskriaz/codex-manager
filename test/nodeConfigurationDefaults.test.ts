import { createRequire } from "node:module";
import { expect, it } from "vitest";
const shim = createRequire(import.meta.url)("../tools/node-vscode-shim/vscode.js");

it("uses the same Automation defaults as VS Code before caller fallbacks", async () => {
  const config = shim.workspace.getConfiguration("codexManager");
  expect(config.get("autoResumeEnabled", false)).toBe(true);
  expect(config.get("autoSwitchReloadWindowEnabled", false)).toBe(true);
  expect(config.get("modelCapacityFailureCount", 99)).toBe(3);
  expect(config.inspect("autoResumeEnabled").defaultValue).toBe(true);
  expect(config.get("unknownSetting", "fallback")).toBe("fallback");
  try {
    await config.update("autoResumeEnabled", false);
    expect(config.get("autoResumeEnabled", true)).toBe(false);
    expect(config.inspect("autoResumeEnabled").globalValue).toBe(false);
  } finally { await config.update("autoResumeEnabled", undefined); }
  expect(config.get("autoResumeEnabled", false)).toBe(true);
});
