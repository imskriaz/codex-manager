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
