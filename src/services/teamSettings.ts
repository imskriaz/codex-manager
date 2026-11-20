import * as path from "node:path";
import * as vscode from "vscode";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";

export function readTeamSettings() {
  const config = getCodexManagerConfiguration();
  return {
    workspaceRoot:
      config.get<string>("officeWorkspaceRoot", "").trim() ||
      path.join(getCodexManagerStorageRoot(), "office-workspaces"),
    databaseProvider: config.get<string>("officeDatabaseProvider", "sqlite") === "postgres" ? "postgres" : "sqlite",
    postgresConfigured: Boolean(config.get<string>("officePostgresUrl", "").trim())
  };
}

export async function saveTeamSettings(input: Record<string, unknown>): Promise<ReturnType<typeof readTeamSettings>> {
  const config = getCodexManagerConfiguration();
  const updates: Array<[string, string]> = [];
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
