import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardWorkspaceFileEntry, DashboardNotice } from '../../src/domain/dashboard/types';
import type { UserSchedule } from '../../src/domain/officeSchedule';
import { request } from './teamSettingsRequest';
import { useWorkspaceRequest } from './workspaceRequest';
import { downloadWorkspaceFile } from './workspaceDownload';
import { userWorkspaceNotice } from './userWorkspacePresentation';

const message=(error:unknown)=>userWorkspaceNotice(error instanceof Error?error.message:'This request could not be completed. Please try again.');

function fileType(file:string){return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(file)?'images':/\.html?$/i.test(file)?'websites':/\.(zip|rar|7z|tar|gz)$/i.test(file)?'archives':/\.(pdf|docx?|xlsx?|csv|txt|md|pptx?)$/i.test(file)?'documents':'other';}
function sizeLabel(bytes:number){return bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(1)} MB`;}
export function UserWorkspaceLibrary(props:{root?:string;connected:boolean;onOpen:(path:string)=>void;onFeedback:(notice:DashboardNotice)=>void}){
  const read=useWorkspaceRequest(props.root,undefined,props.connected);
  const [files,setFiles]=useState<DashboardWorkspaceFileEntry[]>([]),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[grid,setGrid]=useState(false);
  const [status,setStatus]=useState(''),[failed,setFailed]=useState(false),[loading,setLoading]=useState(false),[tick,setTick]=useState(0),[busy,setBusy]=useState('');
  const [storage,setStorage]=useState<{bytes?:number;limit?:number;warning?:string}>({});
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{let active=true;setLoading(true);setFailed(false);setStatus('');
    void read('listWorkspaceFiles').then(value=>{if(!active)return;setFiles((value.workspaceFiles??[]).filter(file=>file.type==='file'));setStatus(value.workspaceFilesWarning?'Some files could not be listed. Readable files are shown; refresh to retry.':'');},error=>{if(active){setStatus(message(error));setFailed(true);}}).finally(()=>{if(active)setLoading(false);});
    void request<{limits?:{storageMb:number};usage?:{storageBytes?:number;storageWarning?:string}}>('/api/workspace/preferences').then(value=>{if(active)setStorage({bytes:value.usage?.storageBytes,limit:value.limits?.storageMb,warning:value.usage?.storageWarning?'Storage usage is temporarily unavailable.':''});},()=>{if(active)setStorage({warning:'Storage usage could not be loaded. Refresh to retry.'});});
    return()=>{active=false;};
  },[read,tick]);
  const feedback=(text:string,error=false)=>{setStatus(text);setFailed(error);if(!mounted.current)props.onFeedback({level:error?'error':'info',message:text});};
  const act=async(file:DashboardWorkspaceFileEntry,remove=false)=>{
    if(remove&&!window.confirm(`Delete ${file.name}? This cannot be undone.`)){feedback('File deletion cancelled.');return;}
    setBusy(file.path);setFailed(false);setStatus('');try{
      if(remove){
        const value=await read('readWorkspaceFile',{filePath:file.path});
        if(!value.workspaceFile?.revision)throw new Error('This file could not be verified for deletion. Open it and try again.');
        await read('deleteWorkspaceFile',{filePath:file.path,fileRevision:value.workspaceFile.revision,confirmed:true});
        setFiles(current=>current.filter(item=>item.path!==file.path));setStorage({warning:'Refresh to update storage usage.'});feedback('File deleted.');
      }else{
        await downloadWorkspaceFile(file.path,payload=>read('readWorkspaceFile',payload),(blob,name)=>{const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);});
        feedback('Download started.');if(mounted.current)props.onFeedback({level:'info',message:'Download started.'});
      }
    }catch(error){feedback(message(error),true);}finally{setBusy('');}
  };
  const shown=files.filter(file=>file.path.toLowerCase().includes(query.toLowerCase())&&(filter==='all'||fileType(file.path)===filter));
  const limitBytes=(storage.limit??0)*1048576;
  return <section class="user-workspace-page user-library" aria-label="Library"><header><div><h1>Library</h1><p>All your workspace and project files, in one place.</p></div><button type="button" disabled={loading||!!busy||!props.connected} onClick={()=>setTick(value=>value+1)}>Refresh files</button></header>
    <section class="user-library-storage" aria-label="File storage"><div><strong>{storage.bytes===undefined?'Usage unavailable':sizeLabel(storage.bytes)}</strong><span>{limitBytes?` / ${sizeLabel(limitBytes)}`:' used'}</span><small>{files.length} {files.length===1?'file':'files'}</small></div>{limitBytes>0&&storage.bytes!==undefined?<progress aria-label="Storage used" max={limitBytes} value={storage.bytes}/>:null}{storage.warning?<p role="status">{storage.warning}</p>:null}<div class="user-library-types">{(['documents','images','websites','archives','other'] as const).map(type=>{const count=files.filter(file=>fileType(file.path)===type).length;return count?<small key={type}>{type}: {count}</small>:null;})}</div></section>
    <div class="user-page-filters"><input type="search" aria-label="Search library" placeholder="Search files..." value={query} onInput={event=>setQuery(event.currentTarget.value)}/><select aria-label="File type" value={filter} onChange={event=>setFilter(event.currentTarget.value)}><option value="all">All files</option><option value="documents">Documents</option><option value="images">Images</option><option value="websites">Websites</option><option value="archives">Archives</option><option value="other">Other</option></select><button type="button" aria-pressed={grid} onClick={()=>setGrid(value=>!value)}>{grid?'List view':'Grid view'}</button></div>
    {status?<p role={failed?'alert':'status'}>{status}</p>:null}{loading?<p role="status">Loading files...</p>:<><small>{shown.length} {shown.length===1?'file':'files'}</small>{shown.length?<ul class={`user-library-files ${grid?'is-grid':''}`}>{shown.map(file=><li key={file.path}><button type="button" onClick={()=>props.onOpen(file.path)}><strong>{file.name}</strong><small>{file.path}</small></button><div class="user-page-actions"><button type="button" aria-label={`Download ${file.name}`} disabled={!!busy||!props.connected} onClick={()=>void act(file)}>{busy===file.path?'Working...':'Download'}</button><button type="button" aria-label={`Delete ${file.name}`} disabled={!!busy||!props.connected} onClick={()=>void act(file,true)}>Delete</button></div></li>)}</ul>:<p>{files.length?'No files match your search.':'Files you create with your assistant will appear here.'}</p>}</>}
  </section>;
}

export function UserWorkspaceScheduled(props:{connected:boolean;onOpen:(task:UserSchedule)=>void;onPrompt:(text:string,project?:string)=>void;onFeedback:(notice:DashboardNotice)=>void}){
  const [tasks,setTasks]=useState<UserSchedule[]>([]),[tick,setTick]=useState(0),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[status,setStatus]=useState(''),[failed,setFailed]=useState(false);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(()=>{let active=true;setLoading(true);void request<{schedules:UserSchedule[]}>('/api/workspace/schedules').then(value=>{if(active){setTasks(value.schedules);setStatus(previous=>previous==='Refreshing schedules...'?'Schedules refreshed.':previous);}},error=>{if(active){setStatus(message(error));setFailed(true);}}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[tick]);
  useEffect(()=>{const timer=setInterval(()=>setTick(value=>value+1),30000);return()=>clearInterval(timer);},[]);
  const mutate=async(task:UserSchedule,action:'run'|'pause'|'resume'|'remove')=>{setBusy(true);setStatus('');setFailed(false);try{
    const result=await request<{message:string;outcome?:string}>('/api/workspace/schedules/'+task.id,action==='remove'?'DELETE':'POST',{revision:task.revision,...(action==='remove'?{}:{action})});
    setStatus(result.message);setFailed(result.outcome==='failed');setTick(value=>value+1);
    if(!mounted.current)props.onFeedback({level:result.outcome==='failed'?'error':'info',message:result.message});
  }catch(error){setStatus(message(error));setFailed(true);if(!mounted.current)props.onFeedback({level:'error',message:message(error)});}finally{setBusy(false);}};
  const examples=[
    {title:'Buyer follow-ups',description:'Draft daily follow-ups for pending sample and lab dip approvals.',when:'Every day at 09:00',instruction:'Create a daily scheduled task at 09:00. Review available workspace files and draft buyer follow-ups for pending sample and lab dip approvals. Do not send messages.'},
    {title:'Weekly shipment report',description:'Summarize shipment dates, open orders, and delivery risks.',when:'Every Monday at 09:30',instruction:'Create a weekly scheduled task every Monday at 09:30 to review available order files and prepare a shipment status report, including delivery risks and missing information. Save a downloadable report. Do not invent order data.'},
    {title:'Weekly work summary',description:'Prepare a short summary and a checklist for the coming week.',when:'Every Friday at 18:00',instruction:'Create a weekly scheduled task every Friday at 18:00 to summarize available workspace work and prepare the coming week checklist. Ask for missing sources rather than inventing facts.'}
  ];
  return <section class="user-workspace-page user-scheduled" aria-label="Scheduled tasks"><header><div><h1>Scheduled</h1><p>Ask your assistant to schedule work. Manage it here.</p></div><button type="button" disabled={!props.connected} onClick={()=>props.onPrompt(`Please create a scheduled task. My time zone is ${zone}. Ask me what to do and when.`)}>Create with AI</button></header>
    {status?<p role={failed?'alert':'status'}>{status}</p>:null}
    <div class="user-page-actions"><h2>Your schedules</h2><button type="button" disabled={loading||busy||!props.connected} onClick={()=>{setStatus('Refreshing schedules...');setFailed(false);setTick(value=>value+1);}}>Refresh schedules</button></div>
    {loading&&!tasks.length?<p role="status">Loading schedules...</p>:!tasks.length?<p>{failed?'Refresh to load your scheduled tasks.':'No scheduled tasks yet.'}</p>:<ul class="user-schedule-list">{tasks.map(task=><li key={task.id}><h2>{task.title}</h2><p>{task.prompt}</p><small>{task.enabled?`Next: ${new Date(task.nextRunAt).toLocaleString(undefined,{timeZone:task.timeZone})} (${task.timeZone})`:task.frequency==='once'&&task.lastSessionId?'Completed':'Paused'} | {task.frequency} | {task.model}</small>{task.lastError?<p class="user-page-error">{task.lastError}</p>:null}<div class="user-page-actions"><button type="button" disabled={busy||!props.connected} onClick={()=>void mutate(task,'run')}>Run now</button><button type="button" disabled={busy||!props.connected} onClick={()=>props.onPrompt(`Please update scheduled task "${task.title}" (ID: ${task.id}). List my schedules first and ask what I want to change. Keep its selected model unless I explicitly choose another.`,task.projectPath)}>Edit with AI</button><button type="button" disabled={busy||!props.connected} onClick={()=>void mutate(task,task.enabled?'pause':'resume')}>{task.enabled?'Pause':'Resume'}</button>{task.lastSessionId?<button type="button" onClick={()=>props.onOpen(task)}>View conversation</button>:null}<button type="button" disabled={busy||!props.connected} onClick={()=>{if(window.confirm('Remove this schedule? Conversations and files will be kept.'))void mutate(task,'remove');else{setStatus('Schedule removal cancelled.');setFailed(false);}}}>Remove</button></div></li>)}</ul>}
    <h2>Start with an idea</h2><div class="user-schedule-examples">{examples.map(example=><button type="button" key={example.title} disabled={!props.connected} onClick={()=>props.onPrompt(`${example.instruction} Time zone: ${zone}. Use the model I select for this conversation.`)}><strong>{example.title}</strong><span>{example.description}</span><small>{example.when}</small></button>)}</div>
  </section>;
}
