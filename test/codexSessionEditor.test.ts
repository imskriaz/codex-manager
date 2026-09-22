import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openCodexCliSessionInVsCode } from "../src/services/codexSessionResume";

describe("Codex VS Code session editor", () => {
  beforeEach(() => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({ extensionPath: "official-codex" } as never);
    vi.mocked(vscode.commands.executeCommand).mockClear();
  });

  it("opens a local session through the official Codex custom editor", async () => {
    const sessionId = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";

    await openCodexCliSessionInVsCode(sessionId);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.openWith",
      expect.objectContaining({
        scheme: "openai-codex",
        authority: "route",
        path: `/local/${sessionId}`
      }),
      "chatgpt.conversationEditor",
      {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
        preview: false
      }
    );
  });
});
