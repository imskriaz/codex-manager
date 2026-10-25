import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import { readSafeFileSnapshot } from "../utils/safeFileReads";
import { waitWithin } from "../utils/concurrency";

const HOST_STARTED_AT = Date.now() - process.uptime() * 1_000;
const FALLBACK_MS = 3 * 60_000;

export function hasOpenCodexEditors(): boolean {
  return (vscode.window.tabGroups?.all ?? []).some(group => group.tabs.some(tab =>
    /^(?:mainThreadWebview-)?chatgpt\.(?:conversationEditor|panelView)$/.test(String((tab.input as { viewType?: string })?.viewType))));
}

export function codexSidebarStartupState(log: string, notBefore: number, hostStartedAt = notBefore): "ready" | "failed" | undefined {
  let state: "ready" | "failed" | undefined;
  // Ignore an incomplete trailing record and evidence from an earlier extension host.
  for (const line of log.split(/\r?\n/).slice(0, -1)) {
    const timestamp = Date.parse(line.slice(0, 23).replace(" ", "T"));
    if (!Number.isFinite(timestamp) || timestamp < hostStartedAt) continue;
    if (line.includes("Activating Codex extension")) state = undefined;
    if (line.includes("renderer_ready_timeout") && /\brole=sidebar\b/.test(line)) state = "failed";
    if (timestamp < notBefore) continue;
    // shortcut: infer sidebar readiness from isolated renderer traces; use a public readiness API if Codex adds one.
    if (state !== "failed" && line.includes("client.performance.span") && /\bhostType=extension\b/.test(line) &&
        /\bname=app_start\b/.test(line) && /\boutcome=success\b/.test(line)) state = "ready";
  }
  return state;
}

/** Gate optional recovery on this window's renderer trace, with a timed fallback. */
export async function waitForCodexSidebarStartup(logUri: vscode.Uri | undefined, notBefore: number | undefined, signal: AbortSignal): Promise<"ready" | "fallback"> {
  signal.throwIfAborted();
  const extension = vscode.extensions.getExtension("openai.chatgpt");
  if (!extension) throw new Error("Enable the official Codex extension before Auto Resume. Saved recovery was kept.");
  const deadline = Date.now() + FALLBACK_MS;
  const status = vscode.window.setStatusBarMessage("Auto Resume: waiting for the main Codex sidebar (up to 3 minutes)…");
  try {
    await waitWithin(Promise.resolve(extension.activate()), Math.max(1, deadline - Date.now()), "Codex activation did not finish. Saved recovery was kept.", signal);
    signal.throwIfAborted();
    await waitWithin(Promise.resolve(vscode.commands.executeCommand("chatgpt.openSidebar")), Math.max(1, deadline - Date.now()), "Codex sidebar did not open. Saved recovery was kept.", signal);
    const file = logUri?.scheme === "file" ? path.join(path.dirname(logUri.fsPath), "openai.chatgpt", "Codex.log") : undefined;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (hasOpenCodexEditors()) throw new Error("A Codex tab was opened while waiting for the sidebar. Automatic recovery was kept to avoid opening competing tabs.");
      if (file) {
        try {
          const snapshot = await readSafeFileSnapshot(file, { maxBytes: 256 * 1024, startOffset: stat => Math.max(0, stat.size - 256 * 1024), timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())) });
          signal.throwIfAborted();
          if (hasOpenCodexEditors()) throw new SidebarStartupFailedError("A Codex tab was opened while inspecting sidebar readiness. Automatic recovery was kept.");
          const state = codexSidebarStartupState(snapshot.buffer.toString("utf8"), Math.max(HOST_STARTED_AT, notBefore ?? 0), HOST_STARTED_AT);
          if (state === "failed") throw new SidebarStartupFailedError();
          if (state === "ready") return "ready";
        } catch (error) { signal.throwIfAborted(); if (error instanceof SidebarStartupFailedError) throw error; }
      }
      await delay(Math.min(1_000, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
    signal.throwIfAborted();
    if (hasOpenCodexEditors()) throw new Error("A Codex tab was opened while waiting for the sidebar. Automatic recovery was kept to avoid opening competing tabs.");
    return "fallback";
  } finally { status.dispose(); }
}

class SidebarStartupFailedError extends Error {
  constructor(message = "The main Codex sidebar reported a renderer startup failure. Auto Resume opened no tabs; saved recovery was kept. Reopen the sidebar and retry.") { super(message); }
}
