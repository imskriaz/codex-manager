import {DEFAULT_OFFICE_PRESENTATION} from '../src/domain/officePresentation';
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
import { DEFAULT_USER_WORKSPACE_PROMPT } from '../src/domain/teamWorkspacePresentation';

beforeEach(() => {
  config.values.clear();
  config.update.mockClear();
});
describe("Team storage settings", () => {
  it("keeps saved PostgreSQL credentials out of settings responses", async () => {
    config.values.set("officePostgresUrl", "postgresql://private:secret@db.example/team");
    expect(readTeamSettings().postgresConfigured).toBe(true);
    expect(JSON.stringify(readTeamSettings())).not.toMatch(/private:secret|db\.example|postgresql:/);
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
      globalPrompt: DEFAULT_USER_WORKSPACE_PROMPT,
      defaultModel: "gpt-6-luna",
      modelMode:'manual',profilePicker:true,routerModel:'gpt-6-luna',regularModel:'gpt-6-luna',professionalModel:'gpt-6.1-sol',expertModel:'gpt-6.1-terra',
      defaultSkills:['project-planning','document-drafting','spreadsheet-analysis','meeting-follow-up','research-briefs','operations-tracking'],
      sessionRetentionDays: 30,
      autoPresentation:true,
      presentation:DEFAULT_OFFICE_PRESENTATION,
      maxActiveRequests: 2,
      workspaceRoot: "C:/new-users",
      databaseProvider: "postgres",
      postgresConfigured: true
    });
  });
});
it("validates and saves the shared active request limit",async()=>{
 await expect(saveTeamSettings({maxActiveRequests:0})).rejects.toThrow("1 and 20");
 await expect(saveTeamSettings({maxActiveRequests:2.5})).rejects.toThrow("1 and 20");
 expect(config.update).not.toHaveBeenCalled();
 expect((await saveTeamSettings({maxActiveRequests:4})).maxActiveRequests).toBe(4);
});
it("validates session retention for backend cleanup",async()=>{
 await expect(saveTeamSettings({sessionRetentionDays:0})).rejects.toThrow("1 to 365");
 expect((await saveTeamSettings({sessionRetentionDays:45})).sessionRetentionDays).toBe(45);
});
it("saves and clears the global prompt without exposing database credentials or accepting invalid input",async()=>{
 expect(readTeamSettings().globalPrompt).toContain('User Workspace');
 expect(readTeamSettings().globalPrompt).toContain('reports/report.txt?download=1');
 config.values.set("officePostgresUrl","postgresql://secret@host/db");
 expect((await saveTeamSettings({globalPrompt:"Be useful to every user."})).globalPrompt).toBe("Be useful to every user.");
 expect(JSON.stringify(readTeamSettings())).not.toContain("secret");
 expect((await saveTeamSettings({globalPrompt:""})).globalPrompt).toBe("");
 config.update.mockClear();
 await expect(saveTeamSettings({workspaceRoot:"C:/team",globalPrompt:"x".repeat(16001)})).rejects.toThrow("16,000");
 await expect(saveTeamSettings({globalPrompt:42})).rejects.toThrow("16,000");
 expect(config.update).not.toHaveBeenCalled();
});
it("saves and clears the default model and validates the entire form before writing",async()=>{
 expect((await saveTeamSettings({defaultModel:"chosen-model"})).defaultModel).toBe("chosen-model");
 expect((await saveTeamSettings({defaultModel:""})).defaultModel).toBe("");
 config.update.mockClear();
 for(const defaultModel of [42,"bad model","x".repeat(129)])await expect(saveTeamSettings({globalPrompt:"changed",defaultModel})).rejects.toThrow("valid default");
 expect(config.update).not.toHaveBeenCalled();
});

it('validates the complete automatic profile configuration before saving and preserves manual mode',async()=>{
 expect(readTeamSettings().modelMode).toBe('manual');
 await expect(saveTeamSettings({modelMode:'auto',expertModel:'invalid model'})).rejects.toThrow();expect(config.update).not.toHaveBeenCalled();
 const saved=await saveTeamSettings({modelMode:'auto',profilePicker:false,routerModel:'light',regularModel:'fast',professionalModel:'work',expertModel:'deep'});
 expect(saved).toMatchObject({modelMode:'auto',profilePicker:false,routerModel:'light',expertModel:'deep'});
 await expect(saveTeamSettings({modelMode:'other'})).rejects.toThrow();await expect(saveTeamSettings({profilePicker:'false'})).rejects.toThrow();
});

it('validates and persists presentation, automatic panels and skill arrays',async()=>{
 const presentation={...structuredClone(DEFAULT_OFFICE_PRESENTATION),assistantName:'Workmate'};
 expect(await saveTeamSettings({presentation,autoPresentation:false,defaultSkills:['project-planning']})).toMatchObject({presentation,autoPresentation:false});expect(config.values.get('officeDefaultSkills')).toEqual(['project-planning']);
 await expect(saveTeamSettings({autoPresentation:'yes'})).rejects.toThrow('presentation');
 await expect(saveTeamSettings({presentation:{...presentation,assistantName:''}})).rejects.toThrow('assistant name');
 config.update.mockClear();await expect(saveTeamSettings({presentation:{...presentation,assistantName:'New'},expectedPresentation:DEFAULT_OFFICE_PRESENTATION})).rejects.toThrow('another window');expect(config.update).not.toHaveBeenCalled();
});
