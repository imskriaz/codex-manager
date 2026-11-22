import {UserActionsMenu} from './userActionsMenu';
import {UserFileRecovery} from './userFileRecovery';
import {readChatAttachmentFiles} from './attachmentUploads';
import {ModalShell} from './primitives';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardWorkspaceFileEntry, DashboardNotice } from '../../src/domain/dashboard/types';
import type { UserSchedule } from '../../src/domain/officeSchedule';
import { request } from './teamSettingsRequest';
import { useWorkspaceRequest } from './workspaceRequest';
import { downloadWorkspaceFile } from './workspaceDownload';
import { userWorkspaceNotice } from './userWorkspacePresentation';
import { DownloadIcon, renderRefreshIcon } from './icons';

const message=(error:unknown)=>userWorkspaceNotice(error instanceof Error?error.message:'This request could not be completed. Please try again.');

function fileType(file:string){return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(file)?'images':/\.html?$/i.test(file)?'websites':/\.(zip|rar|7z|tar|gz)$/i.test(file)?'archives':/\.(pdf|docx?|xlsx?|csv|txt|md|pptx?)$/i.test(file)?'documents':'other';}
function sizeLabel(bytes:number){return bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(1)} MB`;}
export function UserWorkspaceLibrary(props:{root?:string;connected:boolean;onOpen:(path:string)=>void;onFeedback:(notice:DashboardNotice)=>void}){
  const read=useWorkspaceRequest(props.root,undefined,props.connected);
  const [files,setFiles]=useState<DashboardWorkspaceFileEntry[]>([]),[query,setQuery]=useState(''),[filter,setFilter]=useState('all');
  const [status,setStatus]=useState(''),[failed,setFailed]=useState(false),[loading,setLoading]=useState(false),[tick,setTick]=useState(0),[busy,setBusy]=useState('');
  const [storage,setStorage]=useState<{bytes?:number;limit?:number;warning?:string}>({});
  const [recovery,setRecovery]=useState<{path?:string}>(),[deleting,setDeleting]=useState<DashboardWorkspaceFileEntry>();
  const uploadRef=useRef<HTMLInputElement>(null);
  const upload=async(files:File[])=>{
    if(!files.length||busy)return;setBusy('upload');setStatus('Uploading files...');setFailed(false);
    try{const attachments=await readChatAttachmentFiles(files);const result=await request<{message:string}>('/api/workspace/files','POST',{attachments});feedback(result.message);setTick(value=>value+1);}
    catch(error){feedback(message(error),true);}finally{setBusy('');if(uploadRef.current)uploadRef.current.value='';}
  };
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{let active=true;setLoading(true);if(!tick)setStatus('Loading files...');
    void read('listWorkspaceFiles').then(value=>{if(!active)return;setFiles((value.workspaceFiles??[]).filter(file=>file.type==='file'));setStatus(previous=>value.workspaceFilesWarning?'Some files could not be listed. Readable files are shown; refresh to retry.':previous==='Refreshing files...'?'Files refreshed.':previous==='Loading files...'?'':previous);},error=>{if(active){setStatus(message(error));setFailed(true);}}).finally(()=>{if(active)setLoading(false);});
    void request<{limits?:{storageMb:number};usage?:{storageBytes?:number;storageWarning?:string}}>('/api/workspace/preferences').then(value=>{if(active)setStorage({bytes:value.usage?.storageBytes,limit:value.limits?.storageMb,warning:value.usage?.storageWarning?'Storage usage is temporarily unavailable.':''});},()=>{if(active)setStorage({warning:'Storage usage could not be loaded. Refresh to retry.'});});
    return()=>{active=false;};
  },[read,tick]);
  const feedback=(text:string,error=false)=>{setStatus(text);setFailed(error);if(!mounted.current)props.onFeedback({level:error?'error':'info',message:text});};
  const act=async(file:DashboardWorkspaceFileEntry,remove=false)=>{

    setBusy(file.path);setFailed(false);setStatus('');try{
      if(remove){
        const value=await read('readWorkspaceFile',{filePath:file.path});
        if(!value.workspaceFile?.revision)throw new Error('This file could not be verified for deletion. Open it and try again.');
        await read('deleteWorkspaceFile',{filePath:file.path,fileRevision:value.workspaceFile.revision,confirmed:true});
        setFiles(current=>current.filter(item=>item.path!==file.path));setStorage({warning:'Refresh to update storage usage.'});setDeleting(undefined);feedback('File moved to Trash.');
      }else{
        await downloadWorkspaceFile(file.path,payload=>read('readWorkspaceFile',payload),(blob,name)=>{const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);});
        feedback('Download started.');if(mounted.current)props.onFeedback({level:'info',message:'Download started.'});
      }
    }catch(error){feedback(message(error),true);}finally{setBusy('');}
  };
  const shown=files.filter(file=>file.path.toLowerCase().includes(query.toLowerCase())&&(filter==='all'||fileType(file.path)===filter));
  const limitBytes=(storage.limit??0)*1048576;
  return <section class="user-workspace-page user-library" aria-label="Library"><header><h1>Library</h1><div class="user-page-actions"><input ref={uploadRef} type="file" multiple hidden onChange={event=>void upload(Array.from(event.currentTarget.files??[]))}/><button type="button" class="user-page-icon" aria-label="Upload files" title="Upload files" disabled={!!busy||!props.connected} onClick={()=>uploadRef.current?.click()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/></svg></button><button type="button" class="user-page-icon" aria-label="File recovery" title="File recovery" disabled={!!busy||!props.connected} onClick={()=>setRecovery({})}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2"/></svg></button><button type="button" class="user-page-icon" aria-label="Refresh files" title="Refresh files" disabled={loading||!!busy||!props.connected} onClick={()=>{setStatus('Refreshing files...');setFailed(false);setTick(value=>value+1);}}>{renderRefreshIcon()}</button></div></header>
    <section class="user-library-storage" aria-label="File storage"><div><strong>{storage.bytes===undefined?'Usage unavailable':sizeLabel(storage.bytes)}</strong><span>{limitBytes?` / ${sizeLabel(limitBytes)}`:' used'}</span><small>{files.length} {files.length===1?'file':'files'}</small></div>{limitBytes>0&&storage.bytes!==undefined?<progress aria-label="Storage used" max={limitBytes} value={storage.bytes}/>:null}{storage.warning?<p role="status">{storage.warning}</p>:null}</section>
    <div class="user-page-filters"><input type="search" aria-label="Search library" placeholder="Search files..." value={query} onInput={event=>setQuery(event.currentTarget.value)}/><select aria-label="File type" value={filter} onChange={event=>setFilter(event.currentTarget.value)}><option value="all">All files</option><option value="documents">Documents</option><option value="images">Images</option><option value="websites">Websites</option><option value="archives">Archives</option><option value="other">Other</option></select></div>
    {status?<p role={failed?'alert':'status'}>{status}</p>:null}{loading?<p role="status">Loading files...</p>:<>{query||filter!=='all'?<small>{shown.length} {shown.length===1?'match':'matches'}</small>:null}{shown.length?<ul class="user-library-files">{shown.map(file=><li key={file.path}><button type="button" onClick={()=>props.onOpen(file.path)}><strong>{file.name}</strong><small title={file.path}>{file.path}</small></button><div class="user-page-actions"><button type="button" class="user-page-icon" aria-label={`Download ${file.name}`} title={`Download ${file.name}`} aria-busy={busy===file.path} disabled={!!busy||!props.connected} onClick={()=>void act(file)}><DownloadIcon /></button><UserActionsMenu label={`Actions for ${file.name}`} disabled={!!busy||!props.connected} items={[{label:'File history',run:()=>setRecovery({path:file.path})},{label:'Move to Trash',run:()=>{setStatus('');setDeleting(file);}}]}/></div></li>)}</ul>:<p class="user-page-empty">{files.length?'No files match your search.':'Files you create with your assistant will appear here.'}</p>}</>}
    {recovery?<UserFileRecovery path={recovery.path} read={read} onClose={()=>setRecovery(undefined)} onChanged={()=>setTick(value=>value+1)}/>:null}
    <ModalShell open={!!deleting} title="Move file to Trash" closeLabel="Close delete file" className="user-confirm-modal" closeDisabled={!!busy} onClose={()=>{setDeleting(undefined);feedback('File deletion cancelled.');}}><p>{deleting?.name} can be restored from File recovery.</p>{failed&&status?<p role="alert">{status}</p>:null}<div class="user-page-actions"><button type="button" disabled={!!busy} onClick={()=>{setDeleting(undefined);feedback('File deletion cancelled.');}}>Cancel</button><button type="button" disabled={!!busy} onClick={()=>deleting&&void act(deleting,true)}>Move to Trash</button></div></ModalShell>
  </section>;
}

export function UserWorkspaceScheduled(props:{connected:boolean;onOpen:(task:UserSchedule)=>void;onPrompt:(text:string,project?:string)=>void;onFeedback:(notice:DashboardNotice)=>void}){
  const [removing,setRemoving]=useState<UserSchedule>();
  const [tasks,setTasks]=useState<UserSchedule[]>([]),[tick,setTick]=useState(0),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[status,setStatus]=useState(''),[failed,setFailed]=useState(false);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{let active=true;setLoading(true);void request<{schedules:UserSchedule[]}>('/api/workspace/schedules').then(value=>{if(active){setTasks(value.schedules);setStatus(previous=>previous==='Refreshing schedules...'?'Schedules refreshed.':previous);}},error=>{if(active){setStatus(message(error));setFailed(true);}}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[tick]);
  useEffect(()=>{const timer=setInterval(()=>setTick(value=>value+1),30000);return()=>clearInterval(timer);},[]);
  const mutate=async(task:UserSchedule,action:'run'|'pause'|'resume'|'remove')=>{setBusy(true);setStatus('');setFailed(false);try{
    const result=await request<{message:string;outcome?:string}>('/api/workspace/schedules/'+task.id,action==='remove'?'DELETE':'POST',{revision:task.revision,...(action==='remove'?{}:{action})});
    setRemoving(undefined);setStatus(result.message);setFailed(result.outcome==='failed');setTick(value=>value+1);
    if(!mounted.current)props.onFeedback({level:result.outcome==='failed'?'error':'info',message:result.message});
  }catch(error){setStatus(message(error));setFailed(true);if(!mounted.current)props.onFeedback({level:'error',message:message(error)});}finally{setBusy(false);}};
  return <section class="user-workspace-page user-scheduled" aria-label="Scheduled tasks"><header><h1>Scheduled</h1><button type="button" class="user-page-icon" aria-label="Refresh schedules" title="Refresh schedules" disabled={loading||busy||!props.connected} onClick={()=>{setStatus('Refreshing schedules...');setFailed(false);setTick(value=>value+1);}}>{renderRefreshIcon()}</button></header>
    {status?<p role={failed?'alert':'status'}>{status}</p>:null}
    {loading&&!tasks.length?<p role="status">Loading schedules...</p>:!tasks.length?<div class="user-page-empty"><p>{failed?'Refresh to load your scheduled tasks.':'No scheduled tasks yet.'}</p>{!failed?<small>Ask in chat to schedule a task.</small>:null}</div>:<ul class="user-schedule-list">{tasks.map(task=><li key={task.id}><div class="user-schedule-copy"><h2>{task.title}</h2><small>{task.enabled?`Next: ${new Date(task.nextRunAt).toLocaleString(undefined,{timeZone:task.timeZone})} (${task.timeZone})`:task.frequency==='once'&&task.lastSessionId?(task.runStatus??'queued').replace('needs-answer','Needs answer').replace(/^./,char=>char.toUpperCase()):'Paused'}</small>{task.enabled&&task.runStatus?<small class={'user-run-status is-'+task.runStatus}>{task.runStatus.replace('needs-answer','Needs answer').replace(/^./,char=>char.toUpperCase())}</small>:null}<p title={task.prompt}>{task.prompt}</p></div>{task.lastError?<p class="user-page-error" role="alert">{task.lastError}</p>:null}<div class="user-page-actions"><button type="button" disabled={busy||!props.connected} onClick={()=>void mutate(task,'run')}>Run now</button>{task.lastSessionId?<button type="button" class="user-schedule-result" aria-label="View conversation" onClick={()=>props.onOpen(task)}>View result</button>:null}<UserActionsMenu label={`Actions for ${task.title}`} disabled={busy||!props.connected} items={[{label:task.enabled?'Pause':'Resume',run:()=>void mutate(task,task.enabled?'pause':'resume')},{label:'Edit with AI',run:()=>props.onPrompt(`Please update scheduled task "${task.title}" (ID: ${task.id}). List my schedules first and ask what I want to change. Keep its selected model unless I explicitly choose another.`,task.projectPath)},{label:'Remove schedule',run:()=>setRemoving(task)}]}/></div></li>)}</ul>}
    <ModalShell open={!!removing} title="Remove schedule" closeLabel="Close remove schedule" className="user-confirm-modal" closeDisabled={busy} onClose={()=>{setRemoving(undefined);setStatus('Schedule removal cancelled.');setFailed(false);}}><p>Remove {removing?.title}? Existing conversations and files will be kept.</p>{failed&&status?<p role="alert">{status}</p>:null}<div class="user-page-actions"><button type="button" disabled={busy} onClick={()=>{setRemoving(undefined);setStatus('Schedule removal cancelled.');setFailed(false);}}>Cancel</button><button type="button" disabled={busy} onClick={()=>removing&&void mutate(removing,'remove')}>Remove schedule</button></div></ModalShell>
  </section>;
}
