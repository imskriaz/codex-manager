import {normalizePersistedWebDashboardSessions,WebDashboardServer,fingerprintWebDashboardSession} from '../src/services/webDashboardServer';
import * as users from '../src/services/officeUsers';
import {afterEach,expect,it,vi} from 'vitest';
afterEach(()=>vi.restoreAllMocks());
it('retains independent subscriber sign-ins without evicting older devices',()=>{
 const sessions=Array.from({length:30},(_,i)=>({officeUserId:'user'+i,fingerprint:i.toString(16).padStart(64,'0'),expiresAt:Date.now()+100000}));expect(normalizePersistedWebDashboardSessions(JSON.stringify(sessions))).toHaveLength(30);
 const devices=sessions.map(session=>({...session,officeUserId:'same',expiresAt:0}));expect(normalizePersistedWebDashboardSessions(JSON.stringify(devices))).toEqual(devices);
});
it('rejects a stale password/security version even when a cookie has not expired',async()=>{
 const token='a'.repeat(64),session={fingerprint:fingerprintWebDashboardSession(token),expiresAt:0,officeUserId:'alex',officeSessionVersion:'old'};
 const server=Object.assign(Object.create(WebDashboardServer.prototype),{auth:{readSessions:async()=>JSON.stringify([session])},sessions:new Map()});
 const user={id:'alex',enabled:true,sessionVersion:'old'} as users.OfficeUser;vi.spyOn(users,'getOfficeUser').mockResolvedValue(user);
 expect(await server.isAuthorizedSessionToken(token)).toBe(true);user.sessionVersion='reset';expect(await server.isAuthorizedSessionToken(token)).toBe(false);user.sessionVersion='old';user.enabled=false;expect(await server.isAuthorizedSessionToken(token)).toBe(false);
});
it('enforces manual plan expiry, status and model membership without hiding saved file access',()=>{
 const user={role:'user',plan:{name:'Starter',status:'active',models:['luna'],expiresAt:Date.now()+10000}} as users.OfficeUser;expect(()=>users.checkOfficeEntitlement(user,'luna')).not.toThrow();expect(()=>users.checkOfficeEntitlement(user,'sol')).toThrow('included');user.plan!.expiresAt=0;expect(()=>users.checkOfficeEntitlement(user,'luna')).toThrow('inactive');expect(users.validateOfficePlan({name:'Paid',status:'active',models:[]})).toMatchObject({name:'Paid'});
 for(const value of [null,{name:'x',status:'active',models:['bad model']},{name:'x',status:'expired',models:[]}])expect(()=>users.validateOfficePlan(value)).toThrow();
});
