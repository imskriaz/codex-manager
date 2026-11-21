import * as path from "node:path";
import * as vscode from "vscode";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";

export function readTeamSettings() {
  const config = getCodexManagerConfiguration();
  return {
    maxActiveRequests: config.get<number>("officeMaxActiveRequests", 2),
    globalPrompt: config.get<string>("officeGlobalPrompt", ""),
    defaultModel: config.get<string>("officeDefaultModel", ""),
    workspaceRoot:
      config.get<string>("officeWorkspaceRoot", "").trim() ||
      path.join(getCodexManagerStorageRoot(), "office-workspaces"),
    databaseProvider: config.get<string>("officeDatabaseProvider", "sqlite") === "postgres" ? "postgres" : "sqlite",
    postgresConfigured: Boolean(config.get<string>("officePostgresUrl", "").trim())
  };
}

export async function saveTeamSettings(input: Record<string, unknown>): Promise<ReturnType<typeof readTeamSettings>> {
  const config = getCodexManagerConfiguration();
  const updates: Array<[string, string | number]> = [];
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
  for (const [key, value] of updates) await config.update(key, value, vscode.ConfigurationTarget.Global);
  return readTeamSettings();
}
