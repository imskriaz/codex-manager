import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("extension manifest configuration", () => {
  it("publishes the Codex Manager brand under the imskriaz namespace", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      name?: string;
      displayName?: string;
      version?: string;
      preview?: boolean;
      publisher?: string;
      repository?: { url?: string };
    };

    expect(manifest).toMatchObject({
      name: "codex-manager",
      displayName: "Codex Manager",
      preview: false,
      publisher: "imskriaz",
      repository: { url: "https://github.com/imskriaz/codex-manager.git" }
    });
    expect(manifest.version).toBe("1.5.2-pre.1");
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).activationEvents)
      .toContain("onWebviewPanel:codexQuotaSummary");
  });

  it("ships a Marketplace changelog", () => {
    const root = path.resolve(__dirname, "..");
    const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

    expect(changelog).toContain("# Changelog");
    expect(changelog.match(/^## (.+)$/m)?.[1]).toBe(manifest.version);
    const releases = changelog.match(/^## \d+\.\d+\.\d+$/gm) ?? [];
    expect(new Set(releases).size).toBe(releases.length);
    expect(changelog).toContain("## 1.0.7");
    expect(changelog).toContain("## 1.0.3");
  });

  it("keeps required runtime modules in the VSIX dependency set", () => {
    const root = path.resolve(__dirname, "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };

    expect(manifest.dependencies).toMatchObject({
      undici: "6.29.1",
      ws: expect.any(String)
    });
    expect(manifest.dependencies?.["@types/ws"]).toBeUndefined();
    expect(manifest.devDependencies?.["@types/ws"]).toEqual(expect.any(String));
    expect(manifest.scripts?.package).toContain("--no-yarn --dependencies");
    expect(manifest.scripts?.package).not.toContain("--pre-release");
    expect(manifest.scripts?.package).toContain("tools/verify-vsix-layout.mjs");
    expect(fs.readFileSync(path.join(root, ".vscodeignore"), "utf8")).toContain("*.vsix.sha256");
    expect(manifest.scripts?.["mobile:start"]).toBeUndefined();
    expect(manifest.scripts?.["mobile:typecheck"]).toBeUndefined();
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages?.[""]?.version).toBe(manifest.version);
  });

  it("ships English as the only public language option", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { enum?: string[]; default?: string }>;
        };
      };
    };

    expect(manifest.contributes?.configuration?.properties?.["codexManager.displayLanguage"]).toMatchObject({
      enum: ["en"],
      default: "en"
    });
  });

  it("does not bundle the retired announcements feature", () => {
    const root = path.resolve(__dirname, "..");
    for (const file of ["announcements.json", "src/services/announcements.ts", "webview-src/dashboard/announcementCenter.tsx"])
      expect(fs.existsSync(path.join(root, file))).toBe(false);
  });

  it("uses the Codex branding asset for the extension icon", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { icon?: string };
    expect(manifest.icon).toBe("media/product-icons/codex-openai.png");
    expect(fs.statSync(path.resolve(path.dirname(manifestPath), manifest.icon!)).size).toBeGreaterThan(0);
    expect(fs.existsSync(path.resolve(path.dirname(manifestPath), "media/CT_logo_transparent_square_hd.png"))).toBe(
      false
    );
  });

  it("contributes the Codex status-bar icon and its font asset", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        icons?: Record<string, { default?: { fontPath?: string; fontCharacter?: string } }>;
      };
    };
    const icon = manifest.contributes?.icons?.["codex-openai"];

    expect(icon?.default).toEqual({
      fontPath: "./media/product-icons/codex-icons.woff",
      fontCharacter: "\\EA01"
    });
    expect(fs.statSync(path.resolve(path.dirname(manifestPath), icon!.default!.fontPath!)).size).toBeGreaterThan(0);
  });

  it("declares the auto switch reload window setting", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; default?: unknown; markdownDescription?: string }>;
        };
      };
    };

    const property = manifest.contributes?.configuration?.properties?.["codexManager.autoSwitchReloadWindowEnabled"];

    expect(property).toBeTruthy();
    expect(property).toMatchObject({
      type: "boolean",
      default: false
    });
    expect(property?.markdownDescription).toContain("Automatically reload");
  });

  it("declares auto resume as an opt-in setting", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; scope?: string; default?: unknown; markdownDescription?: string }>;
        };
      };
    };

    const property = manifest.contributes?.configuration?.properties?.["codexManager.autoResumeEnabled"];
    expect(property).toMatchObject({ type: "boolean", scope: "machine", default: false });
    expect(property?.markdownDescription).not.toContain("Experimental");
    expect(property?.markdownDescription).toContain("Auto Switch on");
    expect(property?.markdownDescription).toContain("unfinished parent chats");
    expect(property?.markdownDescription).toContain("VS Code restart");
    expect(manifest.contributes?.configuration?.properties?.["codexManager.autoResumeGoalOnlyEnabled"])
      .toMatchObject({ type: "boolean", scope: "machine", default: true });
  });

  it("declares quota graph history retention with a 7-day default", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: { configuration?: { properties?: Record<string, { type?: string; default?: unknown }> } };
    };

    expect(manifest.contributes?.configuration?.properties?.["codexManager.dailyTokenUsageEnabled"]).toMatchObject({ type: "boolean", default: true });
    expect(manifest.contributes?.configuration?.properties?.["codexManager.dailyTokenUsageIntervalMinutes"]).toMatchObject({ type: "number", default: 60, minimum: 1, maximum: 1440 });
    expect(manifest.contributes?.configuration?.properties?.["codexManager.usageHistoryRetentionDays"]).toMatchObject({
      type: "number",
      minimum: 1,
      default: 7
    });
  });

  it("declares a cross-system WebSocket toggle without the retired always-online preference", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; default?: unknown; markdownDescription?: string }>;
        };
      };
    };
    expect(manifest.contributes?.configuration?.properties?.["codexManager.webDashboardAlwaysOnlineEnabled"]).toBeUndefined();
    const property = manifest.contributes?.configuration?.properties?.["codexManager.webSocketServerEnabled"];
    expect(property).toMatchObject({ type: "boolean", default: true });
    expect(fs.existsSync(path.resolve(path.dirname(manifestPath), "tools", "always-online-server.js"))).toBe(true);
  });

  it("declares independent 5-hour and weekly quota warning thresholds", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; minimum?: number; maximum?: number; default?: unknown }>;
        };
      };
    };
    const properties = manifest.contributes?.configuration?.properties;

    expect(properties?.["codexManager.quotaWarningThreshold"]).toMatchObject({
      type: "number",
      minimum: 0,
      maximum: 90,
      default: 10
    });
    expect(properties?.["codexManager.quotaWarningWeeklyThreshold"]).toMatchObject({
      type: "number",
      minimum: 0,
      maximum: 90,
      default: 1
    });
  });

  it("keeps machine-specific operations out of Settings Sync", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { scope?: string; ignoreSync?: boolean; markdownDescription?: string }>;
        };
      };
    };
    const properties = manifest.contributes?.configuration?.properties;

    expect(properties?.["codexManager.codexAppRestartMode"]?.scope).toBe("machine");
    expect(properties?.["codexManager.codexAppRestartEnabled"]?.scope).toBe("machine");
    expect(properties?.["codexManager.codexAppPath"]?.scope).toBe("machine");
    expect(properties?.["codexManager.codexCliPath"]?.scope).toBe("machine");
    expect(properties?.["codexManager.webDashboardEnabled"]?.scope).toBe("machine");
    expect(properties?.["codexManager.cliIntegrationEnabled"]?.scope).toBe("machine");
    expect(properties?.["codexManager.cloudflaredDomain"]?.scope).toBeUndefined();
    expect(properties?.["codexManager.encryptedSyncEnabled"]).toMatchObject({
      scope: "machine",
      ignoreSync: true
    });
    expect(properties?.["codexManager.fullCrossPcAccountSyncEnabled"]).toMatchObject({
      scope: "machine",
      ignoreSync: true
    });
    expect(properties?.["codexManager.fullCrossPcAccountSyncEnabled"]?.markdownDescription).toContain(
      "off keeps logins local"
    );
    expect(properties?.["codexManager.fullCrossPcAccountSyncEnabled"]?.markdownDescription).toContain("tokens");
    expect(properties?.["codexManager.encryptedSyncScheduleMinutes"]).toBeUndefined();
  });
});


describe("account-level token refresh control", () => {
  it("does not expose the removed global token-refresh setting", () => {
    const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(manifest.contributes.configuration.properties["codexManager.backgroundTokenRefreshEnabled"]).toBeUndefined();
    expect(fs.readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8")).not.toContain("backgroundTokenRefreshEnabled");
  });
});
