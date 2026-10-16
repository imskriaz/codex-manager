import * as path from "path";
import type * as vscode from "vscode";
import type { DashboardCliProject, DashboardCliSessionSummary } from "../domain/dashboard/types";
import { getSqliteStateStore } from "../storage/sqliteState";

const SESSION_PROJECT_BINDINGS_KEY = "codexManager.cliSessionProjectBindings.v1";
const MAX_BINDINGS = 500;

type SessionProjectBinding = { projectPath: string; updatedAt: number };

export async function stabilizeSessionProjectPaths(
  context: vscode.ExtensionContext,
  sessions: DashboardCliSessionSummary[],
  projects: DashboardCliProject[] = []
): Promise<DashboardCliSessionSummary[]> {
  const store = getSqliteStateStore();
  if (store) return store.transaction(() => {
    const result = stabilizeSessionProjectPathsInternal(store.get("global", SESSION_PROJECT_BINDINGS_KEY), sessions, projects);
    if (result.bindings) store.set("global", SESSION_PROJECT_BINDINGS_KEY, result.bindings);
    return result.sessions;
  });
  const result = stabilizeSessionProjectPathsInternal(context.globalState.get(SESSION_PROJECT_BINDINGS_KEY), sessions, projects);
  if (result.bindings) await context.globalState.update(SESSION_PROJECT_BINDINGS_KEY, result.bindings);
  return result.sessions;
}

function stabilizeSessionProjectPathsInternal(stored: unknown, sessions: DashboardCliSessionSummary[], projects: DashboardCliProject[]): { sessions: DashboardCliSessionSummary[]; bindings?: Record<string, SessionProjectBinding> } {
  const bindings: Record<string, SessionProjectBinding> = Object.create(null) as Record<string, SessionProjectBinding>;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [id, value] of Object.entries(stored)) {
      if (!value || typeof value !== "object") continue;
      const binding = value as Partial<SessionProjectBinding>;
      if (typeof binding.projectPath === "string" && binding.projectPath.trim() && binding.projectPath.length <= 4096 &&
        typeof binding.updatedAt === "number" && Number.isFinite(binding.updatedAt))
        bindings[id] = { projectPath: binding.projectPath, updatedAt: binding.updatedAt };
    }
  }
  const projectByPath = new Map(projects.map((project) => [canonicalProjectPath(project.path), project.path]));
  let changed = false;
  const stabilized = sessions.map((session) => {
    const current = session.projectPath?.trim();
    const previous = bindings[session.id]?.projectPath;
    const currentCanonical = current ? canonicalProjectPath(current) : "";
    const previousCanonical = previous ? canonicalProjectPath(previous) : "";
    const projectPath = (currentCanonical && projectByPath.get(currentCanonical))
      || (!current && previousCanonical && projectByPath.get(previousCanonical))
      || current
      || previous;
    if (projectPath && bindings[session.id]?.projectPath !== projectPath) {
      bindings[session.id] = { projectPath, updatedAt: Date.now() };
      changed = true;
    }
    return projectPath && projectPath !== session.projectPath ? { ...session, projectPath } : session;
  });
  const entries = Object.entries(bindings).sort((left, right) => right[1].updatedAt - left[1].updatedAt);
  if (entries.length > MAX_BINDINGS) {
    for (const [sessionId] of entries.slice(MAX_BINDINGS)) delete bindings[sessionId];
    changed = true;
  }
  return { sessions: stabilized, bindings: changed ? bindings : undefined };
}

export function canonicalProjectPath(value: string): string {
  const withoutDevicePrefix = value.trim().replace(/^\\\\\?\\/, "");
  const resolved = path.resolve(withoutDevicePrefix);
  const normalized = (resolved === path.parse(resolved).root ? resolved : resolved.replace(/[\\/]+$/, "")).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
