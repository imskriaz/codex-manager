import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenCodexSessionTabs, openCodexSessionInVsCode } from "../src/services/codexSessionResume";

describe("Codex VS Code session editor", () => {
  let activateExtension: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    activateExtension = vi.fn(async () => undefined);
    const extension = {
      extensionPath: "official-codex",
      activate: activateExtension
    };
    vi.mocked(vscode.extensions.getExtension).mockReturnValue(extension as never);
    const tabs: Array<{ input: unknown; isPreview?: boolean }> = [];
    Object.assign(vscode.window, { tabGroups: { all: [{ tabs }], close: vi.fn(async (closing: unknown[]) => {
      for (const tab of closing) {
        const index = tabs.indexOf(tab as typeof tabs[number]);
        if (index >= 0) tabs.splice(index, 1);
      }
      return true;
    }) } });
    vi.mocked(vscode.commands.executeCommand).mockReset();
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command, uri, viewType) => {
      if (command === "vscode.openWith") {
        const existing = tabs.find(
          (tab) => (tab.input as { uri?: { path?: string } }).uri?.path === (uri as { path?: string }).path
        );
        if (existing) existing.isPreview = false;
        else tabs.push({ input: { uri, viewType }, isPreview: false });
      }
      return undefined;
    });
  });

  it("closes every official conversation across groups while preserving files and sidebar panels", async () => {
    const groups = vscode.window.tabGroups.all as unknown as Array<{ tabs: unknown[] }>;
    const native = (id: string) => ({ input: { viewType: "chatgpt.conversationEditor", uri: { path: `/local/${id}` } } });
    const first = native("first");
    const second = { ...native("second"), isPreview: true };
    const text = { input: { uri: { scheme: "file", path: "source.ts" } } };
    const sidebar = { input: { viewType: "chatgpt.sidebar" } };
    groups[0]!.tabs.push(first, text);
    groups.push({ tabs: [second, sidebar] });
    vi.mocked(vscode.window.tabGroups.close).mockImplementation(async (closing: unknown) => {
      for (const group of groups) group.tabs = group.tabs.filter(tab => !(closing as unknown[]).includes(tab));
      return true;
    });
    await closeOpenCodexSessionTabs(new AbortController().signal);
    expect(vscode.window.tabGroups.close).toHaveBeenCalledWith([first, second], true);
    expect(groups.flatMap(group => group.tabs)).toEqual([text, sidebar]);
  });

  it.each(["refused", "unchanged", "dirty", "rejected", "aborted"])(
    "reports an all-conversation close that is %s", async (failure) => {
      await openCodexSessionInVsCode("01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3");
      const old = vscode.window.tabGroups.all[0]!.tabs[0]!;
      const controller = new AbortController();
      const close = vi.mocked(vscode.window.tabGroups.close);
      if (failure === "refused") close.mockResolvedValue(false);
      if (failure === "unchanged") close.mockResolvedValue(true);
      if (failure === "dirty") Object.assign(old, { isDirty: true });
      if (failure === "rejected") close.mockRejectedValue(new Error("close failed"));
      if (failure === "aborted") close.mockImplementation(async () => { controller.abort(); return true; });
      await expect(closeOpenCodexSessionTabs(controller.signal)).rejects.toThrow();
      if (failure === "dirty") expect(close).not.toHaveBeenCalled();
    }
  );

  it("leaves old tabs intact if activation fails or cancellation precedes closing", async () => {
    await openCodexSessionInVsCode("01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3");
    activateExtension.mockRejectedValueOnce(new Error("offline"));
    await expect(closeOpenCodexSessionTabs()).rejects.toThrow("offline");
    const controller = new AbortController();
    controller.abort();
    await expect(closeOpenCodexSessionTabs(controller.signal)).rejects.toThrow();
    expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
  });

  it("promotes an existing preview tab before acknowledging automatic recovery", async () => {
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    await openCodexSessionInVsCode(id);
    const tab = vscode.window.tabGroups.all[0]!.tabs[0]!;
    Object.assign(tab, { isPreview: true });
    vi.mocked(vscode.commands.executeCommand).mockClear();
    await openCodexSessionInVsCode(id, new AbortController().signal);
    expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
    expect(tab.isPreview).toBe(false);
  });

  it("retains recovery when the command resolves without creating a tab", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    await expect(openCodexSessionInVsCode("01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3")).rejects.toThrow("did not create");
  });

  it("does not reopen an already restored native tab during automatic replay", async () => {
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    await openCodexSessionInVsCode(id);
    vi.mocked(vscode.commands.executeCommand).mockClear();
    activateExtension.mockClear();
    await openCodexSessionInVsCode(id.toUpperCase(), new AbortController().signal);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(activateExtension).not.toHaveBeenCalled();
  });

  it("coalesces concurrent automatic opens until their native tab exists", async () => {
    let activate: (() => void) | undefined;
    activateExtension.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          activate = resolve;
        })
    );
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    const first = openCodexSessionInVsCode(id, new AbortController().signal);
    const second = openCodexSessionInVsCode(id, new AbortController().signal);
    activate?.();
    await Promise.all([first, second]);
    expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
  });

  it("quarantines a late activation until it settles, without dispatching a cancelled open", async () => {
    let activate: (() => void) | undefined;
    activateExtension.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          activate = resolve;
        })
    );
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    const oldSignal = new AbortController();
    const first = openCodexSessionInVsCode(id, oldSignal.signal);
    const firstFailure = expect(first).rejects.toThrow();
    oldSignal.abort();
    const second = openCodexSessionInVsCode(id, new AbortController().signal);
    activate?.();
    await firstFailure;
    await second;
    expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
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
