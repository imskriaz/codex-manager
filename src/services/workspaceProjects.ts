import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from 'node:os';
import type { DashboardCliProject } from "../domain/dashboard/types";
import { getSqliteStateStore } from "../storage/sqliteState";
import { normalizeNativePath } from "../utils/nativePaths";
import { runCrossWindowExclusive, sharedPathKey } from "../utils/crossWindowOperations";
import { waitWithin } from "../utils/concurrency";

const NAMESPACE = "workspace-projects";

/** Authenticated dashboard users browse folders on the selected host, never browser-local paths. */
export async function browseWorkspaceFolders(folder?: unknown) {
  if (folder !== undefined && (typeof folder !== 'string' || folder.length > 4096 || folder.includes('\0') || folder.trim() && !path.isAbsolute(normalizeNativePath(folder.trim()))))
    throw new Error('Choose an absolute folder path on the selected system.');
  return waitWithin((async () => {
    const current = await fs.realpath(typeof folder === 'string' && folder.trim() ? normalizeNativePath(folder.trim()) : homedir());
    const directory = await fs.opendir(current);
    const folders: Array<{ name: string; path: string }> = [];
    let truncated = false;
    for await (const entry of directory) {
        if (!entry.isDirectory()) continue;
        if (folders.length >= 200) { truncated = true; break; }
        folders.push({ name: entry.name, path: path.join(current, entry.name) });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    const roots = process.platform === 'win32' ? (await Promise.all(Array.from({ length: 26 }, async (_, i) => {
      const drive = `${String.fromCharCode(65 + i)}:\\`;
      return await waitWithin(fs.stat(drive), 300, 'Drive unavailable.').then(stat => stat.isDirectory() ? drive : undefined, () => undefined);
    }))).filter((value): value is string => !!value) : ['/'];
    return { path: current, parent: path.dirname(current), folders, roots, ...(truncated ? { warning: 'Showing the first 200 folders. Enter a path to open another folder.' } : {}) };
  })(), 5000, 'Folder browsing timed out. Check the drive or reconnect before retrying.');
}

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

/** Register the selected folder, creating a named child only when needed. */
export async function createWorkspaceProject(name: unknown, folder: unknown): Promise<DashboardCliProject> {
  if (name === undefined) name = "";
  if (
    typeof name !== "string" ||
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
  const destination = path.join(parent, name);
  const target = await waitWithin(fs.realpath(destination), 5_000, "The project folder did not respond.").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return destination;
    throw error;
  });
  return runCrossWindowExclusive(sharedPathKey("create-project", target), "Create workspace project", async () => {
    const store = getSqliteStateStore();
    if (!store) throw new Error("Project storage is unavailable. No folder was created.");
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    const saved = store.get<DashboardCliProject>(NAMESPACE, key);
    if (!saved && store.keys(NAMESPACE).length >= 200)
      throw new Error("The saved project list is full (200 projects). No folder was created.");
    let created = false;
    try {
      if (name) {
        await waitWithin(fs.mkdir(target), 5_000, `Project creation was not confirmed. Check ${target} before retrying.`);
        created = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await waitWithin(fs.stat(target), 5_000, "The project folder did not respond.")).isDirectory())
      throw new Error("A file already exists at the project path. Choose a folder or another name.");
    if (saved) return saved;
    const project = { id: target, label: name || path.basename(target) || target, path: target };
    try {
      store.set(NAMESPACE, key, project);
    } catch (error) {
      throw new Error(
        `The ${created ? 'folder was created at' : 'existing folder is unchanged at'} ${target}, but the project list could not be saved. Add this existing folder after storage recovers. ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return project;
  });
}
