import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { MaintenanceReport } from "../domain/maintenance";
import { readSafeFileSnapshot } from "../utils/safeFileReads";
import { waitWithin } from "../utils/concurrency";
import { openNewCodexWebview, resolveCodexHome } from "./codexSessionResume";

let opening: Promise<void> | undefined;

export async function reopenCodexUi(): Promise<MaintenanceReport> {
  if (!opening) {
    const work = openNewCodexWebview().finally(() => { if (opening === work) opening = undefined; });
    opening = work;
  }
  await waitWithin(opening, 20_000, "VS Code has not confirmed opening Codex. The request may still finish; check its panel before retrying.");
  return { title: "Codex UI recovery", items: [
    { label: "Fresh Codex panel", value: "Open request completed. Check that the new panel finishes loading." },
    { label: "If startup still fails", value: "Close unused Codex tabs, clean archives, then reload VS Code. Login and conversations have been kept." }
  ] };
}

export async function inspectCodexUi(): Promise<MaintenanceReport> {
  const items: MaintenanceReport["items"] = [];
  const extension = vscode.extensions.getExtension("openai.chatgpt");
  if (!extension) items.push({ label: "Codex extension", value: "Not installed or disabled in this host" });
  else {
    const manifest = extension.packageJSON as { version?: unknown } | undefined;
    items.push({ label: "Codex extension", value: `${typeof manifest?.version === "string" ? manifest.version : "Unknown version"} · ${extension.isActive ? "Active" : "Not activated"}` });
    const root = path.join(extension.extensionPath, "webview");
    try {
      const html = (await readSafeFileSnapshot(path.join(root, "index.html"), { maxBytes: 256 * 1024, rejectIfLarger: true })).buffer.toString("utf8");
      const assets = [...new Set([...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))(?:\?[^"']*)?["']/g)].map(match => match[1]!))];
      if (!assets.length || assets.length > 32) throw new Error("The installed UI entry files could not be verified.");
      const canonical = await fs.realpath(root);
      for (const asset of assets) {
        const file = await fs.realpath(path.resolve(root, asset.replace(/^\/+/, "")));
        const relative = path.relative(canonical, file);
        if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("A UI entry file is outside the installed extension.");
        const stat = await fs.stat(file);
        if (!stat.isFile() || !stat.size) throw new Error("An installed UI entry file is missing or empty.");
        items.push({ label: path.basename(asset), value: `${(stat.size / 1024 / 1024).toFixed(1)} MB` });
      }
      items.push({ label: "UI entry files", value: "Present. A renderer startup timeout can still occur while VS Code is busy." });
    } catch (error) { items.push({ label: "UI entry files", value: `Unavailable: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  const home = resolveCodexHome();
  try {
    const files = (await fs.readdir(home)).filter(name => /^(?:state|goals|thread_history|logs)_\d+\.sqlite$/.test(name));
    for (const name of files) {
      try {
        const stat = await fs.lstat(path.join(home, name));
        if (stat.isFile() && !stat.isSymbolicLink()) items.push({ label: name, value: `${(stat.size / 1024 / 1024).toFixed(1)} MB` });
      } catch { items.push({ label: name, value: "Unavailable; storage may have changed during inspection." }); }
    }
  } catch { items.push({ label: "Native storage", value: "Unavailable. Check that the Codex home exists and is readable." }); }
  items.push({ label: "Startup recovery", value: "Open a fresh Codex panel. Use Archive manager to remove archived chats without loading their complete histories." });
  return { title: "Codex UI startup check", items };
}
