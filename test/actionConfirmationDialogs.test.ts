import {beforeEach,expect,it,vi} from 'vitest';
import type {VNode} from 'preact';
const fixture=vi.hoisted(()=>({slots:[] as any[],cursor:0}));
vi.mock('preact/hooks',()=>({
 useState(initial:unknown){const i=fixture.cursor++;fixture.slots[i]??={value:typeof initial==='function'?(initial as ()=>unknown)():initial};return[fixture.slots[i].value,(next:any)=>{fixture.slots[i].value=typeof next==='function'?next(fixture.slots[i].value):next;}];},
 useRef(initial:unknown){const i=fixture.cursor++;return fixture.slots[i]??={current:initial};},useEffect(){fixture.cursor++;},useLayoutEffect(){fixture.cursor++;}
}));
import {ShareAccessReview} from '../webview-src/dashboard/shareControls';
import {TagManagerModal} from '../webview-src/dashboard/accountModals';
function nodes(value:unknown):VNode<any>[]{if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props' in value))return[];const node=value as VNode<any>;return[node,...(node.props.open===false?[]:nodes(node.props.children))];}
function text(value:unknown):string{if(Array.isArray(value))return value.map(text).join('');if(typeof value==='string')return value;return value&&typeof value==='object'&&'props'in value?text((value as VNode<any>).props.children):'';}
beforeEach(()=>{fixture.slots=[];fixture.cursor=0;});
it('keeps revocation failures in a separate dialog and blocks duplicate confirms until completion',async()=>{
 let finish!:(value:boolean)=>void;const confirm=vi.fn(()=>new Promise<boolean>(resolve=>finish=resolve));
 const render=()=>{fixture.cursor=0;return nodes(ShareAccessReview({description:'Existing links',label:'Revoke links',busy:false,onConfirm:confirm}));};
 const button=(label:string)=>render().find(node=>node.type==='button'&&text(node.props.children)===label)!;
 button('Revoke links').props.onClick();expect(confirm).not.toHaveBeenCalled();expect(render().some(node=>node.props.title==='Revoke link access?'&&node.props.open)).toBe(true);
 const first=button('Revoke access').props.onClick();await button('Please wait...').props.onClick();expect(confirm).toHaveBeenCalledOnce();expect(render().find(node=>node.props.title==='Revoke link access?')?.props.closeDisabled).toBe(true);
 finish(false);await first;expect(render().some(node=>node.props.role==='alert')).toBe(true);expect(render().find(node=>node.props.title==='Revoke link access?')?.props.open).toBe(true);
 button('Cancel').props.onClick();expect(render().find(node=>node.props.title==='Revoke link access?')?.props.open).toBe(false);
 button('Revoke links').props.onClick();const second=button('Revoke access').props.onClick();finish(true);await second;expect(render().find(node=>node.props.title==='Revoke link access?')?.props.open).toBe(false);
});
it('separates tag actions from the list and keeps filtering and group membership through cancellation',()=>{
 const action=vi.fn(()=> 'request'),props={accounts:[{id:'one',tags:['Work'],enabled:true}] as any,connected:true,results:[],onClose:vi.fn(),onFilter:vi.fn(),onAction:action};
 const render=()=>{fixture.cursor=0;return nodes(TagManagerModal(props));};
 const find=(label:string)=>render().find(node=>node.props['aria-label']===label)!;
 const search=find('Find tags');(search.props.onInput??search.props.oninput)({currentTarget:{value:'Work'}});
 find('Remove tag Work').props.onClick();expect(action).not.toHaveBeenCalled();let confirmation=render().find(node=>node.props.title==='Remove tag?')!;expect(confirmation.props.open).toBe(true);expect(nodes(confirmation).some(node=>node.type==='form')).toBe(true);
 nodes(confirmation).find(node=>node.type==='button'&&text(node.props.children)==='Cancel')!.props.onClick();expect(find('Find tags').props.value).toBe('Work');expect(action).not.toHaveBeenCalled();
 find('Remove tag Work').props.onClick();confirmation=render().find(node=>node.props.title==='Remove tag?')!;nodes(confirmation).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}});expect(action).toHaveBeenCalledExactlyOnceWith('Work','remove',['one'],'');
});
