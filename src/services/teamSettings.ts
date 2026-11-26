import * as path from "node:path";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";
import { DEFAULT_USER_WORKSPACE_PROMPT } from '../domain/teamWorkspacePresentation';
import { DEFAULT_OFFICE_SKILLS, type OfficeSkillId } from '../domain/officeSkills';
import {DEFAULT_OFFICE_PRESENTATION,validateOfficePresentation,type OfficePresentation} from '../domain/officePresentation';
import {updateConfigurationBatch} from '../storage/sqliteContext';
import {runCrossWindowExclusive} from '../utils/crossWindowOperations';
import {readOfficeIntegrations,publicOfficeIntegrations,validateOfficeIntegrations,type OfficeIntegrations} from './officeIntegrations';
import { ensureOfficeStorageReady } from '../storage/sqliteContext';
import { getSqliteStateStore } from '../storage/sqliteState';

export function readTeamSettings() {
  const config = getCodexManagerConfiguration();
  let presentation:OfficePresentation;
  try{presentation=validateOfficePresentation(config.get<unknown>('officePresentation',DEFAULT_OFFICE_PRESENTATION));}catch{presentation=structuredClone(DEFAULT_OFFICE_PRESENTATION);}
  return {
    services:publicOfficeIntegrations(),
    presentation,
    maxActiveRequests: config.get<number>("officeMaxActiveRequests", 2),
    globalPrompt: config.get<string>("officeGlobalPrompt", DEFAULT_USER_WORKSPACE_PROMPT),
    defaultModel: config.get<string>("officeDefaultModel", "gpt-6-luna"),
    modelMode: config.get<string>('officeModelMode', 'manual') === 'auto' ? 'auto' as const : 'manual' as const,
    autoPresentation:config.get<boolean>('officeAutoPresentation',false),
    profilePicker:config.get<boolean>('officeProfilePicker',true),
    routerModel: config.get<string>('officeRouterModel', 'gpt-6-luna'),
    regularModel: config.get<string>('officeRegularModel', 'gpt-6-luna'),
    professionalModel: config.get<string>('officeProfessionalModel', 'gpt-6.1-sol'),
    expertModel: config.get<string>('officeExpertModel', 'gpt-6.1-terra'),
    workspaceRoot:
      config.get<string>("officeWorkspaceRoot", "").trim() ||
      path.join(getCodexManagerStorageRoot(), "office-workspaces"),
    databaseProvider: config.get<string>("officeDatabaseProvider", "sqlite") === "postgres" ? "postgres" : "sqlite",
    postgresConfigured: Boolean(config.get<string>("officePostgresUrl", "").trim()),
    defaultSkills: (()=>{const raw=config.get<unknown>('officeDefaultSkills');let value:unknown=raw;if(typeof raw==='string'){try{value=JSON.parse(raw);}catch{value=undefined;}}return (Array.isArray(value)?value:DEFAULT_OFFICE_SKILLS).filter((id): id is OfficeSkillId => presentation.catalog.some(skill=>skill.id===id));})()
    ,sessionRetentionDays: config.get<number>('officeSessionRetentionDays',30)
  };
}

export async function saveTeamSettings(input: Record<string, unknown>): Promise<ReturnType<typeof readTeamSettings>> {
 return runCrossWindowExclusive('state:office-settings','Save workspace settings',()=>saveSettings(input),{waitMs:2000});
}
async function saveSettings(input:Record<string,unknown>):Promise<ReturnType<typeof readTeamSettings>>{
  if(input['expectedSettings']!==undefined){const expected=input['expectedSettings'];if(!expected||typeof expected!=='object'||Array.isArray(expected))throw new Error('Reload workspace settings before saving.');const current=readTeamSettings() as unknown as Record<string,unknown>;for(const [key,value] of Object.entries(expected))if(JSON.stringify(current[key])!==JSON.stringify(value))throw new Error('Workspace settings changed in another window. Reload settings before saving.');}
  const config = getCodexManagerConfiguration();
  const updates: Array<[string, string | number | boolean | string[] | OfficePresentation | OfficeIntegrations]> = [];
  if(input['services']!==undefined)updates.push(['officeServices',validateOfficeIntegrations(input['services'],readOfficeIntegrations())]);
  const presentation=input['presentation']!==undefined?validateOfficePresentation(input['presentation']):readTeamSettings().presentation;
  if(input['presentation']!==undefined&&input['expectedPresentation']!==undefined&&JSON.stringify(input['expectedPresentation'])!==JSON.stringify(readTeamSettings().presentation))throw new Error('Workspace presentation changed in another window. Reopen the editor before saving.');
  if(input['presentation']!==undefined)updates.push(['officePresentation',presentation]);
  if(input['autoPresentation']!==undefined){if(typeof input['autoPresentation']!=='boolean')throw new Error('Choose a valid workspace presentation setting.');updates.push(['officeAutoPresentation',input['autoPresentation']]);}
  if(input['profilePicker']!==undefined){if(typeof input['profilePicker']!=='boolean')throw new Error('Choose a valid profile selection setting.');updates.push(['officeProfilePicker',input['profilePicker']]);}
  if(input['defaultSkills']!==undefined){if(!Array.isArray(input['defaultSkills'])||input['defaultSkills'].some(id=>typeof id!=='string'||!presentation.catalog.some(skill=>skill.id===id)))throw new Error('Choose valid workspace skills.');updates.push(['officeDefaultSkills',[...new Set(input['defaultSkills'] as string[])]]);}
  if(input['sessionRetentionDays']!==undefined){const days=input['sessionRetentionDays'];if(typeof days!=='number'||!Number.isInteger(days)||days<1||days>365)throw new Error('Choose a session retention from 1 to 365 days.');updates.push(['officeSessionRetentionDays',days]);}
  if (input['modelMode'] !== undefined) {
    if (input['modelMode']!=='manual'&&input['modelMode']!=='auto') throw new Error('Choose manual or automatic model selection.');
    updates.push(['officeModelMode',input['modelMode'] as string]);
  }
  for (const key of ['routerModel','regularModel','professionalModel','expertModel'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(input[key])) throw new Error('Choose valid models for automatic selection.');
    updates.push(['office'+key[0]!.toUpperCase()+key.slice(1),input[key]]);
  }
  if (input["defaultModel"] !== undefined) {
    if (typeof input["defaultModel"] !== "string" || input["defaultModel"] !== '' && !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(input["defaultModel"])) throw new Error("Choose a valid default User Workspace model.");
    updates.push(["officeDefaultModel", input["defaultModel"]]);
  }
  if (input["globalPrompt"] !== undefined) {
    if (typeof input["globalPrompt"] !== "string" || input["globalPrompt"].length > 16_000) throw new Error("Use up to 16,000 characters for the global User Workspace prompt.");
    updates.push(["officeGlobalPrompt", input["globalPrompt"]]);
  }
  if (input["maxActiveRequests"] !== undefined) {
    const value = input["maxActiveRequests"];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) throw new Error("Choose between 1 and 20 active requests.");
    updates.push(["officeMaxActiveRequests", value]);
  }
  if (input["workspaceRoot"] !== undefined) {
    if (typeof input["workspaceRoot"] !== "string" || !path.isAbsolute(input["workspaceRoot"].trim()))
      throw new Error("Choose an absolute workspace folder path.");
    updates.push(["officeWorkspaceRoot", input["workspaceRoot"].trim()]);
  }
  if (input["databaseProvider"] !== undefined) {
    if (input["databaseProvider"] !== "sqlite" && input["databaseProvider"] !== "postgres")
      throw new Error("Choose SQLite or PostgreSQL.");
    if (input['databaseProvider'] === 'sqlite' && getSqliteStateStore()?.get('migrations', 'office-postgres-v1')) throw new Error('This workspace has migrated to PostgreSQL. Restore its connection instead of switching to an empty local store.');
    updates.push(["officeDatabaseProvider", input["databaseProvider"]]);
  }
  if (input["postgresUrl"] !== undefined) {
    let url: URL;
    try {
      if (typeof input["postgresUrl"] !== "string") throw new Error();
      url = new URL(input["postgresUrl"].trim());
    } catch {
      throw new Error("Enter a valid PostgreSQL connection URL.");
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname)
      throw new Error("Enter a valid PostgreSQL connection URL.");
    updates.push(["officePostgresUrl", (input["postgresUrl"] as string).trim()]);
  }
  if (
    input["databaseProvider"] === "postgres" &&
    !input["postgresUrl"] &&
    !config.get<string>("officePostgresUrl", "").trim()
  )
    throw new Error("Enter a PostgreSQL connection URL before enabling PostgreSQL.");
  if (!updates.length) throw new Error("Choose a Team setting to save.");
  // Validate the whole form before changing any setting.
  await updateConfigurationBatch(config,updates);
  if (input['databaseProvider'] === 'postgres' || input['postgresUrl'] !== undefined) await ensureOfficeStorageReady();
  return readTeamSettings();
}
