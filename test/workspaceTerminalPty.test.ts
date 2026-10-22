import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { workspaceTerminal, disposeSharedTerminals, sharedTerminalInfo } from "../src/services/workspaceTerminalPty";
import { subscribeDashboardRealtime } from "../src/services/dashboardRealtime";

const backend = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => backend);
type MockPty = {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  data: (value: string) => void;
  exit: (value: { exitCode: number }) => void;
};
const shells: MockPty[] = [];
const natives: Array<vscode.Terminal & { pty: vscode.Pseudoterminal }> = [];
const clientId = "terminal-client-one";
const cwd = tmpdir();
const create = () =>
  workspaceTerminal(cwd, undefined, { operation: "create", clientId, operationId: randomUUID() }, "cmd");

beforeEach(() => {
  backend.spawn.mockReset();
  Object.defineProperty(vscode, "EventEmitter", {
    configurable: true,
    value: class<T> {
      private listeners = new Set<(value: T) => void>();
      event = (listener: (value: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      fire(value: T) {
        for (const listener of this.listeners) listener(value);
      }
      dispose() {
        this.listeners.clear();
      }
    }
  });
  Object.defineProperty(vscode.window, "terminals", { configurable: true, get: () => natives });
  Object.defineProperty(vscode.window, "createTerminal", {
    configurable: true,
    value: vi.fn((options: vscode.ExtensionTerminalOptions) => {
      let opened = false;
      const native = {
        name: options.name,
        pty: options.pty,
        show: vi.fn(() => {
          if (!opened) {
            opened = true;
            queueMicrotask(() => options.pty.open({ columns: 80, rows: 24 }));
          }
        }),
        dispose: vi.fn(() => {
          options.pty.close();
          const index = natives.indexOf(native as never);
          if (index >= 0) natives.splice(index, 1);
        })
      };
      options.pty.onDidChangeName?.((name) => {
        native.name = name;
      });
      natives.push(native as never);
      return native;
    })
  });
  backend.spawn.mockImplementation(() => {
    const shell: MockPty & {
      pid: number;
      onData: (callback: MockPty["data"]) => void;
      onExit: (callback: MockPty["exit"]) => void;
    } = {
      pid: 1234,
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(),
      data: () => undefined,
      exit: () => undefined,
      onData(callback) {
        this.data = callback;
      },
      onExit(callback) {
        this.exit = callback;
      }
    };
    shell.kill.mockImplementation(() => shell.exit({ exitCode: 0 }));
    shells.push(shell);
    return shell;
  });
});
afterEach(() => {
  disposeSharedTerminals();
  natives.length = 0;
  shells.length = 0;
  vi.restoreAllMocks();
});

describe("shared workspace pseudoterminal", () => {
  it("releases ConPTY pipes and the output worker after process exit without killing twice", async () => {
    const created = await create();
    const inSocket = { destroy: vi.fn() },
      outSocket = { destroy: vi.fn() },
      worker = { dispose: vi.fn() };
    Object.assign(shells[0]!, { _agent: { inSocket, outSocket, _conoutSocketWorker: worker } });
    shells[0]!.exit({ exitCode: 0 });
    if (process.platform === "win32") {
      expect(inSocket.destroy).toHaveBeenCalledOnce();
      expect(outSocket.destroy).toHaveBeenCalledOnce();
      expect(worker.dispose).toHaveBeenCalledOnce();
    }
    await workspaceTerminal(cwd, created.workspaceTerminal.id, {
      operation: "close",
      clientId,
      epoch: created.terminalSnapshot.epoch
    });
    expect(shells[0]!.kill).not.toHaveBeenCalled();
  });
  it("does not release browser control when the native renderer answers cursor queries", async () => {
    const created = await create(),
      id = created.workspaceTerminal.id;
    natives[0]!.pty.handleInput?.("\x1b[24;80R");
    expect(
      (await workspaceTerminal(cwd, id, { operation: "read", clientId: "other-terminal-view" })).terminalSnapshot
        .writable
    ).toBe(false);
    natives[0]!.pty.handleInput?.("native keyboard input");
    expect(
      (await workspaceTerminal(cwd, id, { operation: "read", clientId: "other-terminal-view" })).terminalSnapshot
        .writable
    ).toBe(true);
  });
  it("prevents a delayed native open from spawning after its startup deadline", async () => {
    vi.useFakeTimers();
    const factory = vi.mocked(vscode.window.createTerminal) as unknown as ReturnType<typeof vi.fn>;
    const original = factory.getMockImplementation()!;
    let late: vscode.Pseudoterminal | undefined;
    factory.mockImplementationOnce((options: vscode.ExtensionTerminalOptions) => {
      const native = original(options);
      late = options.pty;
      native.show = vi.fn();
      return native;
    });
    try {
      const pending = create(),
        rejected = expect(pending).rejects.toThrow("did not start");
      await vi.waitFor(() => expect(natives).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(5001);
      await rejected;
      late!.open({ columns: 80, rows: 24 });
      expect(backend.spawn).not.toHaveBeenCalled();
      expect(natives).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("runs one native/browser shell, preserves VT colours and cursor state, and restores a sequence-fenced screen", async () => {
    const events: unknown[] = [],
      unsubscribe = subscribeDashboardRealtime((event) => events.push(event));
    try {
      const created = await create(),
        nativeOutput: string[] = [];
      natives[0]!.pty.onDidWrite((value) => nativeOutput.push(value));
      shells[0]!.data("\x1b[31mError\x1b[0m\r\nPS test> ");
      const state = await workspaceTerminal(cwd, created.workspaceTerminal.id, { operation: "read", clientId });
      expect(state.terminalSnapshot.content).toContain("Error");
      expect(state.terminalSnapshot.content).toContain("\x1b[31m");
      expect(state.terminalSnapshot.sequence).toBe(1);
      expect(nativeOutput.join("")).toContain("\x1b[31mError");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "dashboard:terminal-output",
          output: expect.objectContaining({ raw: true, sequence: 1, id: state.terminalSnapshot.epoch })
        })
      );
      expect(sharedTerminalInfo(natives[0]!)).toMatchObject({ id: created.workspaceTerminal.id, shared: true, cwd });
    } finally {
      unsubscribe();
    }
  });
  it("deduplicates confirmed keystrokes and rejects gaps, stale epochs, wrong projects and oversized input", async () => {
    const created = await create(),
      id = created.workspaceTerminal.id,
      epoch = created.terminalSnapshot.epoch;
    const input = { operation: "input" as const, clientId, epoch, sequence: 1, data: "echo hello\r" };
    await workspaceTerminal(cwd, id, input);
    await workspaceTerminal(cwd, id, input);
    expect(shells[0]!.write).toHaveBeenCalledTimes(1);
    await expect(workspaceTerminal(cwd, id, { ...input, sequence: 3 })).rejects.toThrow("confirmation is missing");
    await expect(workspaceTerminal(cwd, id, { ...input, epoch: "old" })).rejects.toThrow("restarted");
    await expect(workspaceTerminal(cwd + "-other", id, input)).rejects.toThrow("another project");
    await expect(workspaceTerminal(cwd, id, { ...input, data: "x".repeat(16 * 1024 + 1) })).rejects.toThrow(
      "too large"
    );
    expect(shells[0]!.write).toHaveBeenCalledTimes(1);
  });
  it("allows read-only observers and explicit control takeover without replaying their input", async () => {
    const created = await create(),
      id = created.workspaceTerminal.id,
      epoch = created.terminalSnapshot.epoch;
    const observer = "terminal-client-two";
    expect(
      (await workspaceTerminal(cwd, id, { operation: "read", clientId: observer })).terminalSnapshot.writable
    ).toBe(false);
    await expect(
      workspaceTerminal(cwd, id, { operation: "input", clientId: observer, epoch, sequence: 1, data: "x" })
    ).rejects.toThrow("Another workspace");
    await workspaceTerminal(cwd, id, { operation: "claim", clientId: observer, takeControl: true });
    await workspaceTerminal(cwd, id, { operation: "input", clientId: observer, epoch, sequence: 1, data: "y" });
    expect(shells[0]!.write).toHaveBeenLastCalledWith("y");
    await expect(
      workspaceTerminal(cwd, id, { operation: "input", clientId, epoch, sequence: 1, data: "z" })
    ).rejects.toThrow("Another workspace");
  });
  it("resizes both views, renames native terminals, and rejects invalid dimensions", async () => {
    const created = await create(),
      id = created.workspaceTerminal.id,
      epoch = created.terminalSnapshot.epoch;
    const result = await workspaceTerminal(cwd, id, { operation: "resize", clientId, epoch, cols: 100, rows: 40 });
    expect(shells[0]!.resize).toHaveBeenCalledWith(100, 40);
    expect(result.terminalSnapshot).toMatchObject({ cols: 100, rows: 40 });
    await expect(
      workspaceTerminal(cwd, id, { operation: "resize", clientId, epoch, cols: 0, rows: 400 })
    ).rejects.toThrow("dimensions");
    await workspaceTerminal(cwd, id, { operation: "rename", clientId, epoch }, undefined, "Build");
    expect(natives[0]!.name).toBe("Build");
  });
  it("closes shells without late orphan creation, and does not recreate a retried closed terminal", async () => {
    const operationId = randomUUID(),
      request = { operation: "create" as const, clientId, operationId };
    const first = await workspaceTerminal(cwd, undefined, request, "cmd");
    const second = await workspaceTerminal(cwd, undefined, request, "cmd");
    expect(second.workspaceTerminal.id).toBe(first.workspaceTerminal.id);
    expect(backend.spawn).toHaveBeenCalledTimes(1);
    await expect(workspaceTerminal(cwd, undefined, request, "bash")).rejects.toThrow("different request");
    await workspaceTerminal(cwd, first.workspaceTerminal.id, {
      operation: "close",
      clientId,
      epoch: first.terminalSnapshot.epoch
    });
    expect(shells[0]!.kill).toHaveBeenCalledTimes(1);
    await expect(workspaceTerminal(cwd, undefined, request, "cmd")).rejects.toThrow("no longer open");
  });
  it("retains a finished screen while refusing further input and bounds the number of shells", async () => {
    const created = await create();
    shells[0]!.exit({ exitCode: 7 });
    const finished = await workspaceTerminal(cwd, created.workspaceTerminal.id, { operation: "read", clientId });
    expect(finished.terminalSnapshot).toMatchObject({ exited: true, exitCode: 7, writable: false });
    expect(finished.terminalSnapshot.content).toContain("Shell exited");
    await expect(
      workspaceTerminal(cwd, created.workspaceTerminal.id, {
        operation: "input",
        clientId,
        epoch: created.terminalSnapshot.epoch,
        sequence: 1,
        data: "x"
      })
    ).rejects.toThrow("exited");
    for (let index = 1; index < 8; index++) await create();
    await expect(create()).rejects.toThrow("Eight");
  });
  it("reports spawn errors and cleans up the native terminal", async () => {
    backend.spawn.mockImplementationOnce(() => {
      throw new Error("shell missing");
    });
    await expect(create()).rejects.toThrow("shell missing");
    expect(natives).toHaveLength(0);
  });
});
