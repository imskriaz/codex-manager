import {useEffect,useState} from 'preact/hooks';
import {ModalShell} from './primitives';
import {request} from './teamSettingsRequest';
import type {OfficeFileRecord} from '../../src/services/officeFileHistory';
import type {DashboardActionResultPayload} from '../../src/domain/dashboard/types';
import {userWorkspaceNotice} from './userWorkspacePresentation';
export function UserFileRecovery(props:{path?:string;read:(action:'readWorkspaceFile',payload:{filePath:string})=>Promise<DashboardActionResultPayload>;onClose:()=>void;onChanged:()=>void}){
 const [records,setRecords]=useState<OfficeFileRecord[]>([]),[filter,setFilter]=useState(props.path?'version':'trash'),[status,setStatus]=useState('Loading saved files...'),[failed,setFailed]=useState(false),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState<OfficeFileRecord>();
 useEffect(()=>{let active=true;void request<{records:OfficeFileRecord[]}>('/api/workspace/file-history').then(value=>{if(active){setRecords(value.records);setStatus('');}},(error:unknown)=>{if(active){setStatus(userWorkspaceNotice((error instanceof Error?error.message:'This request could not be completed. Please try again.')));setFailed(true);}});return()=>{active=false;};},[props.path]);
 const act=async(record:OfficeFileRecord,action:'restore'|'discard')=>{
  if(busy)return;setBusy(true);setFailed(false);setStatus(action==='restore'?'Restoring...':'Removing...');
  try{const revision=action==='restore'&&record.kind==='version'?(await props.read('readWorkspaceFile',{filePath:record.path})).workspaceFile?.revision:undefined;
   const result=await request<{message:string}>('/api/workspace/file-history','POST',{id:record.id,action,revision,confirmed:action==='discard'});
   setConfirm(undefined);setStatus(result.message);props.onChanged();try{setRecords((await request<{records:OfficeFileRecord[]}>('/api/workspace/file-history')).records);}catch{setStatus(result.message+' Reopen File recovery to refresh this list.');}
  }catch(error){setStatus(userWorkspaceNotice(error instanceof Error?(error instanceof Error?error.message:'This request could not be completed. Please try again.'):'File recovery could not be confirmed. Refresh before retrying.'));setFailed(true);}finally{setBusy(false);}
 };
 const shown=records.filter(record=>record.kind===filter&&(!props.path||record.path===props.path));
 return <ModalShell open title={props.path?'File history':'File recovery'} closeLabel="Close file recovery" className="user-recovery-modal" closeDisabled={busy} onClose={props.onClose}>
 {!props.path?<label class="user-recovery-filter">Show<select aria-label="Saved file type" value={filter} disabled={busy} onChange={event=>{setFilter(event.currentTarget.value);setConfirm(undefined);}}><option value="trash">Trash</option><option value="version">Previous versions</option></select></label>:<p class="user-recovery-path">{props.path}</p>}
 {status?<p role={failed?'alert':'status'}>{status}</p>:null}
 {confirm?<section class="user-recovery-confirm" aria-label="Confirm permanent removal"><p>Permanently remove {confirm.path}? This saved copy cannot be recovered.</p><div><button type="button" disabled={busy} onClick={()=>{setConfirm(undefined);setStatus('Removal cancelled.');setFailed(false);}}>Cancel</button><button type="button" disabled={busy} onClick={()=>void act(confirm,'discard')}>Remove permanently</button></div></section>:null}
 <ul class="user-recovery-files">{shown.map(record=><li key={record.id}><span><strong title={record.path}>{record.path}</strong><small>{new Date(record.at).toLocaleString()} {record.bytes?' · '+(record.bytes/1024).toFixed(1)+' KB':''}</small></span><button type="button" disabled={busy||!!confirm} onClick={()=>void act(record,'restore')}>Restore</button><button type="button" disabled={busy||!!confirm} aria-label={`Remove saved copy of ${record.path}`} onClick={()=>{setConfirm(record);setStatus('');}}>Remove</button></li>)}</ul>{!shown.length&&!status?<p>No {filter==='trash'?'deleted files':'previous versions'} yet.</p>:null}
 </ModalShell>;
}
