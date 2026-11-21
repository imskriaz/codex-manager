import type { DashboardCliSessionMessage } from './dashboard/types';

/** Keep project-relative locations; hide host and system directory prefixes. */
export function userWorkspacePathText(text: string, folders: string[]): string {
  const leaf = (path: string): string => {
    if (/^[a-z]:[\\/]*$/i.test(path)) return '[folder]';
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]+/).at(-1) || '[folder]';
    return /^(?:powershell|pwsh)(?:\.exe)?$/i.test(name) ? 'PowerShell' : name;
  };
  for (const folder of [...folders].sort((a,b) => b.length-a.length)) {
    const normalized = folder.replace(/[\\/]+$/, '');
    if (!normalized) continue;
    for (const variant of new Set([normalized, normalized.replace(/\\/g,'/'), normalized.replace(/\//g,'\\'), normalized.replace(/\\/g,'\\\\')])) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped + '(?=$|[\\\\/\\s"\'`<>|;:,)\\]}])', /^[a-z]:|^\\\\/i.test(normalized) ? 'gi' : 'g'), leaf(normalized));
    }
  }
  // Quoted paths may contain spaces. Process them before unquoted path tokens.
  text = text.replace(/(["'`])((?:[a-z]:[\\/]|\\\\)[^"'`\r\n]+)\1/gi, (match: string, quote: string, path: string, offset: number, source: string) => /\s+(?:-|&&|\|\|)/.test(path) ? match : quote + leaf(path) + (source[offset-1] === '\\' && path.endsWith('\\') ? '\\' : '') + quote);
  text = text.replace(/(?<![\w\\])(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'`<>|;,\[\]{}()]*/gi, leaf);
  text = text.replace(/(?<![\w:/\\])\/(?:[^\s"'`<>|;,\[\]{}()\\]+\/)+[^\s"'`<>|;,\[\]{}()\\]*/g, leaf);
  return text.replace(/(?<![\w:/\\])\/(?:bin|sbin|usr|etc|tmp|var|opt|home|root|mnt|srv|proc|sys|dev)(?=$|[\s"'`<>|;:,)\]}])/g, '[folder]');
}

/** Mask host locations while preserving commands, arguments, output and grouping. */
export function userSessionActivity(message: DashboardCliSessionMessage, folders: string[]): DashboardCliSessionMessage {
  if(message.role==='user')return message;
  const mask=(text:string|undefined)=>text === undefined ? text : userWorkspacePathText(text, folders);
  let title=mask(message.title);
  if(message.kind==='tool-call' && /^read(?:[_\s/\\]|$)/i.test(message.title??'')) {
    let file=(message.title??'').replace(/^read(?:[_\s]+file)?\s*/i,'');
    try { const args=JSON.parse(message.arguments??'{}') as {path?:unknown;file_path?:unknown};const path=args.path??args.file_path;if(typeof path==='string')file=path; } catch { /* Keep the recorded label when arguments are incomplete. */ }
    title='Read File'+(file?' · '+mask(file):'');
  }
  return {...message,cwd:undefined,debug:undefined,text:mask(message.text)!,command:mask(message.command),arguments:mask(message.arguments),output:mask(message.output),result:mask(message.result),title,subtitle:mask(message.subtitle),changes:message.changes?.map(change=>({...change,path:mask(change.path)!,diff:mask(change.diff)}))};
}

/** User-facing operational feedback must not reveal host or provider diagnostics. */
export function userWorkspaceNotice(message: string): string {
  if (/isolated runtime|host isolation/i.test(message)) return 'This action is not available right now. You can keep working with chat and files.';
  if (message === "Your daily token allowance is unavailable or has been reached. Check Usage in settings for the reset time.") return message;
  if (/(?:[a-z]:[\\/]|\\\\[^\s]+\\|\/(?:home|users|tmp|var|mnt|opt|etc)\/|\b(?:codex|sqlite|postgres|websocket|api|oauth|token|provider|sandbox|stack|errno|ENOENT|EACCES|EPERM)\b|\bHTTP\s*\d{3}\b)/i.test(message))
    return 'This request could not be completed. Please try again. Your work is saved.';
  return message;
}
