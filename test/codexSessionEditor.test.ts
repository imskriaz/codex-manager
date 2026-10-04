import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openCodexSessionInVsCode } from "../src/services/codexSessionResume";

describe("Codex VS Code session editor", () => {
  let activateExtension: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    activateExtension = vi.fn(async () => undefined);
    const extension = {
      extensionPath: "official-codex",
      activate: activateExtension
    };
    vi.mocked(vscode.extensions.getExtension).mockReturnValue(extension as never);
    vi.mocked(vscode.commands.executeCommand).mockClear();
  });

  it("opens a local session through the official Codex custom editor", async () => {
    const sessionId = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";

    await openCodexSessionInVsCode(sessionId);

    expect(activateExtension).toHaveBeenCalledOnce();

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

  it("does not open a late tab after activation exceeds the auto-resume deadline", async () => {
    const controller = new AbortController();
    activateExtension.mockImplementation(async () => {
      controller.abort();
    });
    await expect(openCodexSessionInVsCode("01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3", controller.signal)).rejects.toThrow();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it("reports activation failure without claiming a tab opened", async () => {
    activateExtension.mockRejectedValue(new Error("extension unavailable"));
    await expect(openCodexSessionInVsCode("01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3")).rejects.toThrow(
      "extension unavailable"
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
