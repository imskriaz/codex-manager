import {getCodexManagerConfiguration} from '../infrastructure/config/extensionSettings';
import {fetch} from 'undici';
import {createHash} from 'node:crypto';

export type OfficeIntegrations={rendererUrl:string;rendererToken:string;runtimeUrl:string;runtimeToken:string;searchToken:string;searchDomains:string[]};
export const DEFAULT_OFFICE_INTEGRATIONS:OfficeIntegrations={rendererUrl:'',rendererToken:'',runtimeUrl:'',runtimeToken:'',searchToken:'',searchDomains:[]};
export function integrationUrl(value:unknown):string{
 if(typeof value!=='string'||value.length>2048)throw new Error('Enter a valid service address.');if(!value.trim())return '';
 let url:URL;try{url=new URL(value.trim());}catch{throw new Error('Enter a valid service address.');}
 if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('Use HTTPS, or HTTP on localhost, without credentials or query parameters.');
 return url.href.replace(/\/$/,'');
}
export function validateOfficeIntegrations(input:unknown,previous:OfficeIntegrations=DEFAULT_OFFICE_INTEGRATIONS):OfficeIntegrations{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Choose valid workspace services.');const value=input as Record<string,unknown>,result={...previous};
 if(Object.keys(value).some(key=>!Object.keys(DEFAULT_OFFICE_INTEGRATIONS).includes(key)))throw new Error('Choose valid workspace service fields.');
 for(const key of ['rendererUrl','runtimeUrl'] as const)if(value[key]!==undefined)result[key]=integrationUrl(value[key]);
 for(const key of ['rendererToken','runtimeToken','searchToken'] as const)if(value[key]!==undefined){if(typeof value[key]!=='string'||value[key].length>4096||/[\x00-\x20\x7f]/.test(value[key]))throw new Error('Enter a valid service key without whitespace.');result[key]=value[key];}
 if(value['searchDomains']!==undefined){if(!Array.isArray(value['searchDomains'])||value['searchDomains'].length>30||value['searchDomains'].some(domain=>typeof domain!=='string'||domain.length>253||!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)))throw new Error('Enter up to thirty source domains.');result.searchDomains=[...new Set(value['searchDomains'].map((domain:string)=>domain.toLowerCase()))];}
 return result;
}
function integrationState(){
 try{return {value:validateOfficeIntegrations(getCodexManagerConfiguration().get<unknown>('officeServices',DEFAULT_OFFICE_INTEGRATIONS)),warning:undefined};}
 catch{return {value:{...DEFAULT_OFFICE_INTEGRATIONS},warning:'Saved workspace service settings are invalid. Configure them again.'};}
}
export function readOfficeIntegrations():OfficeIntegrations{return integrationState().value;}
export function publicOfficeIntegrations(value?:OfficeIntegrations){
 const state=value?{value,warning:undefined}:integrationState();value=state.value;
 return {revision:createHash('sha256').update(JSON.stringify(value)).digest('base64url'),configurationWarning:state.warning,rendererUrl:value.rendererUrl,runtimeUrl:value.runtimeUrl,searchDomains:value.searchDomains,rendererConfigured:!!value.rendererUrl,runtimeConfigured:!!value.runtimeUrl,searchConfigured:!!value.searchToken,rendererKeyConfigured:!!value.rendererToken,runtimeKeyConfigured:!!value.runtimeToken};
}
export async function boundedResponse(response:Awaited<ReturnType<typeof fetch>>,maximum:number):Promise<Buffer>{
 const reader=response.body?.getReader();if(!reader)throw new Error('The service returned no data.');let size=0;const chunks:Buffer[]=[];
 try{while(true){const part=await reader.read() as {done:boolean;value:Uint8Array};if(part.done)break;size+=part.value.length;if(size>maximum)throw new Error('The service result exceeded the workspace limit.');chunks.push(Buffer.from(part.value));}}finally{await reader.cancel().catch(()=>undefined);}
 return Buffer.concat(chunks);
}
export async function checkOfficeIntegrations(signal:AbortSignal){
 const {value:settings,warning}=integrationState(),results:Record<string,{status:string;message:string}>={};
 if(warning)results['configuration']={status:'invalid',message:warning};
 await Promise.all(([['renderer',settings.rendererUrl,settings.rendererToken,'/health'],['runtime',settings.runtimeUrl,settings.runtimeToken,'/health']] as const).map(async([name,url,token,route])=>{
  if(!url){results[name]={status:'disabled',message:'Not configured'};return;}
  try{const response=await fetch(url+route,{redirect:'error',headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.any([signal,AbortSignal.timeout(3000)])});await response.body?.cancel();results[name]={status:response.ok?'ready':'unavailable',message:response.ok?'Service connected':'Service did not confirm readiness'};}catch{results[name]={status:'unavailable',message:'Service did not respond. Saved settings are kept.'};}
 }));
 results['search']={status:settings.searchToken?'configured':'disabled',message:settings.searchToken?'Key saved; verified when a search runs':'Not configured'};return results;
}
