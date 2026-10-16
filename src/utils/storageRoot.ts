import * as os from "os";
import * as path from "path";

/** Manager databases share the canonical Codex home, independent of window isolation. */
export function getCodexManagerStorageRoot(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, ".codex");
}
