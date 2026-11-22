import {expect,it,vi} from 'vitest';
import {DEFAULT_OFFICE_PRESENTATION,validateOfficePresentation,publicOfficePresentation} from '../src/domain/officePresentation';
import {readOfficeRecommendations,saveOfficeRecommendations} from '../src/services/officeRecommendations';
const state=vi.hoisted(()=>new Map<string,unknown>());
vi.mock('../src/storage/sqliteState',()=>({getSqliteStateStore:()=>({get:(ns:string,id:string)=>state.get(ns+':'+id),set:(ns:string,id:string,value:unknown)=>state.set(ns+':'+id,value),transaction:(run:()=>unknown)=>run()})}));
it('validates custom identity, labels and card catalog without exposing server instructions',()=>{
 const value=validateOfficePresentation({...structuredClone(DEFAULT_OFFICE_PRESENTATION),assistantName:'Office aide',profileLabels:{auto:'Automatic',regular:'Everyday',professional:'Business',expert:'Specialist'},catalog:[{id:'buyer-reports',label:'Buyer reports',description:'Summarize the week',starter:'Draft our buyer report.',prompt:'Check owners and dates.'}]});
 expect(value.profileLabels.expert).toBe('Specialist');expect(value.catalog[0].id).toBe('buyer-reports');const publicValue=publicOfficePresentation(value);expect(publicValue).not.toHaveProperty('identityPrompt');expect(publicValue.catalog[0]).not.toHaveProperty('prompt');
 for(const invalid of [{...value,profileLabels:{}},{...value,catalog:[value.catalog[0],value.catalog[0]]},{...value,catalog:[{...value.catalog[0],id:'../admin'}]}])expect(()=>validateOfficePresentation(invalid)).toThrow();
});
it('keeps new users card-free and stores only permitted LLM tags for each user',()=>{
 state.clear();const presentation=structuredClone(DEFAULT_OFFICE_PRESENTATION);
 expect(readOfficeRecommendations('alex',presentation)).toEqual([]);saveOfficeRecommendations('alex',['document-drafting','project-planning'],presentation);expect(readOfficeRecommendations('alex',presentation)).toEqual(['document-drafting','project-planning']);expect(readOfficeRecommendations('sam',presentation)).toEqual([]);
 expect(()=>saveOfficeRecommendations('alex',['terminal'],presentation)).toThrow('configured');expect(readOfficeRecommendations('alex',{...presentation,contextualCards:false})).toEqual([]);expect(readOfficeRecommendations('alex',{...presentation,catalog:[]})).toEqual([]);
});
