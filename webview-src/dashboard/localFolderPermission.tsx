import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardNotice } from '../../src/domain/dashboard/types';
import type { LocalFolderPermission } from '../../src/domain/localFolder';
import { request } from './teamSettingsRequest';
export const folderPermissionChanged='codex-manager:folder-permission-changed';

export function LocalFolderPermissionControl({project,onFeedback,onPermission}:{project:string;onPermission:(permission:LocalFolderPermission)=>void;onFeedback:(notice:DashboardNotice)=>void}) {
  const currentProject=useRef<string|undefined>(project);
  const saving=useRef(false),requestRevision=useRef(0);
  const [permission,setPermission]=useState<LocalFolderPermission>('write');
  const [loading,setLoading]=useState(true);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    let active=true;currentProject.current=project;setLoading(true);setFailed(false);
    const refresh=()=>{
      if(saving.current)return;
      const revision=++requestRevision.current;
      void request<{permission:LocalFolderPermission}>('/api/workspace/local-folder','POST',{operation:'permission',project,client:crypto.randomUUID()}).then(value=>{if(active&&revision===requestRevision.current){setPermission(value.permission);onPermission(value.permission);setFailed(false);}},()=>{if(active&&revision===requestRevision.current){setFailed(true);onFeedback({level:'warning',message:'Folder permission could not be loaded. Reopen message settings to retry.'});}}).finally(()=>{if(active&&revision===requestRevision.current)setLoading(false);});
    };
    refresh();window.addEventListener('focus',refresh);window.addEventListener(folderPermissionChanged,refresh);
    return()=>{active=false;currentProject.current=undefined;window.removeEventListener('focus',refresh);window.removeEventListener(folderPermissionChanged,refresh);};
  },[project]);
  return <label title="Applies to this connected folder in every chat. Full permits permanent deletion. The selected folder itself stays protected."><span>Permission</span><select aria-label="Folder permission" value={failed?'':permission} disabled={loading||failed} onChange={event=>{
    if(saving.current)return;
    const next=event.currentTarget.value as LocalFolderPermission;saving.current=true;requestRevision.current++;setLoading(true);
    void request<{permission:LocalFolderPermission}>('/api/workspace/local-folder','POST',{operation:'permission',project,client:crypto.randomUUID(),permission:next}).then(value=>{if(currentProject.current===project){setPermission(value.permission);onPermission(value.permission);}onFeedback({level:'info',message:`Folder permission saved: ${value.permission==='read-only'?'Read only':value.permission==='full'?'Full':'Write'}.`});},error=>{if(currentProject.current===project)setFailed(true);onFeedback({level:'error',message:error instanceof Error?error.message:'Folder permission was not saved.'});}).finally(()=>{saving.current=false;if(currentProject.current===project)setLoading(false);window.dispatchEvent(new Event(folderPermissionChanged));});
  }}>{failed?<option value="">Unavailable</option>:null}<option value="read-only">Read only</option><option value="write">Write</option><option value="full">Full</option></select></label>;
}
