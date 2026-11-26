import { useEffect, useState } from 'preact/hooks';
import type { DashboardNotice } from '../../src/domain/dashboard/types';
import type { LocalFolderPermission } from '../../src/domain/localFolder';
import { request } from './teamSettingsRequest';

export function LocalFolderPermissionControl({project,onFeedback,onPermission}:{project:string;onPermission:(permission:LocalFolderPermission)=>void;onFeedback:(notice:DashboardNotice)=>void}) {
  const [permission,setPermission]=useState<LocalFolderPermission>('write');
  const [loading,setLoading]=useState(true);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    let active=true;setLoading(true);setFailed(false);
    void request<{permission:LocalFolderPermission}>('/api/workspace/local-folder','POST',{operation:'permission',project,client:crypto.randomUUID()}).then(value=>{if(active){setPermission(value.permission);onPermission(value.permission);}},()=>{if(active){setFailed(true);onFeedback({level:'warning',message:'Folder permission could not be loaded. Reopen message settings to retry.'});}}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[project]);
  return <label title="Applies to this connected folder in every chat. Full permits permanent deletion. The selected folder itself stays protected."><span>Permission</span><select aria-label="Folder permission" value={failed?'':permission} disabled={loading||failed} onChange={event=>{
    const next=event.currentTarget.value as LocalFolderPermission;setLoading(true);
    void request<{permission:LocalFolderPermission}>('/api/workspace/local-folder','POST',{operation:'permission',project,client:crypto.randomUUID(),permission:next}).then(value=>{setPermission(value.permission);onPermission(value.permission);onFeedback({level:'info',message:`Folder permission saved: ${value.permission==='read-only'?'Read only':value.permission==='full'?'Full':'Write'}.`});},error=>onFeedback({level:'error',message:error instanceof Error?error.message:'Folder permission was not saved.'})).finally(()=>setLoading(false));
  }}>{failed?<option value="">Unavailable</option>:null}<option value="read-only">Read only</option><option value="write">Write</option><option value="full">Full</option></select></label>;
}
