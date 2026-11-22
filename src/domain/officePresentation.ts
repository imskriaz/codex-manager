import {OFFICE_SKILLS,type OfficeSkill} from './officeSkills';
import {OFFICE_THINKING} from './officeModels';

export const OFFICE_MODE_KEYS = ['auto','regular','professional','expert'] as const;
export type OfficeModeKey = typeof OFFICE_MODE_KEYS[number];
export type OfficePresentation = {
  assistantName:string; welcomeTitle:string; welcomeSubtitle:string; composerPlaceholder:string; identityPrompt:string;
  profileLabels:Record<OfficeModeKey,string>; thinkingLabels:Record<string,string>; contextualCards:boolean; catalog:OfficeSkill[];
  dictationEnabled:boolean; dictationLanguage:string;
};
export const DEFAULT_OFFICE_PRESENTATION:OfficePresentation = {
  assistantName:'Smart AI',welcomeTitle:'How can I help?',welcomeSubtitle:'',composerPlaceholder:'Message…',
  identityPrompt:'Present yourself as Smart AI, a helpful workplace assistant. If asked who you are, explain your role as a smart AI assistant. Keep workspace replies generic and avoid internal product, provider, model or system details. Be truthful about available capabilities and completed actions.',
  profileLabels:{auto:'Auto',regular:'Regular',professional:'Professional',expert:'Expert'},
  thinkingLabels:{none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Maximum',ultra:'Ultra',auto:'Auto'},
  contextualCards:true,catalog:OFFICE_SKILLS.map(skill=>({...skill})),dictationEnabled:true,dictationLanguage:'auto'
};
export function validateOfficePresentation(value:unknown):OfficePresentation {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Choose valid workspace presentation settings.');
  const input=value as Record<string,unknown>;
  const text=(raw:unknown,label:string,limit:number,empty=false)=>{if(typeof raw!=='string'||raw.length>limit||(!empty&&!raw.trim())||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw))throw new Error(`Enter ${label} using up to ${limit.toLocaleString()} characters.`);return raw;};
  const labels=(raw:unknown,keys:readonly string[])=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Choose valid mode and thinking labels.');return Object.fromEntries(keys.map(key=>[key,text((raw as Record<string,unknown>)[key],`${key} label`,40)]));};
  if(typeof input['contextualCards']!=='boolean'||!Array.isArray(input['catalog'])||input['catalog'].length>24)throw new Error('Choose up to 24 configured workspace cards.');
  const seen=new Set<string>();
  const catalog=input['catalog'].map((value:unknown)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Choose valid workspace cards.');const card=value as Record<string,unknown>,id=card['id'];
    if(typeof id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(id)||seen.has(id))throw new Error('Give every card a unique lowercase ID.');seen.add(id);
    return {id,label:text(card['label'],'a card title',80),description:text(card['description'],'a card description',240,true),starter:text(card['starter'],'a starting message',2000),prompt:text(card['prompt'],'skill instructions',2000,true)};
  });
  const dictationEnabled=input['dictationEnabled']??true,dictationLanguage=input['dictationLanguage']??'auto';
  if(typeof dictationEnabled!=='boolean'||typeof dictationLanguage!=='string'||!(/^(auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/i.test(dictationLanguage))||dictationLanguage.length>40)throw new Error('Choose a valid dictation language.');
  return {assistantName:text(input['assistantName'],'an assistant name',80),welcomeTitle:text(input['welcomeTitle'],'a welcome title',160),welcomeSubtitle:text(input['welcomeSubtitle'],'a welcome subtitle',320,true),composerPlaceholder:text(input['composerPlaceholder'],'a message placeholder',120),identityPrompt:text(input['identityPrompt'],'identity instructions',8000,true),profileLabels:labels(input['profileLabels'],OFFICE_MODE_KEYS) as OfficePresentation['profileLabels'],thinkingLabels:labels(input['thinkingLabels'],['auto',...OFFICE_THINKING]),contextualCards:input['contextualCards'],catalog,dictationEnabled,dictationLanguage};
}
export type PublicOfficePresentation=Omit<OfficePresentation,'identityPrompt'|'catalog'>&{catalog:Array<Omit<OfficeSkill,'prompt'>>};
export function publicOfficePresentation(value:OfficePresentation):PublicOfficePresentation {
  const {identityPrompt:_identity,catalog,...publicFields}=value;
  return {...publicFields,catalog:catalog.map(({prompt:_prompt,...card})=>card)};
}
