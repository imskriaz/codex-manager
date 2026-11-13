import { describe, expect, it } from "vitest";
import { getAccountShortcut } from "../webview-src/dashboard/accountShortcuts";

function keyEvent(key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, target: null, ...overrides } as KeyboardEvent;
}

describe("account keyboard shortcuts", () => {
  it("keeps account actions on the account route", () => {
    for (const [key, action] of [["/", "search"], ["r", "refresh"], ["a", "add"], ["v", "view"]]) {
      expect(getAccountShortcut(keyEvent(key), "/")).toBe(action);
      expect(getAccountShortcut(keyEvent(key.toUpperCase()), "/")).toBe(action);
      for (const route of ["/workspace", "/workspace/01a04882-d037-7a42-ad24-9afb61901188", "/tasks", "/share/example"]) {
        expect(getAccountShortcut(keyEvent(key), route)).toBeUndefined();
      }
    }
    expect(getAccountShortcut(keyEvent("Escape"), "/")).toBeUndefined();
  });

  it("preserves shortcuts handled by the browser, editors, IME, and held keys", () => {
    for (const key of ["/", "r", "a", "v"]) {
      for (const flag of ["ctrlKey", "metaKey", "altKey", "defaultPrevented", "isComposing", "repeat"]) {
        expect(getAccountShortcut(keyEvent(key, { [flag]: true }), "/")).toBeUndefined();
      }
    }
  });

  it("leaves typing and nested dialog or menu controls alone", () => {
    for (const selector of ['input', 'textarea', 'select', '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]', '[role="dialog"]', '[role="menu"]', '[inert]']) {
      const target = { closest: (selectors: string) => selectors.split(", ").includes(selector) ? {} : null };
      for (const key of ["/", "r", "a", "v"]) {
        expect(getAccountShortcut(keyEvent(key, { target: target as unknown as HTMLElement }), "/")).toBeUndefined();
      }
    }
    expect(getAccountShortcut(keyEvent("a", { target: { isContentEditable: true } as HTMLElement }), "/")).toBeUndefined();
    expect(getAccountShortcut(keyEvent("a", { target: { closest: () => null } as unknown as HTMLElement }), "/")).toBe("add");
  });
});
