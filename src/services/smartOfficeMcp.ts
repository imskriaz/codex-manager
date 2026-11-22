import {fetch} from 'undici';

const tools = [
  {name:'smartoffice_schema',description:'Without entity, discover query syntax and available business sources. Then pass one exact entity ID to read its complete fields, metrics and relations before querying.',inputSchema:{type:'object',properties:{entity:{type:'string',description:'Exact entity ID from the source catalogue. Omit to discover sources and query syntax.'}},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'smartoffice_query',description:'Read current SmartOffice business data using one validated query plan from smartoffice_schema. No SQL or writes. Prefer small read or aggregate results.',inputSchema:{type:'object',properties:{plan:{type:'object',description:'One canonical SmartOffice query plan using the discovered schema.'}},required:['plan'],additionalProperties:false},annotations:{readOnlyHint:true}}
];

export const SMARTOFFICE_ENDPOINT = 'http://127.0.0.1:3004';

// Only the installed application's schema and validated read-only query routes are reachable.
export async function smartOfficeMcpRpc(method:string, params:unknown, signal:AbortSignal):Promise<unknown> {
  signal.throwIfAborted();
  if (method === 'initialize') return {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'smartoffice-data',version:'1'}};
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return {tools};
  if (method !== 'tools/call') throw new Error('Unsupported SmartOffice MCP method.');
  const call = params as {name?:unknown;arguments?:{plan?:unknown;entity?:unknown}} | undefined;
  const schema = call?.name === 'smartoffice_schema';
  if (!schema && call?.name !== 'smartoffice_query') throw new Error('Choose a read-only SmartOffice action.');
  const plan = call?.arguments?.plan;
  const entity = call?.arguments?.entity;
  if (schema && entity !== undefined && (typeof entity !== 'string' || entity.length > 160)) throw new Error('Choose an entity from the SmartOffice source catalogue.');
  if (!schema && (!plan || typeof plan !== 'object' || Array.isArray(plan))) throw new Error('Provide one SmartOffice query plan from its schema.');
  const url = new URL(SMARTOFFICE_ENDPOINT + (schema ? '/api/query/schema' : '/api/query'));
  if (!schema) for (const [key,value] of Object.entries(plan as Record<string,unknown>)) {
    if (value !== undefined) url.searchParams.set(key,typeof value === 'string' ? value : JSON.stringify(value));
  }
  if (url.href.length > 12000) throw new Error('This SmartOffice query is too large. Use a smaller plan.');
  let response;
  try {
    response = await fetch(url.href, {method:'GET', redirect:'error', signal, headers:{Accept:'application/json'}});
  } catch (error) {
    signal.throwIfAborted();
    throw new Error('SmartOffice is unavailable. Ask your administrator to check its local read-only service.', {cause:error});
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SmartOffice returned no data.');
  const chunks:Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read() as ReadableStreamReadResult<Uint8Array>; if (part.done) break;
      bytes += part.value.length;
      if (bytes > 1048576) throw new Error('SmartOffice returned too much data. Ask for a smaller result.');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  let result:{ok?:boolean;error?:unknown;schema?:Record<string,unknown> & {entities?:Array<Record<string,unknown>>}};
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof result; }
  catch { throw new Error('SmartOffice did not return valid data. Ask your administrator to check its local read-only service.'); }
  if (!result || typeof result !== 'object' || !response.ok || result.ok === false) {
    if (response.status === 401 || response.status === 403) throw new Error('SmartOffice denied data access. Ask your administrator to check its read-only service permissions.');
    if ([400,422].includes(response.status) && typeof result.error === 'string') throw new Error('SmartOffice query failed: '+result.error.slice(0,500));
    throw new Error('SmartOffice could not complete this query. Check the current schema and query plan.');
  }
  let payload:unknown = result;
  if (schema) {
    if (!result.schema || !Array.isArray(result.schema.entities)) throw new Error('SmartOffice did not return a source catalogue.');
    if (entity !== undefined) {
      const selected = result.schema.entities.find(item => item['entity'] === entity);
      if (!selected) throw new Error('Choose an entity from the SmartOffice source catalogue.');
      payload = {version:result.schema['version'],entity:selected};
    } else {
      const {entities,graph:_graph,dataApis:_dataApis,surfaces:_surfaces,...contract} = result.schema;
      payload = {...contract,entities:entities.map(item => ({entity:item['entity'],label:item['label'],aliases:item['aliases'],notes:item['notes']})),next:'Call smartoffice_schema with an exact entity ID for its complete field and relation definitions.'};
    }
  }
  const output = {content:[{type:'text',text:JSON.stringify(payload)}]};
  if (JSON.stringify(output).length > 95000) throw new Error('SmartOffice returned too much data for chat. Select one entity or narrow the query with filters, fields and a smaller limit.');
  return output;
}
