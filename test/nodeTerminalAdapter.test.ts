import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
const shim = createRequire(import.meta.url)("../tools/node-vscode-shim/vscode.js");
it("opens, writes to and disposes a shared terminal without a VS Code window", async () => {
  const pty = { open: vi.fn(), handleInput: vi.fn(), close: vi.fn() };
  const terminal = shim.window.createTerminal({ name: "Standalone", pty });
  await Promise.resolve();
  expect(pty.open).toHaveBeenCalledOnce();
  expect(shim.window.terminals).toContain(terminal);
  terminal.sendText("echo working");
  expect(pty.handleInput).toHaveBeenCalledWith("echo working\r");
  terminal.show(); expect(shim.window.activeTerminal).toBe(terminal);
  terminal.dispose(); terminal.dispose();
  expect(pty.close).toHaveBeenCalledOnce();
  expect(shim.window.terminals).not.toContain(terminal);
  expect(shim.window.activeTerminal).toBeUndefined();
});
it("does not start a terminal that was disposed before its first open", async () => {
  const pty = { open: vi.fn(), close: vi.fn() };
  shim.window.createTerminal({ pty }).dispose(); await Promise.resolve();
  expect(pty.open).not.toHaveBeenCalled();
  expect(pty.close).toHaveBeenCalledOnce();
});

it('reports unsupported editor commands instead of silently succeeding or accepting prompts', async () => {
  await expect(shim.commands.executeCommand('workbench.action.reloadWindow')).rejects.toThrow('requires VS Code');
  await expect(shim.window.showWarningMessage('Confirm?', 'Delete')).resolves.toBeUndefined();
});
