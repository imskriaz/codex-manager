import { expect, it } from 'vitest';
import { API_ENDPOINTS, apiPayloadExample, buildApiTestRequest, canTestApiEndpoint } from '../webview-src/dashboard/apiPlayground';

it('keeps proxy access host-wide and invalidates missing grants', () => {
  const scoped = { actions:['getProjectBoard'], projects:['D:/demo'], permissions:['*'] };
  expect(canTestApiEndpoint('action',scoped,'getProjectBoard')).toBe(true);
  expect(canTestApiEndpoint('action',scoped,'refreshAll')).toBe(false);
  expect(canTestApiEndpoint('state',scoped,'')).toBe(true);
  for (const endpoint of ['models','chat','responses','messages'] as const) {
    expect(canTestApiEndpoint(endpoint,scoped,'')).toBe(false);
    expect(canTestApiEndpoint(endpoint,{...scoped,projects:[]},'')).toBe(true);
    expect(canTestApiEndpoint(endpoint,{...scoped,projects:[],permissions:[]},'')).toBe(false);
  }
  for (const endpoint of API_ENDPOINTS) expect(canTestApiEndpoint(endpoint.id,undefined,'')).toBe(false);
  expect(canTestApiEndpoint('schema',{actions:[],projects:[],permissions:[]},'')).toBe(true);
});
it('builds scoped dashboard writes once and leaves GET requests body-free', () => {
  const request = buildApiTestRequest('action','{"confirmed":true}','saveProjectTask','D:/demo','unique');
  expect(request.path).toBe('/api/message');
  expect(JSON.parse(request.body!)).toEqual({type:'dashboard:action',requestId:'unique',action:'saveProjectTask',payload:{projectPath:'D:/demo',confirmed:true}});
  for (const endpoint of ['models','state','schema'] as const) expect(buildApiTestRequest(endpoint,'invalid','', '', '')).toEqual({method:'GET',path:API_ENDPOINTS.find(item=>item.id===endpoint)!.path});
  for (const input of ['null','[]','false','{']) expect(()=>buildApiTestRequest('action',input,'refreshAll','','unique')).toThrow();
});
it.each(['chat','responses','messages'] as const)('uses the actual %s proxy endpoint and validates its model before sending', endpoint => {
  expect(()=>buildApiTestRequest(endpoint,apiPayloadExample(endpoint),'','','')).toThrow('Choose a model');
  for (const model of [null,1,'','  ']) expect(()=>buildApiTestRequest(endpoint,JSON.stringify({model}),'','','')).toThrow('Choose a model');
  const request = buildApiTestRequest(endpoint,apiPayloadExample(endpoint,'fixture-model'),'','','');
  expect(request.path).toBe(API_ENDPOINTS.find(item=>item.id===endpoint)!.path);
  expect(request.method).toBe('POST');
  expect(JSON.parse(request.body!)).toMatchObject({model:'fixture-model',stream:false});
  expect(request.body).not.toContain('dashboard:action');
});
