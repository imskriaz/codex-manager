import type { DashboardCliSessionMessage } from './dashboard/types';

/** Mask host locations while preserving commands, arguments, output and grouping. */
export function userSessionActivity(message: DashboardCliSessionMessage, folders: string[]): DashboardCliSessionMessage {
  if(message.role==='user')return message;
  const mask=(text:string|undefined)=>{
    if(text===undefined)return text;
    for(const folder of [...folders].sort((a,b)=>b.length-a.length))for(const variant of [folder,folder.replace(/\\/g,'/'),folder.replace(/\//g,'\\'),folder.replace(/\\/g,'\\\\')])if(variant)text=text.split(variant).join('[workspace]');
    return text;
  };
  return {...message,cwd:undefined,debug:undefined,text:mask(message.text)!,command:mask(message.command),arguments:mask(message.arguments),output:mask(message.output),result:mask(message.result),title:mask(message.title),subtitle:mask(message.subtitle),changes:message.changes?.map(change=>({...change,path:mask(change.path)!,diff:mask(change.diff)}))};
}

/** User-facing operational feedback must not reveal host or provider diagnostics. */
export function userWorkspaceNotice(message: string): string {
  if (/(?:[a-z]:[\\/]|\\\\[^\s]+\\|\/(?:home|users|tmp|var|mnt|opt|etc)\/|\b(?:codex|sqlite|postgres|websocket|api|oauth|token|provider|sandbox|stack|errno|ENOENT|EACCES|EPERM)\b|\bHTTP\s*\d{3}\b)/i.test(message))
    return 'This request could not be completed. Please try again. Your work is saved.';
  return message;
}
