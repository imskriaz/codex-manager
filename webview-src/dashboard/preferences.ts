export type AccountFilter =
  "all" | "healthy" | "attention" | "low" | "active" | "enabled" | "disabled" | "claimed" | "capable" | "incapable";
export type DashboardView = "cards" | "list";
export type AccountCenterSize = { width: number; height: number };
export const ACCOUNT_CENTER_SIZE_KEY = 'codexManager.accountCenterSize.v1';
export function loadAccountCenterSize(): AccountCenterSize | undefined {
  try {
    const size = JSON.parse(window.localStorage.getItem(ACCOUNT_CENTER_SIZE_KEY) ?? 'null') as AccountCenterSize | null;
    if (size && !Array.isArray(size) && typeof size.width === 'number' && typeof size.height === 'number' && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width >= 280 && size.height >= 240 && size.width <= 16384 && size.height <= 16384) return { width: size.width, height: size.height };
  } catch { /* Missing or unreadable preferences use the compact default. */ }
  return undefined;
}
export type UiPreferences = {
  filter: AccountFilter;
  view: DashboardView;
  metricPriority: string;
  accountSearch: string;
  accountTag?: string;
};

export const UI_PREFERENCES_STORAGE_KEY = "codexManager.dashboardUiPreferences.v2";
export const LEGACY_UI_PREFERENCES_STORAGE_KEY = "codexManager.dashboardUiPreferences.v1";

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  filter: "all",
  view: "cards",
  metricPriority: "hourly",
  accountSearch: ""
};

export function loadUiPreferences(): UiPreferences {
  try {
    const currentRaw = window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);
    const raw = currentRaw ?? window.localStorage.getItem(LEGACY_UI_PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_UI_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<UiPreferences> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_UI_PREFERENCES;
    const filters: readonly string[] = ["all", "healthy", "attention", "low", "active", "enabled", "disabled", "claimed", "capable", "incapable"];
    return {
      filter: typeof parsed.filter === "string" && filters.includes(parsed.filter) ? parsed.filter : "all",
      view: currentRaw && parsed.view === "list" ? "list" : "cards",
      metricPriority: typeof parsed.metricPriority === "string" && parsed.metricPriority.length <= 256 ? parsed.metricPriority : DEFAULT_UI_PREFERENCES.metricPriority,
      accountSearch: typeof parsed.accountSearch === "string" ? parsed.accountSearch.slice(0, 4096) : "",
      accountTag: typeof parsed.accountTag === "string" && parsed.accountTag.length <= 24 ? parsed.accountTag : ""
    };
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}

export function saveUiPreferences(value: UiPreferences): void {
  try {
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // UI preferences are optional when storage is unavailable.
  }
}

export type UsageGraphRange = "1h" | "3h" | "6h" | "24h" | "7d" | "30d";
export type UsageGraphPreferences = {
  mode: "quota" | "tokens";
  quotaRange: UsageGraphRange;
  tokenRange: "24h" | "7d" | "30d";
  windowOffset: number;
};
export const USAGE_GRAPH_PREFERENCES_STORAGE_KEY = "codexManager.usageGraphPreferences.v1";
const DEFAULT_USAGE_GRAPH_PREFERENCES: UsageGraphPreferences = {
  mode: "quota", quotaRange: "1h", tokenRange: "30d", windowOffset: 0
};

export function loadUsageGraphPreferences(): UsageGraphPreferences {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(USAGE_GRAPH_PREFERENCES_STORAGE_KEY) ?? "null") as Partial<UsageGraphPreferences> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_USAGE_GRAPH_PREFERENCES;
    return {
      mode: parsed.mode === "tokens" ? "tokens" : "quota",
      quotaRange: ["1h", "3h", "6h", "24h", "7d", "30d"].includes(parsed.quotaRange ?? "") ? parsed.quotaRange! : "1h",
      tokenRange: ["24h", "7d", "30d"].includes(parsed.tokenRange ?? "") ? parsed.tokenRange! : "30d",
      windowOffset: typeof parsed.windowOffset === "number" && Number.isSafeInteger(parsed.windowOffset) && parsed.windowOffset >= 0 && parsed.windowOffset <= 10_000 ? parsed.windowOffset : 0
    };
  } catch {
    return DEFAULT_USAGE_GRAPH_PREFERENCES;
  }
}

export function saveUsageGraphPreferences(value: UsageGraphPreferences): boolean {
  try {
    window.localStorage.setItem(USAGE_GRAPH_PREFERENCES_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const TASK_BOARD_COLUMNS_KEY = 'codexManager.taskBoardColumns.v1';
const TASK_STAGES = ['idea', 'planned', 'running', 'completed'] as const;
export function loadTaskBoardColumns(): Array<typeof TASK_STAGES[number]> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(TASK_BOARD_COLUMNS_KEY) ?? 'null');
    if (Array.isArray(value) && value.length > 0 && value.length <= 4 && value.every((stage: unknown) => typeof stage === 'string' && TASK_STAGES.some(known => known === stage))) return TASK_STAGES.filter(stage => value.includes(stage));
  } catch { /* Fall back to the compact default when browser storage is unavailable. */ }
  return [...TASK_STAGES];
}
export function saveTaskBoardColumns(columns: Array<typeof TASK_STAGES[number]>): boolean {
  try { window.localStorage.setItem(TASK_BOARD_COLUMNS_KEY, JSON.stringify(columns)); return true; } catch { return false; }
}

export type TaskBoardView = 'board' | 'list' | 'gantt' | 'calendar';
const TASK_BOARD_VIEW_KEY = 'codexManager.taskBoardView.v1';
const TASK_BOARD_ARCHIVE_KEY = 'codexManager.taskBoardShowArchive.v1';
export function loadTaskBoardView(): TaskBoardView {
  try {
    const value = window.localStorage.getItem(TASK_BOARD_VIEW_KEY);
    if (value === 'list' || value === 'gantt' || value === 'calendar') return value;
  } catch { /* Optional browser preference. */ }
  return 'board';
}
export function saveTaskBoardView(view: TaskBoardView): boolean {
  try { window.localStorage.setItem(TASK_BOARD_VIEW_KEY, view); return true; } catch { return false; }
}
export function loadTaskBoardShowArchive(): boolean {
  try { return window.localStorage.getItem(TASK_BOARD_ARCHIVE_KEY) === 'true'; } catch { return false; }
}
export function saveTaskBoardShowArchive(show: boolean): boolean {
  try { window.localStorage.setItem(TASK_BOARD_ARCHIVE_KEY, String(show)); return true; } catch { return false; }
}
