export type AccountFilter =
  "all" | "healthy" | "attention" | "low" | "active" | "enabled" | "disabled" | "claimed" | "capable" | "incapable";
export type DashboardView = "cards" | "list";
export type UiPreferences = {
  filter: AccountFilter;
  view: DashboardView;
  metricPriority: string;
  accountSearch: string;
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
      accountSearch: typeof parsed.accountSearch === "string" ? parsed.accountSearch.slice(0, 4096) : ""
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
