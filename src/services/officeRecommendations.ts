import {getSqliteStateStore} from '../storage/sqliteState';
import type {OfficePresentation} from '../domain/officePresentation';

type Recommendation={id:string;updatedAt:number};
export function readOfficeRecommendations(owner:string,presentation:OfficePresentation):string[]{
  if(!presentation.contextualCards)return [];
  const allowed=new Set(presentation.catalog.map(card=>card.id));
  const saved=getSqliteStateStore()?.get<unknown>('office-recommendations',owner),seen=new Set<string>();
  const items:unknown[]=Array.isArray(saved)?saved:[];
  return items.filter((item):item is Recommendation=>!!item&&typeof item==='object'&&'id' in item&&typeof item.id==='string'&&'updatedAt' in item&&typeof item.updatedAt==='number'&&Number.isFinite(item.updatedAt)&&allowed.has(item.id)).sort((a,b)=>b.updatedAt-a.updatedAt).filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;}).slice(0,6).map(item=>item.id);
}
export function saveOfficeRecommendations(owner:string,input:unknown,presentation:OfficePresentation):string[]{
  const allowed=new Set(presentation.catalog.map(card=>card.id));
  if(!presentation.contextualCards||!Array.isArray(input)||!input.length||input.length>3||input.some(id=>typeof id!=='string'||!allowed.has(id)))throw new Error('Choose up to three configured workspace tags.');
  const store=getSqliteStateStore();if(!store)throw new Error('Workspace preferences are unavailable.');
  const selected=[...new Set(input as string[])];
  store.transaction(()=>{const previous=readOfficeRecommendations(owner,presentation).filter(id=>!selected.includes(id));store.set('office-recommendations',owner,[...selected,...previous].slice(0,6).map((id,index)=>({id,updatedAt:Date.now()-index})));});
  return selected;
}
