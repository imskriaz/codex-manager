import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { DashboardCliProject } from "../domain/dashboard/types";
import { getSqliteStateStore } from "../storage/sqliteState";
import { normalizeNativePath } from "../utils/nativePaths";
import { runCrossWindowExclusive, sharedPathKey } from "../utils/crossWindowOperations";
import { waitWithin } from "../utils/concurrency";

const NAMESPACE = "workspace-projects";

export function readWorkspaceProjects(): DashboardCliProject[] {
  const store = getSqliteStateStore();
  return store
    ? store.keys(NAMESPACE).flatMap((key) => {
        const project = store.get<DashboardCliProject>(NAMESPACE, key);
        return project &&
          typeof project.path === "string" &&
          path.isAbsolute(project.path) &&
          typeof project.label === "string"
          ? [project]
          : [];
      })
    : [];
}

/** Create one new directory; an existing folder is never adopted or overwritten. */
export async function createWorkspaceProject(name: unknown, folder: unknown): Promise<DashboardCliProject> {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name !== name.trim() ||
    name.length > 120 ||
    /[<>:"/\\|?*]/.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32) ||
    /[. ]$/.test(name) ||
    /^\.{1,2}$/.test(name) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
  )
    throw new Error(
      "Enter a project name of up to 120 characters without path separators or reserved filename characters."
    );
  if (
    typeof folder !== "string" ||
    folder.length > 4096 ||
    folder.includes("\0") ||
    !path.isAbsolute(normalizeNativePath(folder.trim()))
  )
    throw new Error("Enter an absolute parent folder path on the selected system.");
  const parent = await waitWithin(
    fs.realpath(normalizeNativePath(folder.trim())),
    5_000,
    "The parent folder did not respond. Check the drive before retrying."
  );
  if (!(await waitWithin(fs.stat(parent), 5_000, "The parent folder did not respond.")).isDirectory())
    throw new Error("The parent path must be an existing folder.");
  const target = path.join(parent, name);
  return runCrossWindowExclusive(sharedPathKey("create-project", target), "Create workspace project", async () => {
    const store = getSqliteStateStore();
    if (!store) throw new Error("Project storage is unavailable. No folder was created.");
    if (store.keys(NAMESPACE).length >= 200)
      throw new Error("The saved project list is full (200 projects). No folder was created.");
    try {
      await waitWithin(fs.mkdir(target), 5_000, `Project creation was not confirmed. Check ${target} before retrying.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("A file or folder with this project name already exists. Choose another name.");
      throw error;
    }
    const project = { id: target, label: name, path: target };
    try {
      store.set(NAMESPACE, process.platform === "win32" ? target.toLowerCase() : target, project);
    } catch (error) {
      throw new Error(
        `The folder was created at ${target}, but the project list could not be saved. Add this existing folder after storage recovers. ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return project;
  });
}
