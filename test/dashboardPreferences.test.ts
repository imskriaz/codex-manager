import { describe, expect, it } from "vitest";
import { createInitialState, reducer } from "../webview-src/dashboard/state";

function createStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    }
  };
}

describe("dashboard preferences", () => {
  it("takes privacy mode from every authoritative dashboard snapshot", () => {
    const enabled = reducer(createInitialState(), {
      type: "snapshot",
      snapshot: {
        accounts: [],
        settings: {
          privacyMode: true,
          autoRefreshMinutes: 15,
          autoRefreshCurrentMinutes: 1
        }
      } as never
    });
    const disabled = reducer(enabled, {
      type: "snapshot",
      snapshot: {
        accounts: [],
        settings: {
          privacyMode: false,
          autoRefreshMinutes: 15,
          autoRefreshCurrentMinutes: 1
        }
      } as never
    });

    expect(enabled.privacyMode).toBe(true);
    expect(enabled.lastEnabledAutoRefreshCurrentMinutes).toBe(1);
    expect(disabled.privacyMode).toBe(false);
  });

  it("restores account view choices from local storage", async () => {
    const storage = createStorage({
      "codexManager.dashboardUiPreferences.v2": JSON.stringify({
        filter: "attention",
        view: "list",
        metricPriority: "weekly",
        accountSearch: "alice"
      })
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: storage }
    });

    const { loadUiPreferences, saveUiPreferences } = await import("../webview-src/dashboard/preferences");
    expect(loadUiPreferences()).toMatchObject({
      filter: "attention",
      view: "list",
      metricPriority: "weekly",
      accountSearch: "alice"
    });
    saveUiPreferences({
      filter: "healthy",
      view: "cards",
      metricPriority: "hourly",
      accountSearch: "bob"
    });
    expect(JSON.parse(storage.getItem("codexManager.dashboardUiPreferences.v2")!)).toMatchObject({
      filter: "healthy",
      accountSearch: "bob"
    });
  });

  it("falls back safely when stored preferences are malformed", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: createStorage({ "codexManager.dashboardUiPreferences.v2": "not-json" }) }
    });

    const { loadUiPreferences } = await import("../webview-src/dashboard/preferences");
    expect(loadUiPreferences()).toMatchObject({
      filter: "all",
      view: "cards",
      metricPriority: "hourly",
      accountSearch: ""
    });
  });

  it.each([null, [], { filter: 42, view: {}, metricPriority: {}, accountSearch: [] }, { filter: "invalid", view: "invalid", metricPriority: "x".repeat(300) }])
    ("validates JSON preference values before restoring them: %j", async (value) => {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: createStorage({
        "codexManager.dashboardUiPreferences.v2": JSON.stringify(value)
      }) } });
      const { loadUiPreferences } = await import("../webview-src/dashboard/preferences");
      expect(loadUiPreferences()).toMatchObject({ filter: "all", view: "cards", metricPriority: "hourly", accountSearch: "" });
    });
});

describe("saved chart preferences", () => {
  it("remembers both modes' ranges and the selected historical period", async () => {
    const storage = createStorage();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
    const { loadUsageGraphPreferences, saveUsageGraphPreferences } = await import("../webview-src/dashboard/preferences");
    const preferences = { mode: "tokens", quotaRange: "6h", tokenRange: "7d", windowOffset: 3 } as const;
    expect(saveUsageGraphPreferences(preferences)).toBe(true);
    expect(loadUsageGraphPreferences()).toEqual(preferences);
  });

  it.each([undefined, "bad-json", "null", "[]", "42", JSON.stringify({ mode: "unknown", quotaRange: "1y", tokenRange: "1h", windowOffset: -1 }),
    JSON.stringify({ mode: [], quotaRange: {}, tokenRange: [], windowOffset: 0.5 }), JSON.stringify({ windowOffset: 10001 }), JSON.stringify({ windowOffset: "3" })])
    ("uses defaults for missing or invalid saved choices: %s", async raw => {
      const { loadUsageGraphPreferences, USAGE_GRAPH_PREFERENCES_STORAGE_KEY } = await import("../webview-src/dashboard/preferences");
      Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: createStorage(raw === undefined ? {} : { [USAGE_GRAPH_PREFERENCES_STORAGE_KEY]: raw }) } });
      expect(loadUsageGraphPreferences()).toEqual({ mode: "quota", quotaRange: "1h", tokenRange: "30d", windowOffset: 0 });
    });

  it("preserves valid choices in a partial saved record", async () => {
    const { loadUsageGraphPreferences, USAGE_GRAPH_PREFERENCES_STORAGE_KEY } = await import("../webview-src/dashboard/preferences");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: createStorage({
      [USAGE_GRAPH_PREFERENCES_STORAGE_KEY]: JSON.stringify({ mode: "tokens", tokenRange: "24h" })
    }) } });
    expect(loadUsageGraphPreferences()).toEqual({ mode: "tokens", quotaRange: "1h", tokenRange: "24h", windowOffset: 0 });
  });

  it("keeps charts usable when browser storage is denied or full", async () => {
    const { loadUsageGraphPreferences, saveUsageGraphPreferences } = await import("../webview-src/dashboard/preferences");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage() { throw new Error("Storage denied"); } } });
    expect(loadUsageGraphPreferences().mode).toBe("quota");
    expect(saveUsageGraphPreferences({ mode: "tokens", quotaRange: "1h", tokenRange: "30d", windowOffset: 0 })).toBe(false);
    const storage = createStorage();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { ...storage, setItem() { throw new Error("Storage full"); } } } });
    expect(saveUsageGraphPreferences({ mode: "quota", quotaRange: "6h", tokenRange: "7d", windowOffset: 0 })).toBe(false);
  });
});
