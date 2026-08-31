export type AccountFilter =
  | "all"
  | "healthy"
  | "attention"
  | "low"
  | "active"
  | "enabled"
  | "disabled"
  | "capable"
  | "incapable";
export type DashboardView = "cards" | "list";
export type UiPreferences = {
  filter: AccountFilter;
  view: DashboardView;
  metricPriority: string;
  accountSearch: string;
  tagFilter: string[];
};

export const UI_PREFERENCES_STORAGE_KEY = "codexManager.dashboardUiPreferences.v2";
export const LEGACY_UI_PREFERENCES_STORAGE_KEY = "codexManager.dashboardUiPreferences.v1";
export const PRIVACY_MODE_STORAGE_KEY = "codexManager.dashboardPrivacyMode.v1";

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  filter: "all",
  view: "cards",
  metricPriority: "hourly",
  accountSearch: "",
  tagFilter: []
};

export function loadUiPreferences(): UiPreferences {
  try {
    const currentRaw = window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);
    const raw = currentRaw ?? window.localStorage.getItem(LEGACY_UI_PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_UI_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    return {
      filter: (parsed.filter as string) === "pinned" ? "all" : (parsed.filter ?? DEFAULT_UI_PREFERENCES.filter),
      view: currentRaw ? (parsed.view ?? "cards") : "cards",
      metricPriority: parsed.metricPriority ?? DEFAULT_UI_PREFERENCES.metricPriority,
      accountSearch: typeof parsed.accountSearch === "string" ? parsed.accountSearch : "",
      tagFilter: Array.isArray(parsed.tagFilter)
        ? parsed.tagFilter.filter((tag): tag is string => typeof tag === "string")
        : []
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

export function loadPrivacyMode(): boolean {
  try {
    return window.localStorage.getItem(PRIVACY_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function savePrivacyMode(value: boolean): void {
  try {
    window.localStorage.setItem(PRIVACY_MODE_STORAGE_KEY, String(value));
  } catch {
    // Local storage may be unavailable in restricted webviews.
  }
}
