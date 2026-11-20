import { beforeEach, describe, expect, it, vi } from "vitest";
const config = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
    update: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    })
  };
});
vi.mock("../src/infrastructure/config/extensionSettings", () => ({ getCodexManagerConfiguration: () => config }));
import { readTeamSettings, saveTeamSettings } from "../src/services/teamSettings";

beforeEach(() => {
  config.values.clear();
  config.update.mockClear();
});
describe("Team storage settings", () => {
  it("keeps saved PostgreSQL credentials out of settings responses", async () => {
    config.values.set("officePostgresUrl", "postgresql://private:secret@db.example/team");
    expect(readTeamSettings().postgresConfigured).toBe(true);
    expect(JSON.stringify(readTeamSettings())).not.toMatch(/secret|private|db\.example/);
    const saved = await saveTeamSettings({ databaseProvider: "postgres" });
    expect(saved.databaseProvider).toBe("postgres");
    expect(config.values.get("officePostgresUrl")).toContain("secret");
  });
  it("validates the complete form before writing", async () => {
    await expect(
      saveTeamSettings({ workspaceRoot: "C:/team", databaseProvider: "postgres", postgresUrl: "https://db.example" })
    ).rejects.toThrow("PostgreSQL");
    expect(config.update).not.toHaveBeenCalled();
    await expect(saveTeamSettings({ databaseProvider: "postgres" })).rejects.toThrow("connection URL");
    await expect(saveTeamSettings({ workspaceRoot: "../outside" })).rejects.toThrow("absolute");
    expect(config.update).not.toHaveBeenCalled();
  });
  it("saves independent workspace and database sections without clearing existing settings", async () => {
    config.values.set("officeWorkspaceRoot", "C:/existing");
    await saveTeamSettings({ databaseProvider: "postgres", postgresUrl: "postgresql://host/team" });
    expect(readTeamSettings().workspaceRoot).toBe("C:/existing");
    await saveTeamSettings({ workspaceRoot: "C:/new-users" });
    expect(readTeamSettings()).toEqual({
      workspaceRoot: "C:/new-users",
      databaseProvider: "postgres",
      postgresConfigured: true
    });
  });
});
