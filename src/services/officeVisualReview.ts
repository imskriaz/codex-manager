import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {OfficeUser} from './officeUsers';
import type {DashboardCliSessionMessage} from '../domain/dashboard/types';
import {resolveOfficePath} from './officeWorkspacePaths';
import {readOfficeImage} from './officeFiles';

export async function officeQuestionPreviews(user:OfficeUser,project:string,raw:unknown,questions:NonNullable<DashboardCliSessionMessage['questions']>):Promise<void>{
  if(!Array.isArray(raw))return;
  for(let index=0;index<raw.length;index++){
    const previews=(raw[index] as {previews?:unknown})?.previews;
    if(previews===undefined)continue;
    if(!user.features.includes('files')||!project||!Array.isArray(previews)||previews.length>6||previews.length<2)throw new Error('Choose a project and two to six visual options.');
    const root=await fs.realpath(user.workspacePath),canonical=await fs.realpath(project);
    if(canonical===root)throw new Error('Choose a saved project for visual review.');
    const question=questions[index]!,verified:NonNullable<typeof question.previews>=[],seen=new Set<string>();
    for(const value of previews){
      const preview=value as {option?:unknown;imagePath?:unknown;description?:unknown};
      if(!preview||typeof preview.option!=='string'||!question.options?.includes(preview.option)||seen.has(preview.option)||typeof preview.imagePath!=='string'||preview.description!==undefined&&(typeof preview.description!=='string'||preview.description.length>1000))throw new Error('Match each preview to a distinct listed option.');
      seen.add(preview.option);const target=await resolveOfficePath(root,canonical,preview.imagePath),relative=path.relative(canonical,target);
      if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Choose preview images inside this project.');
      const mimeType=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'} as Record<string,string>)[path.extname(target).toLowerCase()];
      if(!mimeType)throw new Error('Use PNG, JPEG or WebP preview images.');
      const filePath=path.relative(root,target).split(path.sep).join('/');await readOfficeImage(user,filePath,mimeType);
      verified.push({option:preview.option,image:'/api/workspace/image?filePath='+encodeURIComponent(filePath)+'&mimeType='+encodeURIComponent(mimeType),...(preview.description?{description:preview.description as string}:{})});
    }
    question.previews=verified;question.view=(raw[index] as {view?:unknown}).view==='list'?'list':'grid';
  }
}
