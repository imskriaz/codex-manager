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
  value = value.replace(/(?::\d+(?::\d+)?)$/, '').replace(/\\/g, '/');
  return value && !/[\0\r\n]/.test(value) ? value : undefined;
}
