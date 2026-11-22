import {useState} from 'preact/hooks';
import {ModalShell} from './primitives';
import {DEFAULT_OFFICE_PRESENTATION,OFFICE_MODE_KEYS,validateOfficePresentation,type OfficePresentation} from '../../src/domain/officePresentation';
import type {OfficeSkill} from '../../src/domain/officeSkills';
import {request} from './teamSettingsRequest';

export function WorkspacePresentationSetting(props:{value:OfficePresentation;disabled?:boolean;onSaved:(value:OfficePresentation)=>void}){
  const [draft,setDraft]=useState(props.value),[open,setOpen]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [card,setCard]=useState<OfficeSkill>(),[originalId,setOriginalId]=useState<string>(),[remove,setRemove]=useState<string>();
  const patch=(value:Partial<OfficePresentation>)=>setDraft(current=>({...current,...value}));
  const close=()=>{if(!pending){setOpen(false);setError('');setNotice('Presentation changes cancelled.');}};
  const save=async()=>{
    if(pending)return;
    setError('');
    try{const presentation=validateOfficePresentation(draft);setPending(true);const result=await request<{presentation:OfficePresentation}>('/api/office/settings','PUT',{presentation,expectedPresentation:props.value});props.onSaved(result.presentation);setOpen(false);setNotice('Workspace presentation saved.');}
    catch(error){setError(error instanceof Error?error.message:'Presentation could not be saved. Review and retry.');}
    finally{setPending(false);}
  };
  return <section class="workspace-presentation-setting"><div class="user-memory-heading"><div><strong>Workspace presentation</strong><small>{props.value.assistantName}</small></div><button type="button" disabled={props.disabled} onClick={()=>{setDraft(structuredClone(props.value));setError('');setNotice('');setOpen(true);}}>Edit presentation</button></div>{notice?<small role="status">{notice}</small>:null}
    <ModalShell open={open&&!card&&!remove} title="Workspace presentation" closeLabel="Close workspace presentation" className="dashboard-modal-wide" closeDisabled={pending} onClose={close}>
      <form class="team-settings-form presentation-editor" onSubmit={event=>{event.preventDefault();void save();}}>
        <label>Assistant name<input value={draft.assistantName} maxLength={80} disabled={pending} onInput={event=>patch({assistantName:event.currentTarget.value})}/></label>
        <label>Welcome title<input value={draft.welcomeTitle} maxLength={160} disabled={pending} onInput={event=>patch({welcomeTitle:event.currentTarget.value})}/></label>
        <label>Welcome subtitle<input value={draft.welcomeSubtitle} maxLength={320} disabled={pending} onInput={event=>patch({welcomeSubtitle:event.currentTarget.value})}/></label>
        <label>Message placeholder<input value={draft.composerPlaceholder} maxLength={120} disabled={pending} onInput={event=>patch({composerPlaceholder:event.currentTarget.value})}/></label>
        <label>Identity instructions<textarea rows={5} value={draft.identityPrompt} maxLength={8000} disabled={pending} onInput={event=>patch({identityPrompt:event.currentTarget.value})}/><small>Controls how the assistant introduces itself. Tool permissions and truthful action feedback remain enforced.</small></label>
        <fieldset><legend>Mode labels</legend><div class="presentation-label-grid">{OFFICE_MODE_KEYS.map(key=><label key={key}>{key}<input aria-label={`${key} mode label`} maxLength={40} value={draft.profileLabels[key]} disabled={pending} onInput={event=>patch({profileLabels:{...draft.profileLabels,[key]:event.currentTarget.value}})}/></label>)}</div></fieldset>
        <fieldset><legend>Thinking labels</legend><div class="presentation-label-grid">{Object.keys(DEFAULT_OFFICE_PRESENTATION.thinkingLabels).map(key=><label key={key}>{key}<input aria-label={`${key} thinking label`} maxLength={40} value={draft.thinkingLabels[key]} disabled={pending} onInput={event=>patch({thinkingLabels:{...draft.thinkingLabels,[key]:event.currentTarget.value}})}/></label>)}</div></fieldset>
        <label class="team-presentation-setting"><input type="checkbox" checked={draft.contextualCards} disabled={pending} onChange={event=>patch({contextualCards:event.currentTarget.checked})}/> Contextual cards<small>New users see no cards. Suggestions appear only after relevant conversation, using tags saved for that user.</small></label>
        <label class="team-presentation-setting"><input type="checkbox" checked={draft.dictationEnabled} disabled={pending} onChange={event=>patch({dictationEnabled:event.currentTarget.checked})}/> Voice dictation</label>
        <label>Default dictation language<input value={draft.dictationLanguage} maxLength={40} disabled={pending} placeholder="auto" onInput={event=>patch({dictationLanguage:event.currentTarget.value})}/><small>Use auto for the device language, or a language tag such as en-US or bn-BD.</small></label>
        <fieldset><legend>Skills and cards</legend><div class="presentation-card-list">{draft.catalog.map(item=><div key={item.id}><span><strong>{item.label}</strong><small>{item.description}</small></span><button type="button" disabled={pending} onClick={()=>{setCard({...item});setOriginalId(item.id);setError('');}}>Edit <span class="sr-only">{item.label}</span></button><button type="button" disabled={pending} onClick={()=>{setRemove(item.id);setError('');}}>Remove <span class="sr-only">{item.label}</span></button></div>)}</div><button type="button" disabled={pending||draft.catalog.length>=24} onClick={()=>{setCard({id:'',label:'',description:'',starter:'',prompt:''});setOriginalId(undefined);setError('');}}>Add card</button></fieldset>
        {error?<p role="alert">{error}</p>:null}<div class="workspace-dialog-footer"><button type="button" disabled={pending} onClick={close}>Cancel</button><button type="submit" disabled={pending}>{pending?'Saving?':'Save presentation'}</button></div>
      </form>
    </ModalShell>
    <ModalShell open={!!card} title={originalId?'Edit card':'Add card'} closeLabel="Close card editor" className="dashboard-modal-compact" onClose={()=>{setCard(undefined);setError('');}}>
      {card?<form class="team-settings-form" onSubmit={event=>{event.preventDefault();try{const catalog=[...draft.catalog.filter(item=>item.id!==originalId),card];validateOfficePresentation({...draft,catalog});patch({catalog});setCard(undefined);setError('');}catch(error){setError(error instanceof Error?error.message:'Review the card.');}}}>
        <label>Card ID<input value={card.id} maxLength={64} disabled={!!originalId} onInput={event=>setCard({...card,id:event.currentTarget.value})}/></label>
        <label>Title<input value={card.label} maxLength={80} onInput={event=>setCard({...card,label:event.currentTarget.value})}/></label>
        <label>Description<input value={card.description} maxLength={240} onInput={event=>setCard({...card,description:event.currentTarget.value})}/></label>
        <label>Starting message<textarea rows={3} value={card.starter} maxLength={2000} onInput={event=>setCard({...card,starter:event.currentTarget.value})}/></label>
        <label>Skill instructions<textarea rows={4} value={card.prompt} maxLength={2000} onInput={event=>setCard({...card,prompt:event.currentTarget.value})}/></label>
        {error?<p role="alert">{error}</p>:null}<div class="workspace-dialog-footer"><button type="button" onClick={()=>{setCard(undefined);setError('');}}>Cancel</button><button type="submit">Use card</button></div>
      </form>:null}
    </ModalShell>
    <ModalShell open={!!remove} title="Remove card?" closeLabel="Cancel card removal" className="dashboard-modal-compact" onClose={()=>setRemove(undefined)}><p>This removes the card and its skill instructions from the workspace catalog when you save presentation.</p><div class="workspace-dialog-footer"><button type="button" onClick={()=>setRemove(undefined)}>Cancel</button><button type="button" onClick={()=>{patch({catalog:draft.catalog.filter(item=>item.id!==remove)});setRemove(undefined);}}>Remove card</button></div></ModalShell>
  </section>;
}
