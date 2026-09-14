import * as os from "os";
import * as path from "path";

const CODEX_MANAGER_STORAGE_DIRECTORY = ".codex-manager";

/**
 * Returns the extension's durable, version-independent filesystem root.
 *
 * VS Code's globalStorage directory is scoped to an installed extension and
 * can move or disappear across reinstall/update workflows. Files that must
 * survive those workflows belong under the user's home directory instead.
 */
export function getCodexManagerStorageRoot(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, CODEX_MANAGER_STORAGE_DIRECTORY);
}
