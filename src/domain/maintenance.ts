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
export type MaintenanceJob = { id: string; tool: MaintenanceTool; operation: "delete" | "restore"; status: "running" | "completed" | "cancelled" | "failed" | "unknown"; total: number; processed: number; cleared: number; skipped: number; failed: number; errors: string[]; cancelRequested?: boolean };
