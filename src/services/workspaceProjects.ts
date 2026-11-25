import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from 'node:os';
import type { DashboardCliProject } from "../domain/dashboard/types";
import { getSqliteStateStore } from "../storage/sqliteState";
import { normalizeNativePath } from "../utils/nativePaths";
import { runCrossWindowExclusive, sharedPathKey } from "../utils/crossWindowOperations";
import { waitWithin } from "../utils/concurrency";

const NAMESPACE = "workspace-projects";
const HIDDEN_NAMESPACE = "hidden-workspace-projects";

export function hiddenWorkspaceProjectPaths(): string[] {
  return getSqliteStateStore()?.keys(HIDDEN_NAMESPACE) ?? [];
}

export function workspaceProjectLabels(projects: DashboardCliProject[]): DashboardCliProject[] {
  const hidden = new Set(hiddenWorkspaceProjectPaths());
  return [...new Map([...projects, ...readWorkspaceProjects()].map(project => [projectStorageKey(project.path), project])).values()]
    .filter(project => !hidden.has(projectStorageKey(project.path)));
}

export function validateProjectName(name: unknown, kind = 'project'): string {
  if (
    typeof name !== "string" ||
    name !== name.trim() ||
    name.length > 120 ||
    !name.length ||
    /[<>:"/\\|?*]/.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32) ||
    /[. ]$/.test(name) ||
    /^\.{1,2}$/.test(name) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
  )
    throw new Error(`Enter a ${kind} name of up to 120 characters without path separators or reserved filename characters.`);
  return name;
}

function projectStorageKey(projectPath: unknown): string {
  if (typeof projectPath !== "string" || projectPath.length > 4096 || projectPath.includes("\0"))
    throw new Error("Choose a saved project before editing it.");
  const normalized = normalizeNativePath(projectPath.trim());
  if (!path.isAbsolute(normalized)) throw new Error("Choose an absolute project folder path.");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

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

/** Create one child without registering a project or adopting an existing path. */
export async function createWorkspaceFolder(name: unknown, folder: unknown): Promise<string> {
  const label = validateProjectName(name, 'folder');
  if (typeof folder !== 'string' || folder.length > 4096 || folder.includes('\0') || !path.isAbsolute(normalizeNativePath(folder.trim())))
    throw new Error('Choose an absolute parent folder path on the selected system.');
  return waitWithin((async () => {
    const parent = await fs.realpath(normalizeNativePath(folder.trim()));
    if (!(await fs.stat(parent)).isDirectory()) throw new Error('The parent path must be an existing folder.');
    const destination = path.join(parent, label);
    try { await fs.mkdir(destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A file or folder already exists with that name. Choose another name.');
      throw error;
    }
    return destination;
  })(), 5000, `Folder creation was not confirmed. Check ${folder} before retrying; the request was not replayed.`);
}

export function readWorkspaceProjects(namespace = NAMESPACE): DashboardCliProject[] {
  const store = getSqliteStateStore();
  return store
    ? store.keys(namespace).flatMap((key) => {
        const project = store.get<DashboardCliProject>(namespace, key);
        return project &&
          typeof project.path === "string" &&
          path.isAbsolute(project.path) &&
          typeof project.label === "string"
          ? [project]
          : [];
      })
    : [];
}

export function renameWorkspaceProject(projectPath: unknown, name: unknown, namespace = NAMESPACE): DashboardCliProject {
  const key = projectStorageKey(projectPath);
  const label = validateProjectName(name);
  const store = getSqliteStateStore();
  if (!store) throw new Error("Project storage is unavailable. The project was not renamed.");
  const project = store.get<DashboardCliProject>(namespace, key);
  if (!project) throw new Error("This project is not saved on the selected system. Refresh the project list and try again.");
  const updated = { ...project, label };
  store.set(namespace, key, updated);
  return updated;
}

export function removeWorkspaceProject(projectPath: unknown, namespace = NAMESPACE): void {
  const key = projectStorageKey(projectPath);
  const store = getSqliteStateStore();
  if (!store) throw new Error("Project storage is unavailable. The project was not removed.");
  store.transaction(() => {
    store.set(namespace, key, undefined);
    if(namespace === NAMESPACE)store.set(HIDDEN_NAMESPACE, key, true);
  });
}

/** Register the selected folder, creating a named child only when needed. */
export async function createWorkspaceProject(name: unknown, folder: unknown, namespace = NAMESPACE): Promise<DashboardCliProject> {
  const label = name === undefined || name === "" ? "" : validateProjectName(name);
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
  const destination = path.join(parent, label);
  const target = await waitWithin(fs.realpath(destination), 5_000, "The project folder did not respond.").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return destination;
    throw error;
  });
  return runCrossWindowExclusive(sharedPathKey("create-project", target), "Create workspace project", async () => {
    const store = getSqliteStateStore();
    if (!store) throw new Error("Project storage is unavailable. No folder was created.");
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    const saved = store.get<DashboardCliProject>(namespace, key);
    if (!saved && store.keys(namespace).length >= 200)
      throw new Error("The saved project list is full (200 projects). No folder was created.");
    let created = false;
    try {
      if (label) {
        await waitWithin(fs.mkdir(target), 5_000, `Project creation was not confirmed. Check ${target} before retrying.`);
        created = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await waitWithin(fs.stat(target), 5_000, "The project folder did not respond.")).isDirectory())
      throw new Error("A file already exists at the project path. Choose a folder or another name.");
    if (saved) { if(namespace === NAMESPACE)store.set(HIDDEN_NAMESPACE, key, undefined); return saved; }
    const project: DashboardCliProject = { id: target, label: label || path.basename(target) || target, path: target };
    try {
      store.set(namespace, key, project);
      if(namespace === NAMESPACE)store.set(HIDDEN_NAMESPACE, key, undefined);
    } catch (error) {
      throw new Error(
        `The ${created ? 'folder was created at' : 'existing folder is unchanged at'} ${target}, but the project list could not be saved. Add this existing folder after storage recovers. ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return project;
  });
}
