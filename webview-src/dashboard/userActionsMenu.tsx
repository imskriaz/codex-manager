import {useEffect,useRef,useState} from 'preact/hooks';
import {createPortal} from 'preact/compat';
import {useAnchoredPopover} from './anchoredPopover';
export function UserActionsMenu({label,disabled,items}:{label:string;disabled?:boolean;items:Array<{label:string;run:()=>void;disabled?:boolean}>}){
 const [open,setOpen]=useState(false),anchor=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 useAnchoredPopover(open,anchor,panel);
 useEffect(()=>{if(!open)return;panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  const close=(event:PointerEvent)=>{if(!anchor.current?.contains(event.target as Node)&&!panel.current?.contains(event.target as Node))setOpen(false);};
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);anchor.current?.focus();}else if(['ArrowDown','ArrowUp','Home','End','Tab'].includes(event.key)){
   if(event.key==='Tab'){setOpen(false);return;}event.preventDefault();const buttons=[...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[])],index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();
  }};document.addEventListener('pointerdown',close);document.addEventListener('keydown',key,true);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',key,true);};
 },[open]);
 useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
 return <><button ref={anchor} type="button" class="user-page-icon" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={()=>setOpen(value=>!value)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button>{open?createPortal(<div ref={panel} class="user-actions-menu" role="menu" aria-label={label}>{items.map(item=><button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={()=>{setOpen(false);anchor.current?.focus();item.run();}}>{item.label}</button>)}</div>,document.body):null}</>;
}
