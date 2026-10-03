import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { readCodexSessionTransport } from "../src/infrastructure/config/extensionSettings";

describe("machine session transport", () => {
  it("uses the machine choice even when a legacy repository override says CLI", () => {
    const config = { get: () => "cli", inspect: () => ({ globalValue: "app-server-stdio", workspaceValue: "cli" }) } as unknown as vscode.WorkspaceConfiguration;
    expect(readCodexSessionTransport(config)).toBe("app-server-stdio");
  });
  it("defaults to App Server when only a repository override exists", () => {
    const config = { get: () => "cli", inspect: () => ({ defaultValue: "app-server-stdio", workspaceValue: "cli" }) } as unknown as vscode.WorkspaceConfiguration;
    expect(readCodexSessionTransport(config)).toBe("app-server-stdio");
  });
  it("retains an explicitly selected machine compatibility transport", () => {
    const config = { get: () => "app-server-stdio", inspect: () => ({ globalValue: "cli" }) } as unknown as vscode.WorkspaceConfiguration;
    expect(readCodexSessionTransport(config)).toBe("cli");
  });
});
