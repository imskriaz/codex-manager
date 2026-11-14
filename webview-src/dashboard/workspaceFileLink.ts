import { normalizeNativePath } from '../../src/utils/nativePaths';

/** Classify local file references without turning web links into filesystem reads. */
export function workspaceFileFromLink(href: string): string | undefined {
  let value = href.trim();
  if (!value || value.startsWith('#') || value.startsWith('?') || /[\0\r\n]/.test(value)) return;
  if (/^(?:file:|vscode(?:-insiders)?:\/\/file\/)/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return;
      value = url.pathname;
      if (url.protocol === 'file:' && url.hostname && url.hostname !== 'localhost') value = `//${url.hostname}${value}`;
      else value = value.replace(/^\/([a-z]:\/)/i, '$1');
    } catch { return; }
  } else if (value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return;
  value = value.split(/[?#]/, 1)[0]!;
  try { value = decodeURIComponent(value); } catch { /* Keep a malformed filename local so its read reports failure. */ }
  value = value.replace(/(?::\d+(?::\d+)?)$/, '').replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1');
  return value && !/[\0\r\n]/.test(value) ? value : undefined;
}

export function workspaceRelativePath(filePath: string, projectPath: string | undefined): string {
  const native = normalizeNativePath(filePath);
  const file = (workspaceFileFromLink(native) ?? native).replace(/\\/g, '/');
  const root = normalizeNativePath(projectPath?.trim() ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const windows = /^(?:[a-z]:|\/\/)/i.test(root);
  const comparableFile = windows ? file.toLowerCase() : file;
  const comparableRoot = windows ? root.toLowerCase() : root;
  return root && comparableFile.startsWith(`${comparableRoot}/`) ? file.slice(root.length + 1) : file;
}
