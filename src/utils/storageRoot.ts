import * as os from "os";
import * as path from "path";

/** Manager databases share the canonical Codex home, independent of window isolation. */
export function getCodexManagerStorageRoot(homeDirectory = os.homedir()): string {
  const configured = process.env["CODEX_MANAGER_STORAGE_ROOT"]?.trim();
  return configured ? path.resolve(configured) : path.join(homeDirectory, ".codex");
}
