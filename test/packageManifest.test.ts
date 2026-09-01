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
    expect(manifest.version).toMatch(/^1\.0\.4-pre\d+$/);
  });

  it("ships a Marketplace changelog", () => {
    const root = path.resolve(__dirname, "..");
    const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

    expect(changelog).toContain("# Changelog");
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
      undici: "6.28.0",
      ws: expect.any(String)
    });
    expect(manifest.dependencies?.["@types/ws"]).toBeUndefined();
    expect(manifest.devDependencies?.["@types/ws"]).toEqual(expect.any(String));
    expect(manifest.scripts?.package).toContain("--no-yarn --dependencies");
    expect(manifest.scripts?.package).toContain("tools/verify-vsix-layout.mjs");
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

  it("does not bundle promotional announcement popups", () => {
    const announcementPath = path.resolve(__dirname, "../announcements.json");
    const raw = fs.readFileSync(announcementPath, "utf8");
    const response = JSON.parse(raw) as { announcements?: Array<{ popup?: boolean }> };

    expect(raw).not.toMatch(/aideck|wannanbigpig/i);
    expect(response.announcements?.every((announcement) => announcement.popup !== true)).toBe(true);
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

  it("declares quota graph history retention with a 7-day default", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: { configuration?: { properties?: Record<string, { type?: string; default?: unknown }> } };
    };

    expect(manifest.contributes?.configuration?.properties?.["codexManager.usageHistoryRetentionDays"]).toMatchObject({
      type: "number",
      minimum: 1,
      default: 7
    });
  });

  it("declares the optional always-online WebSocket host setting", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; default?: unknown; markdownDescription?: string }>;
        };
      };
    };
    const property = manifest.contributes?.configuration?.properties?.["codexManager.webDashboardAlwaysOnlineEnabled"];
    expect(property).toMatchObject({ type: "boolean", default: false });
    expect(property?.markdownDescription).toContain("detached Node.js");
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
    expect(properties?.["codexManager.encryptedSyncEnabled"]?.markdownDescription).toContain("Major vault changes");
    expect(properties?.["codexManager.encryptedSyncEnabled"]?.markdownDescription).toContain("WebSocket/HTTP");
    expect(properties?.["codexManager.encryptedSyncScheduleMinutes"]).toBeUndefined();
  });
});
