import * as vscode from "vscode";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promises as fs, constants } from "node:fs";
import type { IPty } from "node-pty";
import type { Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type {
  DashboardWorkspaceTerminalInfo,
  WorkspaceTerminalRequest,
  WorkspaceTerminalSnapshot
} from "../domain/dashboard/types";
import { publishDashboardRealtime } from "./dashboardRealtime";
import { waitWithin } from "../utils/concurrency";

type SharedTerminal = {
  id: string;
  epoch: string;
  cwd: string;
  name: string;
  shell: string;
  native: vscode.Terminal;
  pty?: IPty;
  screen: Terminal;
  serializer: SerializeAddon;
  sequence: number;
  owner?: string;
  ownerUntil: number;
  inputs: Map<string, number>;
  exited: boolean;
  exitCode?: number;
  disposed: boolean;
  pendingBytes: number;
  write: vscode.EventEmitter<string>;
  dimensions: vscode.EventEmitter<vscode.TerminalDimensions | undefined>;
  closed: vscode.EventEmitter<number | void>;
  renamed: vscode.EventEmitter<string>;
  ended: Promise<void>;
  cleanupError?: string;
};
const terminals = new Map<string, SharedTerminal>();
const creates = new Map<string, { fingerprint: string; promise: Promise<SharedTerminal>; expires: number }>();
const MAX_TERMINALS = 8;

function releaseWindowsResources(pty: IPty): void {
  if (process.platform !== "win32") {
    return;
  }
  // node-pty 1.1 leaves the ConPTY worker alive on exit; never call native kill twice.
  const agent = (
    pty as IPty & {
      _agent?: {
        inSocket?: { destroy: () => void };
        outSocket?: { destroy: () => void };
        _conoutSocketWorker?: { dispose: () => void };
      };
    }
  )._agent;
  agent?.inSocket?.destroy();
  agent?.outSocket?.destroy();
  agent?._conoutSocketWorker?.dispose();
}

export function sharedTerminalInfo(native: vscode.Terminal): DashboardWorkspaceTerminalInfo | undefined {
  const value = [...terminals.values()].find((item) => item.native === native);
  return value ? info(value) : undefined;
}
function info(value: SharedTerminal): DashboardWorkspaceTerminalInfo {
  return {
    id: value.id,
    name: value.name,
    shared: true,
    cwd: value.cwd,
    shellPath: value.shell,
    processId: value.pty?.pid,
    state: value.exited ? "idle" : "running",
    isActive: vscode.window.activeTerminal === value.native
  };
}
export function findSharedTerminal(id: string | undefined): vscode.Terminal | undefined {
  return id ? terminals.get(id)?.native : undefined;
}
export function disposeSharedTerminals(): void {
  for (const value of [...terminals.values()]) {
    value.native.dispose();
  }
  creates.clear();
}

async function loadPty(): Promise<typeof import("node-pty")> {
  try {
    if (process.platform === "darwin") {
      const helper = path.resolve(
        path.dirname(createRequire(__filename).resolve("node-pty")),
        "..",
        "prebuilds",
        `darwin-${process.arch}`,
        "spawn-helper"
      );
      try {
        await fs.access(helper, constants.X_OK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EACCES") {
          await fs.chmod(helper, 0o755);
        } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return await import("node-pty");
  } catch {
    // VS Code ships a matching native build on platforms without an npm prebuild.
    try {
      return createRequire(path.join(vscode.env.appRoot, "package.json"))("node-pty") as typeof import("node-pty");
    } catch {
      throw new Error(
        "The native terminal backend is unavailable on this platform. Open the VS Code terminal, or use a supported native build."
      );
    }
  }
}
function dimensions(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    (cols as number) < 2 ||
    (cols as number) > 300 ||
    (rows as number) < 1 ||
    (rows as number) > 120
  ) {
    throw new Error("Terminal dimensions must be 2–300 columns and 1–120 rows.");
  }
  return { cols: cols as number, rows: rows as number };
}
function sameProject(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function assertControl(value: SharedTerminal, request: WorkspaceTerminalRequest): void {
  if (value.exited) {
    throw new Error("This shell has exited. Create a new terminal to continue.");
  }
  if (request.epoch !== value.epoch) {
    throw new Error("Terminal monitoring restarted. Refresh before entering commands.");
  }
  if (value.owner !== request.clientId && value.ownerUntil > Date.now()) {
    throw new Error("Another workspace controls this terminal. Choose Take control before typing.");
  }
  value.owner = request.clientId;
  value.ownerUntil = Date.now() + 30_000;
}
async function snapshot(
  value: SharedTerminal,
  clientId: string,
  includeContent: boolean
): Promise<WorkspaceTerminalSnapshot> {
  await waitWithin(
    new Promise<void>((resolve) => value.screen.write("", resolve)),
    3000,
    "Terminal screen is busy. Retry the connection."
  );
  if (value.disposed) {
    throw new Error("This terminal was closed. Refresh the terminal list.");
  }
  let content: string | undefined;
  if (includeContent) {
    let lines = 500;
    do {
      content = value.serializer.serialize({ scrollback: lines });
      if (Buffer.byteLength(content) <= 960 * 1024) {
        break;
      }
      lines = Math.floor(lines / 2);
    } while (lines > 0);
    if (Buffer.byteLength(content) > 960 * 1024) {
      content = value.serializer.serialize({ scrollback: 0 });
      if (Buffer.byteLength(content) > 960 * 1024) {
        throw new Error(
          "This terminal screen is too large to restore remotely. Reduce its dimensions or open it in VS Code."
        );
      }
    }
  }
  return {
    id: value.id,
    epoch: value.epoch,
    sequence: value.sequence,
    inputSequence: value.inputs.get(clientId) ?? 0,
    cols: value.screen.cols,
    rows: value.screen.rows,
    ...(includeContent ? { content } : {}),
    writable: !value.exited && (value.owner === clientId || value.ownerUntil <= Date.now()),
    exited: value.exited,
    exitCode: value.exitCode
  };
}

async function create(
  cwd: string,
  profile: string | undefined,
  requestedName: string | undefined
): Promise<SharedTerminal> {
  if (vscode.workspace.isTrusted === false) {
    throw new Error("Trust this workspace in VS Code before starting a shell.");
  }
  if (terminals.size >= MAX_TERMINALS) {
    throw new Error("Eight shared terminals are already open. Close one before creating another.");
  }
  const backend = await loadPty();
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
  const config = vscode.workspace.getConfiguration("terminal.integrated", vscode.Uri.file(cwd));
  const profiles = config.get<
    Record<
      string,
      { path?: string | string[]; source?: string; args?: string[] | string; env?: Record<string, string | null> }
    >
  >(`profiles.${platform}`, {});
  const configured = profiles[config.get<string>(`defaultProfile.${platform}`, "")];
  const defaultShell =
    vscode.env.shell ||
    (process.platform === "win32" ? process.env["ComSpec"] || "cmd.exe" : process.env["SHELL"] || "/bin/bash");
  const configuredPath = Array.isArray(configured?.path) ? configured.path[0] : configured?.path;
  const powershell =
    process.platform === "win32" && profile === "powershell"
      ? await new Promise<string>((resolve) => {
          execFile("where.exe", ["pwsh.exe"], { timeout: 1000, windowsHide: true }, (error) =>
            resolve(error ? "powershell.exe" : "pwsh.exe")
          );
        })
      : "pwsh";
  const shell = (
    profile === "powershell"
      ? powershell
      : profile === "cmd"
        ? process.env["ComSpec"] || "cmd.exe"
        : profile === "bash"
          ? "bash"
          : configuredPath || defaultShell
  ).replace(/\$\{env:([^}]+)\}/g, (_, variable: string) => process.env[variable] ?? "");
  if (terminals.size >= MAX_TERMINALS) {
    throw new Error("Eight shared terminals are already open. Close one before creating another.");
  }
  const args = profile && profile !== "default" ? [] : (configured?.args ?? []);
  if (typeof args === "string" && process.platform !== "win32") {
    throw new Error(
      "This shell profile uses a command-line string. Set its arguments to an array in VS Code terminal settings."
    );
  }
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  for (const [key, item] of Object.entries({
    ...config.get<Record<string, string | null>>(`env.${platform}`, {}),
    ...(profile && profile !== "default" ? {} : configured?.env)
  })) {
    if (item === null) {
      delete env[key];
    } else if (typeof item === "string") {
      env[key] = item
        .replace(/\$\{workspaceFolder\}/g, cwd)
        .replace(/\$\{env:([^}]+)\}/g, (_, variable: string) => process.env[variable] ?? "");
    }
  }
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  const [{ Terminal: Headless }, { SerializeAddon: Serializer }] = await Promise.all([
    import("@xterm/headless"),
    import("@xterm/addon-serialize")
  ]);
  if (terminals.size >= MAX_TERMINALS) {
    throw new Error("Eight shared terminals are already open. Close one before creating another.");
  }
  const screen = new Headless({ cols: 80, rows: 24, scrollback: 500, allowProposedApi: true });
  const serializer = new Serializer();
  screen.loadAddon(serializer);
  const write = new vscode.EventEmitter<string>(),
    overridden = new vscode.EventEmitter<vscode.TerminalDimensions | undefined>(),
    closed = new vscode.EventEmitter<number | void>();
  const renamed = new vscode.EventEmitter<string>();
  let resolveStart!: () => void, rejectStart!: (error: unknown) => void;
  const started = new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  let endProcess!: () => void;
  const ended = new Promise<void>((resolve) => {
    endProcess = resolve;
  });
  const emit = (data: string): void => {
    if (!data || value.disposed) {
      return;
    }
    write.fire(data);
    value.pendingBytes += Buffer.byteLength(data);
    if (value.pendingBytes > 512 * 1024) {
      value.pty?.pause();
    }
    screen.write(data, () => {
      if (value.disposed) {
        return;
      }
      value.pendingBytes = Math.max(0, value.pendingBytes - Buffer.byteLength(data));
      if (value.pendingBytes < 128 * 1024 && !value.exited) {
        value.pty?.resume();
      }
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(data.length, offset + 32768);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) {
          end--;
        }
        publishDashboardRealtime({
          type: "dashboard:terminal-output",
          output: {
            raw: true,
            id: value.epoch,
            terminalId: value.id,
            command: "",
            cwd,
            chunk: data.slice(offset, end),
            stream: "terminal",
            sequence: ++value.sequence,
            cols: screen.cols,
            rows: screen.rows,
            exited: value.exited
          }
        });
        offset = end;
      }
    });
  };
  let native: vscode.Terminal;
  try {
    native = vscode.window.createTerminal({
      name: requestedName?.trim().slice(0, 80) || `Terminal · ${path.basename(cwd)}`,
      pty: {
        onDidWrite: write.event,
        onDidClose: closed.event,
        onDidOverrideDimensions: overridden.event,
        onDidChangeName: renamed.event,
        open: (initial: vscode.TerminalDimensions | undefined) => {
          if (value.disposed) {
            return;
          }
          try {
            const size = dimensions(
              Math.min(300, Math.max(2, initial?.columns ?? 80)),
              Math.min(120, Math.max(1, initial?.rows ?? 24))
            );
            screen.resize(size.cols, size.rows);
            value.pty = backend.spawn(shell, args, {
              cwd,
              env,
              ...size,
              name: "xterm-256color",
              useConpty: true,
              useConptyDll: process.platform === "win32"
            });
            value.pty.onData(emit);
            value.pty.onExit((event) => {
              value.exited = true;
              value.exitCode = event.exitCode;
              try {
                releaseWindowsResources(value.pty!);
              } catch (error) {
                value.cleanupError = `The shell stopped, but native terminal cleanup failed: ${error instanceof Error ? error.message : String(error)}. Reload VS Code before creating more terminals.`;
              }
              endProcess();
              emit(`\r\n\x1b[90m[Shell exited · ${event.exitCode}]\x1b[0m\r\n`);
            });
            resolveStart();
          } catch (error) {
            rejectStart(
              new Error(`Could not start ${shell}: ${error instanceof Error ? error.message : String(error)}`)
            );
          }
        },
        close: () => {
          if (value.disposed) {
            return;
          }
          value.disposed = true;
          terminals.delete(value.id);
          try {
            if (!value.exited) value.pty?.kill();
          } catch {
            /* The shell may already have exited. */
          }
          screen.dispose();
          write.dispose();
          overridden.dispose();
          closed.dispose();
          renamed.dispose();
        },
        handleInput: (data: string) => {
          if (!value.exited && !value.disposed) {
            const report =
              /^\x1b\[(?:\??[0-9;]*[Rcn]|\??[0-9;]+\$y)$/.test(data) || /^\x1b\](?:4|10|11|12);/.test(data);
            if (!report) {
              value.owner = undefined;
              value.ownerUntil = 0;
            }
            value.pty?.write(data);
          }
        },
        setDimensions: (size: vscode.TerminalDimensions) => {
          if (value.disposed || value.exited || value.ownerUntil > Date.now()) {
            return;
          }
          const cols = Math.min(300, Math.max(2, size.columns)),
            rows = Math.min(120, Math.max(1, size.rows));
          if (cols !== screen.cols || rows !== screen.rows) {
            screen.resize(cols, rows);
            value.pty?.resize(cols, rows);
          }
        }
      }
    });
  } catch (error) {
    screen.dispose();
    write.dispose();
    overridden.dispose();
    closed.dispose();
    renamed.dispose();
    throw error;
  }
  const value: SharedTerminal = {
    id: `pty:${randomUUID()}`,
    epoch: randomUUID(),
    cwd,
    name: native.name,
    shell,
    native,
    screen,
    serializer,
    sequence: 0,
    inputs: new Map(),
    ownerUntil: 0,
    pendingBytes: 0,
    exited: false,
    disposed: false,
    write,
    dimensions: overridden,
    closed,
    renamed,
    ended
  };
  terminals.set(value.id, value);
  try {
    native.show(true);
    await waitWithin(started, 5000, "The shell did not start in time. Check the VS Code terminal profile and retry.");
  } catch (error) {
    if (!value.disposed) {
      value.disposed = true;
      terminals.delete(value.id);
      try {
        if (!value.exited) value.pty?.kill();
      } catch {
        /* A failed startup may already have exited. */
      }
      screen.dispose();
      write.dispose();
      overridden.dispose();
      closed.dispose();
      renamed.dispose();
    }
    native.dispose();
    throw error;
  }
  return value;
}

export async function workspaceTerminal(
  cwd: string,
  terminalId: string | undefined,
  request: WorkspaceTerminalRequest | undefined,
  profile?: string,
  name?: string
): Promise<{ terminalSnapshot: WorkspaceTerminalSnapshot; workspaceTerminal: DashboardWorkspaceTerminalInfo }> {
  if (
    !request ||
    typeof request.clientId !== "string" ||
    !/^[a-zA-Z0-9-]{8,100}$/.test(request.clientId) ||
    !["create", "read", "input", "resize", "claim", "rename", "close"].includes(request.operation) ||
    (profile && !["default", "powershell", "cmd", "bash"].includes(profile))
  ) {
    throw new Error("Choose a valid terminal request.");
  }
  let value: SharedTerminal | undefined;
  if (request.operation === "create") {
    if (!request.operationId || !/^[a-zA-Z0-9-]{8,100}$/.test(request.operationId)) {
      throw new Error("A unique terminal creation ID is required.");
    }
    for (const [id, attempt] of creates) {
      if (attempt.expires <= Date.now()) {
        creates.delete(id);
      }
    }
    const key = `${request.clientId}:${request.operationId}`,
      fingerprint = JSON.stringify([cwd, profile, name]);
    const existing = creates.get(key);
    if (existing && existing.fingerprint !== fingerprint) {
      throw new Error("This terminal creation ID was already used for a different request.");
    }
    if (!existing) {
      if (creates.size >= 128) {
        throw new Error("Terminal creation history is full for this host. Reconnect after reloading VS Code.");
      }
      creates.set(key, { fingerprint, promise: create(cwd, profile, name), expires: Date.now() + 10 * 60_000 });
    }
    value = await creates.get(key)!.promise;
  } else {
    value = terminalId ? terminals.get(terminalId) : undefined;
  }
  if (!value || value.disposed) {
    throw new Error("This shared terminal is no longer open. Refresh the list or create a new terminal.");
  }
  if (!sameProject(value.cwd, cwd)) {
    throw new Error("This terminal belongs to another project. Select its project before controlling it.");
  }
  if (request.operation === "claim" || request.operation === "create") {
    if (request.operation === "claim" && request.takeControl === true) {
      value.ownerUntil = 0;
    }
    assertControl(value, { ...request, epoch: value.epoch });
  } else if (!["read", "close"].includes(request.operation)) {
    assertControl(value, request);
  }
  if (request.operation === "input") {
    if (
      typeof request.data !== "string" ||
      Buffer.byteLength(request.data) > 16 * 1024 ||
      !Number.isSafeInteger(request.sequence) ||
      request.sequence! < 1
    ) {
      throw new Error("Terminal input is invalid or too large. Paste at most 16 KB at once.");
    }
    const previous = value.inputs.get(request.clientId) ?? 0;
    if (request.sequence! > previous + 1) {
      throw new Error("A terminal input confirmation is missing. Reconnect before typing; commands were not replayed.");
    }
    if (request.sequence === previous + 1) {
      value.pty!.write(request.data);
      value.inputs.set(request.clientId, request.sequence);
    }
    if (value.inputs.size > 64) {
      for (const key of value.inputs.keys()) {
        if (key !== request.clientId) {
          value.inputs.delete(key);
          break;
        }
      }
    }
  } else if (request.operation === "resize") {
    const size = dimensions(request.cols, request.rows);
    if (size.cols !== value.screen.cols || size.rows !== value.screen.rows) {
      value.pty!.resize(size.cols, size.rows);
      value.screen.resize(size.cols, size.rows);
      value.dimensions.fire({ columns: size.cols, rows: size.rows });
    }
  } else if (request.operation === "rename") {
    if (!name?.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
      throw new Error("Use a terminal name of 1–80 characters.");
    }
    value.name = name.trim();
    value.renamed.fire(value.name);
  }
  const result = {
    terminalSnapshot: await snapshot(value, request.clientId, ["create", "read", "claim"].includes(request.operation)),
    workspaceTerminal: info(value)
  };
  if (request.operation === "close") {
    if (request.epoch !== value.epoch) {
      throw new Error("This terminal changed. Refresh before closing it.");
    }
    value.native.dispose();
    if (value.pty) {
      await waitWithin(
        value.ended,
        5000,
        "The terminal view closed, but the shell did not confirm it stopped. Check the selected PC’s processes before starting duplicate work."
      );
    }
    if (value.cleanupError) throw new Error(value.cleanupError);
    result.terminalSnapshot.exited = true;
    result.terminalSnapshot.writable = false;
    result.workspaceTerminal.state = "idle";
  }
  return result;
}
