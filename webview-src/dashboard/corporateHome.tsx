import type {PublicOfficePresentation} from '../../src/domain/officePresentation';
export function CorporateHome(props:{cards:PublicOfficePresentation['catalog'];skills:string[];onChoose:(text:string)=>void}) {
  const cards=props.skills.flatMap(id=>props.cards.find(card=>card.id===id)??[]).slice(0,6);
  if(!cards.length)return null;
  return <div class="corporate-home-grid" aria-label="Suggested work">{cards.map(card=><button type="button" class="corporate-home-card" key={card.id} onClick={()=>props.onChoose(card.starter)}><strong>{card.label}</strong>{card.description?<small>{card.description}</small>:null}</button>)}</div>;
}
