import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("experimental workspace setting", () => {
  it("is disabled by default and is presented as an experimental workspace toggle", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes?: { configuration?: { properties?: Record<string, { default?: unknown; scope?: unknown; markdownDescription?: string }> } };
    };
    const property = manifest.contributes?.configuration?.properties?.["codexManager.cliIntegrationEnabled"];
    const settings = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");

    expect(property).toMatchObject({ default: false, scope: "machine" });
    expect(property?.markdownDescription).toContain("Experimental Workspace");
    expect(settings).toContain('"Enable workspace (Experimental)"');
    expect(settings).toContain('"Disabled by default. Enable the workspace view, sessions, and terminal tools in the dashboard."');
  });
});
