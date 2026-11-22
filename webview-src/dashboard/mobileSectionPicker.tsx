import type {ComponentChildren} from 'preact';

export function MobileSectionPicker<T extends string>(props:{label:string;value:T;options:ReadonlyArray<{value:T;label:string}>;onChange:(value:T)=>void;disabled?:boolean;children?:ComponentChildren}) {
  return <div class="mobile-section-picker"><label><span class="sr-only">{props.label}</span><select aria-label={props.label} value={props.value} disabled={props.disabled} onChange={event=>props.onChange(event.currentTarget.value as T)}>{props.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>{props.children}</div>;
}
