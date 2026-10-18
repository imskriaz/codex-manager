/** Node path comparison and realpath must use the same spelling as VS Code. */
export function normalizeNativePath(value: string): string {
  return value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}
