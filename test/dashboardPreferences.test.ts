import { describe, expect, it } from "vitest";

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
  it("restores privacy mode and account view choices from local storage", async () => {
    const storage = createStorage({
      "codexManager.dashboardPrivacyMode.v1": "true",
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

    const { loadPrivacyMode, loadUiPreferences, savePrivacyMode, saveUiPreferences } =
      await import("../webview-src/dashboard/preferences");
    expect(loadPrivacyMode()).toBe(true);
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
    savePrivacyMode(false);
    expect(storage.getItem("codexManager.dashboardPrivacyMode.v1")).toBe("false");
  });

  it("falls back safely when stored preferences are malformed", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: createStorage({ "codexManager.dashboardUiPreferences.v2": "not-json" }) }
    });

    const { loadPrivacyMode, loadUiPreferences } = await import("../webview-src/dashboard/preferences");
    expect(loadPrivacyMode()).toBe(false);
    expect(loadUiPreferences()).toMatchObject({
      filter: "all",
      view: "cards",
      metricPriority: "hourly",
      accountSearch: "",
      tagFilter: []
    });
  });
});
