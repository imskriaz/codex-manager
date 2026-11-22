import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as http from 'node:http';
import {once} from 'node:events';
import * as users from '../src/services/officeUsers';
import * as smartoffice from '../src/services/smartOfficeMcp';
import {isPublicOfficeAddress,readOfficeWebPage,listOfficeConnections,readOfficeConnection} from '../src/services/officeSources';
let server:http.Server,endpoint:string,calls:string[];const user={id:'alex',role:'user',enabled:true,mcpServers:['orders']} as users.OfficeUser;
beforeEach(async()=>{calls=[];vi.spyOn(users,'getOfficeUser').mockResolvedValue(user);server=http.createServer(async(req,res)=>{
 if(req.method==='DELETE'){res.end();return;}let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);calls.push(body.method);res.setHeader('Content-Type','application/json');
 if(body.method==='initialize'){res.setHeader('Mcp-Session-Id','private-session');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}}));}
 else if(body.method==='notifications/initialized'){res.statusCode=202;res.end();}
 else if(body.method==='tools/list')res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{tools:[{name:'read_orders',description:'Read orders',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'send_email',annotations:{readOnlyHint:false}}]}}));
 else if(body.method==='tools/call'){expect(req.headers['mcp-session-id']).toBe('private-session');res.setHeader('Content-Type','text/event-stream');res.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:'Order ST100: 2400 pieces'}]}})+'\n\n');res.end();}
 });server.listen(0,'127.0.0.1');await once(server,'listening');endpoint='http://127.0.0.1:'+(server.address() as {port:number}).port;vi.spyOn(users,'listOfficeMcpServers').mockResolvedValue([{id:'orders',label:'Orders',endpoint,enabled:true,allowedRoles:['user']}]);});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));vi.restoreAllMocks();});
it('rejects all private, documentation, mapped and special address ranges while retaining public DNS targets',()=>{
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','0.0.0.0','224.0.0.1','198.18.0.1','2001:db8::1','2001:0db8::1','::ffff:127.0.0.1','fd00::1','::1','2002:7f00:1::'])expect(isPublicOfficeAddress(address),address).toBe(false);
 for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])expect(isPublicOfficeAddress(address),address).toBe(true);
});
it('rejects credentials, non-HTTPS and private website requests before a network connection',async()=>{
 for(const url of ['http://example.test','https://user:password@example.test','https://127.0.0.1','https://[::1]','https://localhost','https://example.test:444'])await expect(readOfficeWebPage(url,new AbortController().signal)).rejects.toThrow();
});
it('discovers only the assigned source and reads an actual MCP JSON/SSE result without exposing the endpoint',async()=>{
 expect(await listOfficeConnections(user)).toEqual([{id:'orders',label:'Orders'}]);
 const listing=await readOfficeConnection(user,'orders',undefined,undefined,new AbortController().signal);expect(JSON.stringify(listing)).toContain('read_orders');expect(JSON.stringify(listing)).not.toMatch(/send_email|127\.0\.0\.1|private-session/);
 expect(await readOfficeConnection(user,'orders','read_orders',{},new AbortController().signal)).toMatchObject({content:[{text:'Order ST100: 2400 pieces'}]});expect(calls.filter(value=>value==='tools/call')).toHaveLength(1);
 await expect(readOfficeConnection(user,'orders','send_email',{},new AbortController().signal)).rejects.toThrow('read-only');await expect(readOfficeConnection(user,'other','read_orders',{},new AbortController().signal)).rejects.toThrow('unavailable');
});
it('denies unassigned, disabled and revoked connections before further network calls',async()=>{
 vi.mocked(users.getOfficeUser).mockResolvedValue({...user,mcpServers:[]});
 expect(await listOfficeConnections(user)).toEqual([]);
 await expect(readOfficeConnection(user,'orders',undefined,undefined,new AbortController().signal)).rejects.toThrow('unavailable');
 vi.mocked(users.getOfficeUser).mockResolvedValue({...user,enabled:false});
 expect(await listOfficeConnections(user)).toEqual([]);
 await expect(readOfficeConnection(user,'orders',undefined,undefined,new AbortController().signal)).rejects.toThrow('unavailable');
 vi.mocked(users.getOfficeUser).mockResolvedValue(user);
 vi.mocked(users.listOfficeMcpServers).mockResolvedValue([{id:'orders',label:'Orders',endpoint,enabled:false,allowedRoles:['user']}]);
 await expect(readOfficeConnection(user,'orders',undefined,undefined,new AbortController().signal)).rejects.toThrow('unavailable');
 expect(calls).toEqual([]);
 vi.mocked(users.listOfficeMcpServers).mockResolvedValue([{id:'orders',label:'Orders',endpoint,enabled:true,allowedRoles:['user']}]);
 vi.mocked(users.getOfficeUser).mockResolvedValueOnce(user).mockResolvedValueOnce(user).mockResolvedValue({...user,mcpServers:[]});
 await expect(readOfficeConnection(user,'orders',undefined,undefined,new AbortController().signal)).rejects.toThrow('unavailable');
 expect(calls).toEqual(['initialize']);
});
it('routes only an assigned SmartOffice connection through its local read-only MCP adapter',async()=>{
 vi.mocked(users.getOfficeUser).mockResolvedValue({...user,mcpServers:['smartoffice']});
 vi.mocked(users.listOfficeMcpServers).mockResolvedValue([{id:'smartoffice',label:'SmartOffice',endpoint:'http://127.0.0.1:3004/',transport:'smartoffice',enabled:true,allowedRoles:['user']}]);
 const rpc=vi.spyOn(smartoffice,'smartOfficeMcpRpc').mockImplementation(async method=>method==='tools/list'?{tools:[{name:'smartoffice_query',annotations:{readOnlyHint:true}}]}:method==='tools/call'?{content:[{type:'text',text:'Verified source result'}]}:{});
 expect(await listOfficeConnections(user)).toEqual([{id:'smartoffice',label:'SmartOffice'}]);
 const value=await readOfficeConnection(user,'smartoffice','smartoffice_query',{plan:{op:'read',entity:'purchase_orders',limit:1}},new AbortController().signal);
 expect(value).toMatchObject({content:[{text:'Verified source result'}]});
 expect(rpc.mock.calls.map(call=>call[0])).toEqual(['initialize','notifications/initialized','tools/list','tools/call']);
 expect(calls).toEqual([]);
 vi.mocked(users.getOfficeUser).mockResolvedValue({...user,mcpServers:[]});
 await expect(readOfficeConnection(user,'smartoffice','smartoffice_query',{},new AbortController().signal)).rejects.toThrow('unavailable');
 expect(rpc).toHaveBeenCalledTimes(4);
});
