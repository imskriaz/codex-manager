import type {DashboardCliModelOption} from './dashboard/types';

// Verified against https://learn.chatgpt.com/docs/models on 2026-11-22.
// This is an offline catalog, not confirmation of an account's model access.
const definitions = [
  ['gpt-6.2-sol','GPT-6.2 Sol','Everyday coding, writing and multistep work.'],
  ['gpt-6.2-astra','GPT-6.2 Astra','Demanding projects across code, applications and research.'],
  ['gpt-6.1-terra','GPT-6.1 Terra','Writing, visual understanding and computer use.'],
  ['gpt-6.1-sol','GPT-6.1 Sol','Complex work across code, applications and documents.'],
  ['gpt-6-astra','GPT-6 Astra','Complex reasoning and projects.'],
  ['gpt-6-sol','GPT-6 Sol','Coding and agentic work.'],
  ['gpt-6-luna','GPT-6 Luna','Focused, repeatable work and extraction.']
] as const;
export function codexFallbackModels(saved:readonly DashboardCliModelOption[],hidden:readonly string[]=[]):DashboardCliModelOption[]{
  const excluded=new Set(hidden),known=new Set(saved.map(model=>model.id));
  return [...saved,...definitions.filter(([id])=>!excluded.has(id)&&!known.has(id)).map(([id,label,description])=>({id,label,description:description+' Offline catalog; account availability is unverified.',defaultReasoningEffort:id==='gpt-6-luna'?'high':'medium',reasoningEfforts:['low','medium','high','xhigh','max',...(id==='gpt-6-luna'?[]:['ultra'])]}))];
}
