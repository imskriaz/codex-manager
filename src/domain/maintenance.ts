export const MAINTENANCE_TOOLS = [
  { id: "archives", title: "Clear all archives", description: "Permanently delete archived Codex chats.", destructive: true },
  { id: "sessions", title: "Clear all Codex data", description: "Delete Codex chats, archives, and their goals. Keep saved accounts, passwords, and settings.", destructive: true },
  { id: "goals", title: "Clear all goals", description: "Remove saved goals while keeping conversations.", destructive: true },
  { id: "snapshots", title: "Clean old shell snapshots", description: "Remove shell snapshots older than seven days from inactive sessions.", destructive: true }
] as const;
export const CODEX_INSPECTIONS = [
  { id: "projects", title: "Find missing projects", description: "Find conversations whose recorded project folder no longer exists." },
  { id: "large-sessions", title: "Find large conversations", description: "Identify the largest conversation files before choosing what to archive." },
  { id: "storage", title: "Check Codex storage", description: "Check native conversation and goal databases without modifying them." }
] as const;
export type CodexInspection = typeof CODEX_INSPECTIONS[number]["id"];
export type MaintenanceTool = typeof MAINTENANCE_TOOLS[number]["id"];
export type MaintenancePreview = { token: string; tool: MaintenanceTool; count: number; expiresAt: number; titles: string[] };
export type MaintenancePage = { token: string; query: string; offset: number; total: number; items: Array<{ id: string; title: string; detail?: string }> };
export type MaintenanceReport = { title: string; items: Array<{ label: string; value: string }> };
export type MaintenanceJob = { id: string; tool: MaintenanceTool; operation: "delete" | "restore"; status: "running" | "completed" | "cancelled" | "failed" | "unknown"; total: number; processed: number; cleared: number; skipped: number; failed: number; errors: string[]; cancelRequested?: boolean; previewToken?: string; revision?: number };
const JOB_FIELDS = new Set(['id', 'tool', 'operation', 'status', 'total', 'processed', 'cleared', 'skipped', 'failed', 'errors', 'cancelRequested', 'previewToken', 'revision']);

export function isMaintenanceJob(value: unknown): value is MaintenanceJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as MaintenanceJob;
  return Object.keys(job).every(key => JOB_FIELDS.has(key)) && typeof job.id === 'string' && job.id.length > 0 && job.id.length <= 128 &&
    MAINTENANCE_TOOLS.some(tool => tool.id === job.tool) && ['delete', 'restore'].includes(job.operation) &&
    ['running', 'completed', 'cancelled', 'failed', 'unknown'].includes(job.status) &&
    [job.total, job.processed, job.cleared, job.skipped, job.failed].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000) &&
    job.processed <= job.total && job.cleared + job.skipped + job.failed <= job.processed &&
    (job.status !== 'completed' || job.processed === job.total) &&
    Array.isArray(job.errors) && job.errors.length <= 20 && job.errors.every(error => typeof error === 'string' && error.length <= 300) &&
    (job.cancelRequested === undefined || typeof job.cancelRequested === 'boolean') &&
    (job.previewToken === undefined || typeof job.previewToken === 'string' && job.previewToken.length > 0 && job.previewToken.length <= 128) &&
    (job.revision === undefined || Number.isSafeInteger(job.revision) && job.revision >= 0);
}

export function mergeMaintenanceJob(current: MaintenanceJob | undefined, next: MaintenanceJob): MaintenanceJob {
  if (current?.id !== next.id) return next;
  if (current.total !== next.total || current.tool !== next.tool || current.operation !== next.operation ||
    (current.revision !== undefined && (next.revision === undefined || next.revision < current.revision)) ||
    current.processed > next.processed || current.cleared > next.cleared || current.skipped > next.skipped || current.failed > next.failed ||
    (current.status !== 'running' && current.status !== 'unknown' && next.status !== current.status)) return current;
  return { ...next, cancelRequested: current.cancelRequested || next.cancelRequested };
}
