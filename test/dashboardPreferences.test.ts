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
    expect(disabled.privacyMode).toBe(false);
  });

  it("restores account view choices from local storage", async () => {
    const storage = createStorage({
      "codexManager.dashboardUiPreferences.v2": JSON.stringify({
        filter: "attention",
        view: "list",
        metricPriority: "weekly",
        accountSearch: "alice",
        tagFilter: ["team"]
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
      accountSearch: "alice",
      tagFilter: ["team"]
    });
    saveUiPreferences({
      filter: "healthy",
      view: "cards",
      metricPriority: "hourly",
      accountSearch: "bob",
      tagFilter: ["personal"]
    });
    expect(JSON.parse(storage.getItem("codexManager.dashboardUiPreferences.v2")!)).toMatchObject({
      filter: "healthy",
      accountSearch: "bob",
      tagFilter: ["personal"]
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
      accountSearch: "",
      tagFilter: []
    });
  });
});
