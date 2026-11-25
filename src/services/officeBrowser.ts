import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { Route } from 'playwright-core';
import { isPublicOfficeAddress } from './officeSources';
import { resolveOfficePath } from './officeWorkspacePaths';
import {getOfficeUser, type OfficeUser} from './officeUsers';
import { workspaceBrowser } from './workspaceBrowser';
import { validateBrowserRequest } from '../domain/workspaceBrowser';
import { waitWithin } from '../utils/concurrency';
import {officeLocalFolders,officeLocalProject} from './officeLocalFolders';

export const OFFICE_BROWSER_ORIGIN = 'https://workspace.invalid';
export function officeBrowserUrl(value: string): string {
  if (!value || value === 'about:blank' || /^https?:\/\//i.test(value)) return value;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) throw new Error('Enter a website address or a workspace file.');
  return OFFICE_BROWSER_ORIGIN + '/' + value.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}
export async function publicOfficeBrowserUrl(value: string): Promise<{url: URL; address: string; family: number}> {
  const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) throw new Error('Choose a public website address.');
  const addresses = isIP(host) ? [{address: host, family: isIP(host)}] : await waitWithin(lookup(host, {all: true}), 5000, 'Website lookup is taking longer than usual.');
  if (!addresses.length || addresses.some(item => !isPublicOfficeAddress(item.address))) throw new Error('This website is unavailable in your workspace.');
  return {url, ...addresses[0]!};
}
export async function routeOfficeBrowser(route: Route, user: OfficeUser, project: string): Promise<void> {
  try {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === OFFICE_BROWSER_ORIGIN) {
      if (!user.features.includes('files')) throw new Error('File access is unavailable.');
      const relative = decodeURIComponent(url.pathname.slice(1));
      let body: Buffer;
      if (officeLocalProject(user.id, project)) {
        const result = await officeLocalFolders.request(user.id, project, { operation: 'read', path: relative });
        if (typeof result.data !== 'string') throw new Error('The local file could not be read.');
        body = Buffer.from(result.data, 'base64');
      } else {
        const target = await resolveOfficePath(user.workspacePath, project, relative);
        if ((await stat(target)).size > 16 * 1048576) throw new Error('File is too large to preview.');
        body = await readFile(target);
      }
      const extension = relative.split('.').at(-1)?.toLowerCase() ?? '';
      const types: Record<string,string> = {html:'text/html',htm:'text/html',js:'text/javascript',css:'text/css',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',txt:'text/plain',pdf:'application/pdf',woff:'font/woff',woff2:'font/woff2'};
      await route.fulfill({status:200,contentType:types[extension] ?? 'application/octet-stream',body});
      return;
    }
    const {url: remote, address, family} = await publicOfficeBrowserUrl(url.href);
    const headers = await request.allHeaders();
    for (const name of ['host','connection','content-length','accept-encoding']) delete headers[name];
    headers['accept-encoding'] = 'identity';
    // Pin the verified address; redirects and subresources return through this same boundary.
    const response = await new Promise<{status:number;headers:Record<string,string>;body:Buffer}>((resolve,reject) => {
      const upstream = (remote.protocol === 'https:' ? httpsRequest : httpRequest)(remote, {method:request.method(),headers,family,lookup:(_host,_options,callback)=>callback(null,address,family),signal:AbortSignal.timeout(15000)}, result => {
        const chunks:Buffer[]=[];let size=0;
        result.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>16*1048576)upstream.destroy(new Error('Website response is too large.'));else chunks.push(chunk);});
        result.on('error',reject);
        result.on('end',()=>resolve({status:result.statusCode??502,headers:Object.fromEntries(Object.entries(result.headers).filter(([key,value])=>value!==undefined&&!['transfer-encoding','connection','content-length'].includes(key)).map(([key,value])=>[key,Array.isArray(value)?value.join('\n'):String(value)])),body:Buffer.concat(chunks)}));
      });
      upstream.on('error',reject);upstream.end(request.postDataBuffer()??undefined);
    });
    await route.fulfill(response);
  } catch { await route.abort('blockedbyclient').catch(()=>undefined); }
}
export async function officeBrowser(user: OfficeUser, project: string, raw: unknown) {
  const request = validateBrowserRequest(raw);
  // Only the page debugger commands used by the inspector may cross the protocol boundary.
  if (request.operation === 'cdp' && !['Debugger.enable','Debugger.pause','Debugger.resume','Debugger.stepOver','Debugger.setBreakpointByUrl','Debugger.setBreakpointsActive'].includes(request.method ?? '')) throw new Error('Use the page inspector controls for this action.');
  if (request.url) {
    request.url = officeBrowserUrl(request.url);
    if (request.url !== 'about:blank' && new URL(request.url).origin !== OFFICE_BROWSER_ORIGIN) await publicOfficeBrowserUrl(request.url);
  }
  let active = 0;
  return workspaceBrowser(project, request, {owner:user.id, route:async route=>{
    if (active >= 8) { await route.abort('blockedbyclient').catch(()=>undefined); return; }
    active++;
    try {
      const current = await getOfficeUser(user.id);
      if (!current?.enabled || current.role !== 'user' || !current.features.includes('browser') || current.workspacePath !== user.workspacePath) { await route.abort('blockedbyclient').catch(()=>undefined); return; }
      await routeOfficeBrowser(route,current,project);
    } finally { active--; }
  }});
}
