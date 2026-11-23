import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {Blob} from 'node:buffer';
import {fetch,FormData} from 'undici';
import {createHash} from 'node:crypto';
import {readOfficeIntegrations,boundedResponse} from './officeIntegrations';
import {extractOfficeDocument} from './officeDocuments';
import {getOfficeUser,type OfficeUser} from './officeUsers';
import {resolveOfficePath} from './officeWorkspacePaths';
import {writeOfficeBinary} from './officeFiles';
import {runCrossWindowExclusive} from '../utils/crossWindowOperations';

export async function officeDocumentPdf(name:string,data:Buffer,signal:AbortSignal):Promise<Buffer>{
 if(/\.pdf$/i.test(name))return data;
 const config=readOfficeIntegrations();if(!config.rendererUrl)throw new Error('Page rendering is not configured. An outline preview is available.');
 await extractOfficeDocument(name,data,'validate');signal.throwIfAborted();const form=new FormData();form.append('files',new Blob([new Uint8Array(data)]) as never,path.basename(name));
 const response=await fetch(config.rendererUrl+'/forms/libreoffice/convert',{method:'POST',body:form,redirect:'error',headers:config.rendererToken?{Authorization:'Bearer '+config.rendererToken}:{},signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
 if(!response.ok){await response.body?.cancel();throw new Error('Page rendering is temporarily unavailable. The original document is kept.');}
 const pdf=await boundedResponse(response,10*1048576);if(!pdf.subarray(0,8).toString().startsWith('%PDF-'))throw new Error('The rendering service returned an invalid document.');return pdf;
}
export async function renderOfficePreview(name:string,data:Buffer,signal:AbortSignal){return extractOfficeDocument('preview.pdf',await officeDocumentPdf(name,data,signal),'html');}
export async function renderOfficeThumbnails(user:OfficeUser,project:string,input:Record<string,unknown>,signal:AbortSignal){
 if(!user.enabled||user.role!=='user'||!user.features.includes('files'))throw new Error('File access is unavailable.');
 if(typeof input['path']!=='string'||! /\.(?:docx|pptx|xlsx|pdf)$/i.test(input['path']))throw new Error('Choose a Word, PowerPoint, Excel or PDF document.');
 const root=await fs.realpath(user.workspacePath),cwd=await fs.realpath(project);if(cwd===root)throw new Error('Choose a saved project before rendering pages.');
 const file=await resolveOfficePath(root,cwd,input['path']),relative=path.relative(cwd,file);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Choose a document inside this project.');
 if((await fs.stat(file)).size>10*1048576)throw new Error('Keep documents under 10 MB.');const data=await fs.readFile(file),revision=createHash('sha256').update(data).digest('base64url');
 const pages=JSON.parse(await extractOfficeDocument('preview.pdf',await officeDocumentPdf(input['path'],data,signal),'images')) as {total:number;pages:Array<{page:number;image:string}>};
 return runCrossWindowExclusive(`office-storage:${user.id}`,'Save rendered page previews',async()=>{
  signal.throwIfAborted();const current=await getOfficeUser(user.id);if(!current?.enabled||current.role!=='user'||current.workspacePath!==user.workspacePath||!current.features.includes('files'))throw new Error('File access changed. Page previews were not saved.');
  await resolveOfficePath(root,cwd,input['path']);if(createHash('sha256').update(await fs.readFile(file)).digest('base64url')!==revision)throw new Error('The document changed while rendering. Render its latest version.');
  const previews:Array<{page:number;path:string}>=[];
  for(const page of pages.pages){signal.throwIfAborted();if(!Number.isInteger(page.page)||!/^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(page.image))throw new Error('A page preview was invalid.');const output=`.previews/${revision}/page-${page.page}.png`;const image=Buffer.from(page.image.split(',')[1]!,'base64');
   try{const existing=await fs.readFile(await resolveOfficePath(root,cwd,output));if(!existing.equals(image))throw new Error('A saved preview changed. Render the document again.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await writeOfficeBinary(current,cwd,output,image);}
   previews.push({page:page.page,path:output});
  }
  return {totalPages:pages.total,previews,revision,message:`Rendered ${previews.length} of ${pages.total} pages. Review the original for font and layout fidelity.`};
 },{waitMs:2000});
}
