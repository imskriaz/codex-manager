import { isOpenWorkspaceProject } from "../webview-src/dashboard/helpers";
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("workspace setting", () => {
  it("is disabled by default and is presented as a supported workspace toggle", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes?: { configuration?: { properties?: Record<string, { default?: unknown; scope?: unknown; markdownDescription?: string }> } };
    };
    const property = manifest.contributes?.configuration?.properties?.["codexManager.cliIntegrationEnabled"];
    const settings = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");

    expect(property).toMatchObject({ default: false, scope: "machine" });
    expect(property?.markdownDescription).toContain("Workspace:");
    expect(property?.markdownDescription).not.toContain("Experimental");
    expect(settings).toContain('"Enable workspace"');
    expect(settings).toContain("Add chats and terminals to this dashboard.");
    expect(settings).not.toContain("codexSessionDefault");
  });
});

it("only automatically inspects open roots and their descendants", () => {
  const roots = [{ path: "D:\\Projects\\Codex-Manager" }, { path: "/work/App" }];
  expect(isOpenWorkspaceProject("d:/projects/codex-manager/src", roots)).toBe(true);
  expect(isOpenWorkspaceProject("d:/projects/app", [{ path: "D:/" }])).toBe(true);
  expect(isOpenWorkspaceProject("D:/Projects/Codex-Manager-other", roots)).toBe(false);
  expect(isOpenWorkspaceProject("/work/app", roots)).toBe(false);
  expect(isOpenWorkspaceProject("/work/App/src", roots)).toBe(true);
});
