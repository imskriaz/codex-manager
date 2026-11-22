import {useEffect,useRef,useState} from 'preact/hooks';
import {ModalShell} from './primitives';

type Recognition={lang:string;continuous:boolean;interimResults:boolean;onresult:((event:{resultIndex:number;results:ArrayLike<{isFinal:boolean;0:{transcript:string}}>})=>void)|null;onerror:((event:{error:string})=>void)|null;onend:(()=>void)|null;start:()=>void;stop:()=>void;abort:()=>void};
type SpeechWindow=Window&{SpeechRecognition?:new()=>Recognition;webkitSpeechRecognition?:new()=>Recognition};
export function VoiceDictation(props:{disabled?:boolean;language?:string;scope?:string;onText:(value:string)=>boolean}){
  const [open,setOpen]=useState(false),[active,setActive]=useState(false),[text,setText]=useState(''),[interim,setInterim]=useState(''),[notice,setNotice]=useState(''),[language,setLanguage]=useState(props.language&&props.language!=='auto'?props.language:navigator.language||'en-US');
  const engine=useRef<Recognition>(),timer=useRef<ReturnType<typeof setTimeout>>(),opening=useRef(false);
  const release=()=>{clearTimeout(timer.current);const current=engine.current;engine.current=undefined;if(current){current.onresult=null;current.onerror=null;current.onend=null;current.abort();}};
  useEffect(()=>()=>release(),[]);
  useEffect(()=>{release();opening.current=false;setActive(false);setOpen(false);setText('');setInterim('');setNotice('');},[props.scope]);
  const stop=()=>{if(engine.current){setNotice('Finishing dictation…');engine.current.stop();clearTimeout(timer.current);timer.current=setTimeout(()=>{release();setActive(false);setInterim('');setNotice('Dictation stopped. Review the captured text.');},3000);}};
  const close=()=>{release();opening.current=false;setActive(false);setOpen(false);setText('');setInterim('');setNotice('Dictation cancelled.');};
  const start=()=>{
    if(engine.current||opening.current)return;
    const ctor=(window as SpeechWindow).SpeechRecognition??(window as SpeechWindow).webkitSpeechRecognition;
    if(!ctor||!window.isSecureContext){setNotice('Dictation is unavailable in this browser. Use your keyboard microphone or system dictation, then review the message.');return;}
    opening.current=true;
    try{
      const current=new ctor();engine.current=current;current.lang=language;current.continuous=true;current.interimResults=true;
      current.onresult=event=>{let final='',partial='';for(let index=event.resultIndex;index<event.results.length;index++){const result=event.results[index]!;if(result.isFinal)final+=result[0].transcript+' ';else partial+=result[0].transcript;}if(final)setText(value=>(value+(value?' ':'')+final.trim()).slice(0,64000));setInterim(partial);};
      current.onerror=event=>{setNotice(({ 'not-allowed':'Microphone access was denied. Allow it in your browser or use keyboard dictation.', 'audio-capture':'No microphone is available. Check your device input.', 'no-speech':'No speech was detected. Try again when ready.',network:'The browser speech service is unavailable. Your captured text is kept.'} as Record<string,string>)[event.error]??'Dictation could not continue. Your captured text is kept.');release();opening.current=false;setActive(false);setInterim('');};
      current.onend=()=>{release();opening.current=false;setActive(false);setInterim('');setNotice('Dictation stopped. Review the captured text.');};
      current.start();setActive(true);setNotice('Listening…');opening.current=false;timer.current=setTimeout(stop,90000);
    }catch{release();opening.current=false;setActive(false);setNotice('Dictation could not start. Use your keyboard microphone or try again.');}
  };
  return <><button type="button" class="cli-attach-button" disabled={props.disabled} aria-label="Dictate message" title="Dictate message" onClick={()=>{setOpen(true);setText('');setNotice('');}}><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3m-4 0h8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    <ModalShell open={open} title="Dictate message" closeLabel="Close dictation" className="dashboard-modal-compact" onClose={close}>
      <div class="voice-dictation"><label>Language<select disabled={active} value={language} onChange={event=>setLanguage(event.currentTarget.value)}>{!['en-US','en-GB','bn-BD','hi-IN'].includes(language)?<option value={language}>{language}</option>:null}<option value="en-US">English (US)</option><option value="en-GB">English (UK)</option><option value="bn-BD">বাংলা (বাংলাদেশ)</option><option value="hi-IN">हिन्दी</option></select></label>
        <small>Your browser handles speech recognition and may use its speech service. Review the text before sending.</small>
        <label>Captured text<textarea rows={6} maxLength={64000} value={text} onInput={event=>setText(event.currentTarget.value)}/></label>{interim?<p class="voice-interim">{interim}</p>:null}{notice?<p role="status">{notice}</p>:null}
        <div class="workspace-dialog-footer"><button type="button" onClick={close}>Cancel</button><button type="button" onClick={active?stop:start}>{active?'Stop dictation':'Start dictation'}</button><button type="button" disabled={active||!text.trim()} onClick={()=>{if(!props.onText(text.trim())){setNotice('The message is too long. Shorten the captured text or the existing draft.');return;}release();setOpen(false);setText('');setNotice('Dictation added. Review and send your message.');}}>Use text</button></div>
      </div>
    </ModalShell>{!open&&notice?<span class="sr-only" role="status">{notice}</span>:null}</>;
}
