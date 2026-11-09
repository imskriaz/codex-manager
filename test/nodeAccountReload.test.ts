import { expect, it } from "vitest";
import * as vscode from "vscode";
import { needsWindowReloadForAccount, setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";
it("needs no editor reload in Node when the selected account changes", () => {
  setCurrentWindowRuntimeAccountId("old-account");
  expect(needsWindowReloadForAccount("new-account")).toBe(true);
  Object.defineProperty(vscode.env, "appHost", { configurable: true, value: "node" });
  try { expect(needsWindowReloadForAccount("new-account")).toBe(false); }
  finally { Reflect.deleteProperty(vscode.env, "appHost"); setCurrentWindowRuntimeAccountId(undefined); }
});
