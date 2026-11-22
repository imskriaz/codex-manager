import {beforeEach,expect,it,vi} from 'vitest';
import {fetch} from 'undici';
import {smartOfficeMcpRpc,SMARTOFFICE_ENDPOINT} from '../src/services/smartOfficeMcp';

vi.mock('undici',()=>({fetch:vi.fn()}));
const signal = new AbortController().signal;
beforeEach(()=>vi.mocked(fetch).mockReset());
const respond = (value:unknown,status=200)=>vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify(value),{status}) as never);

it('exposes only schema discovery and validated read-only queries',async()=>{
  const listing=await smartOfficeMcpRpc('tools/list',undefined,signal) as {tools:Array<{name:string;annotations:{readOnlyHint:boolean}}>};
  expect(listing.tools.map(tool=>tool.name)).toEqual(['smartoffice_schema','smartoffice_query']);
  expect(listing.tools.every(tool=>tool.annotations.readOnlyHint)).toBe(true);
  await expect(smartOfficeMcpRpc('tools/call',{name:'delete_user'},signal)).rejects.toThrow('read-only');
  await expect(smartOfficeMcpRpc('tools/call',{name:'smartoffice_query',arguments:{plan:'DELETE FROM users'}},signal)).rejects.toThrow('query plan');
  expect(fetch).not.toHaveBeenCalled();
});
it('reads schema and forwards one plan only to the fixed local read-only API',async()=>{
  respond({ok:true,schema:{entities:[]}});
  expect(await smartOfficeMcpRpc('tools/call',{name:'smartoffice_schema'},signal)).toMatchObject({content:[{type:'text',text:expect.stringContaining('entities')}]});
  expect(fetch).toHaveBeenLastCalledWith(SMARTOFFICE_ENDPOINT+'/api/query/schema',expect.objectContaining({method:'GET',redirect:'error',signal}));
  const plan={op:'aggregate',entity:'purchase_orders',metric:'count',limit:1};
  respond({ok:true,result:{count:3}});
  await smartOfficeMcpRpc('tools/call',{name:'smartoffice_query',arguments:{plan,url:'http://other-host/admin'}},signal);
  const url=new URL(vi.mocked(fetch).mock.calls.at(-1)![0] as string);
  expect(url.origin).toBe(SMARTOFFICE_ENDPOINT);expect(url.pathname).toBe('/api/query');expect(url.searchParams.get('op')).toBe('aggregate');
  expect(fetch).toHaveBeenLastCalledWith(url.href,expect.objectContaining({method:'GET',redirect:'error'}));
});
it('reports unavailable, denied, invalid, failed and oversized responses without exposing internal errors',async()=>{
  const call=()=>smartOfficeMcpRpc('tools/call',{name:'smartoffice_schema'},signal);
  vi.mocked(fetch).mockRejectedValue(new Error('private service details')); await expect(call()).rejects.toThrow('SmartOffice is unavailable');
  respond({error:'private service details'},403); await expect(call()).rejects.toThrow('denied data access');
  vi.mocked(fetch).mockResolvedValue(new Response('<html>Sign in</html>') as never); await expect(call()).rejects.toThrow('valid data');
  respond({ok:false,error:'private service details'}); await expect(call()).rejects.toThrow('Check the current schema');
  respond({ok:false,error:'Query aggregate requires groupBy.'},400);await expect(call()).rejects.toThrow('Query aggregate requires groupBy.');
  respond({ok:true,data:'x'.repeat(1048576)}); await expect(call()).rejects.toThrow('smaller result');
});
it('does not call the service after cancellation',async()=>{
  const controller=new AbortController(); controller.abort(new Error('Cancelled'));
  await expect(smartOfficeMcpRpc('tools/call',{name:'smartoffice_schema'},controller.signal)).rejects.toThrow('Cancelled');
  expect(fetch).not.toHaveBeenCalled();
});
it('discovers sources and retrieves complete entity metadata without silently truncating schema or data',async()=>{
  const entities=[{entity:'orders',fields:[{name:'po',type:'text'}]},{entity:'flow',fields:[{name:'quantity',type:'number'}]}];
  respond({ok:true,schema:{version:'current',syntax:{op:'read'},entities}});
  const catalogue=await smartOfficeMcpRpc('tools/call',{name:'smartoffice_schema'},signal);
  expect(JSON.stringify(catalogue)).toContain('orders');expect(JSON.stringify(catalogue)).not.toContain('quantity');
  const selected=await smartOfficeMcpRpc('tools/call',{name:'smartoffice_schema',arguments:{entity:'flow'}},signal);
  expect(JSON.stringify(selected)).toContain('quantity');expect(JSON.stringify(selected)).not.toContain('orders');
  await expect(smartOfficeMcpRpc('tools/call',{name:'smartoffice_schema',arguments:{entity:'invented'}},signal)).rejects.toThrow('source catalogue');
  respond({ok:true,result:'x'.repeat(96000)});
  await expect(smartOfficeMcpRpc('tools/call',{name:'smartoffice_query',arguments:{plan:{op:'read',entity:'orders'}}},signal)).rejects.toThrow('too much data for chat');
});
