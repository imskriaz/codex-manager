import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebDashboardServer } from '../src/services/webDashboardServer';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { officeProxySnapshot, readOfficeProxyAccess } from '../src/services/officeProxy';
import { readDashboardApiToken } from '../src/services/dashboardApiToken';
import * as users from '../src/services/officeUsers';
import { removeTestDirectory } from './testFilesystem';

let root: string, database: SqliteStateStore, server: WebDashboardServer, host: any, user: users.OfficeUser;
let enabled: boolean, moduleEnabled: boolean;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'workspace-proxy-routes-'));
  database = await SqliteStateStore.open(path.join(root, 'state.sqlite')); configureSqliteStateStore(database);
  server = new WebDashboardServer({extensionUri:{fsPath:process.cwd()},secrets:{get:vi.fn(async()=>undefined)}} as never,{} as never); host=server;
  user = {id:'alex',role:'user',enabled:true,features:['generalChat']} as users.OfficeUser;
  vi.spyOn(host,'isAuthorized').mockResolvedValue(true); vi.spyOn(host,'officeUserForRequest').mockImplementation(async()=>user);
  vi.spyOn(users,'getOfficeUser').mockImplementation(async()=>user);
  enabled = moduleEnabled = true;
  host.settingsStore = {getDashboardSettings:()=>({teamWorkspaceEnabled:moduleEnabled,apiAccessEnabled:enabled})};
});
afterEach(async()=>{server.dispose();vi.restoreAllMocks();configureSqliteStateStore(undefined);database.close();await removeTestDirectory(root);});
async function call(method: string, body?: unknown) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as any;
  Object.assign(req,{method,url:'/api/workspace/proxy',headers:{host:'127.0.0.1:39875',origin:'http://127.0.0.1:39875','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}});
  let output='';const res={statusCode:200,setHeader:vi.fn(),end:(value:string)=>{output=String(value);}};
  await host.handle(req,res);return {status:res.statusCode,value:JSON.parse(output)};
}
it('allows regular users to generate scoped keys without granting dashboard API access or trusting a body owner',async()=>{
  const created=await call('POST',{name:'Codex',requestId:randomUUID(),owner:'other'});
  expect(created.status).toBe(200);expect(created.value.key.value).toMatch(/^cm_/);
  expect((await readOfficeProxyAccess(created.value.key.value))?.user.id).toBe('alex');
  expect(await readDashboardApiToken(host.context,created.value.key.value)).toBeUndefined();
  expect(officeProxySnapshot({...user,id:'other'},true).keys).toEqual([]);
  const listed=await call('GET');expect(listed.status).toBe(200);expect(listed.value.keys).toHaveLength(1);
  expect(JSON.stringify(listed.value)).not.toContain(created.value.key.value);
  user={...user,id:'other'};
  expect((await call('DELETE',{id:created.value.key.id,confirmed:true})).status).toBe(400);
  user={...user,id:'alex'};
  expect((await call('DELETE',{id:created.value.key.id,confirmed:true})).value.message).toBe('Key revoked.');
  expect(await readOfficeProxyAccess(created.value.key.value)).toBeUndefined();
});
it('reports disabled, invalid and conflicting changes and preserves Auto defaults',async()=>{
  expect((await call('GET')).value.settings).toEqual({revision:'0',mappings:{}});
  expect((await call('PUT',{expected:'0',mappings:{}})).value.message).toBe('Proxy settings saved.');
  expect((await call('PUT',{expected:'0',mappings:{}})).value.error).toContain('changed');
  expect((await call('POST',{name:'',requestId:randomUUID()})).status).toBe(400);
  enabled=false;expect((await call('GET')).value.enabled).toBe(false);
  expect((await call('POST',{name:'key',requestId:randomUUID()})).value.error).toContain('disabled');
  moduleEnabled=false;expect((await call('GET')).status).toBe(403);
  moduleEnabled=true;user={...user,role:'unrestricted-admin'};expect((await call('GET')).status).toBe(403);
});
