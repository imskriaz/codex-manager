import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardCliProject } from '../../src/domain/dashboard/types';
import type { DashboardApiToken } from '../../src/domain/dashboard/apiActions';
import { DASHBOARD_API_ACTIONS, PROJECT_API_ACTIONS, apiTokenProjects } from '../../src/domain/dashboard/apiActions';
import { formatApiResponse, readApiResponse } from './apiResponse';
import { API_ENDPOINTS, apiPayloadExample, buildApiTestRequest, canTestApiEndpoint, type ApiEndpointId, type ApiInspection } from './apiPlayground';
import { ModalShell } from './primitives';
export function ApiTokenModal(props: {
  open: boolean; token?: string; tokens: DashboardApiToken[]; projects?: DashboardCliProject[]; baseUrl?: string;
  error?: string; uncertain?: boolean; loading?: boolean; onRefresh: () => void;
  enabled: boolean; connected: boolean; pending: boolean; onClose: () => void;
  onGenerate: (name: string, projectPaths: string[] | undefined, permissions: string[]) => void; onRevoke: (id: string) => void;
}) {
  const [projectInput,setProjectInput]=useState('');
  const [createOpen, setCreateOpen] = useState(false), [name, setName] = useState('');
  const [keysOpen,setKeysOpen] = useState(false), [detailsOpen,setDetailsOpen] = useState(false);
  const [allProjects, setAllProjects] = useState(true), [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<string[]>(['state','getProjectBoard','getProjectTaskDetails']);
  const [operation, setOperation] = useState('getProjectBoard');
  const [endpoint, setEndpoint] = useState<ApiEndpointId>('action');
  const [payloads, setPayloads] = useState<Partial<Record<ApiEndpointId,string>>>({action:'{}'});
  const payload = payloads[endpoint] ?? apiPayloadExample(endpoint);
  const setPayload = (value: string) => setPayloads(current => ({...current,[endpoint]:value}));
  const [model, setModel] = useState(''), [models, setModels] = useState<string[]>([]);
  const [requestMeta, setRequestMeta] = useState<{status?:number; duration:number; bytes?:number}>();
  const [requestCopy, setRequestCopy] = useState('');
  const selectedEndpoint = API_ENDPOINTS.find(item=>item.id===endpoint)!;
  const [credential, setCredential] = useState(''), [result, setResult] = useState(''), [testing, setTesting] = useState(false);
  const bearer = credential.trim() || props.token?.trim() || '';
  const [access, setAccess] = useState<ApiInspection & { credential: string; name: string }>();
  const [inspection, setInspection] = useState(''), [inspectRetry, setInspectRetry] = useState(0);
  const [testProject, setTestProject] = useState('');
  const requestRef = useRef<AbortController>();
  const requestGeneration = useRef(0);
  const checked = access?.credential === bearer ? access : undefined;
  const [createdToken, setCreatedToken] = useState<string>(), [copyStatus, setCopyStatus] = useState('');
  useEffect(() => { if (props.token) setCreatedToken(props.token); }, [props.token]);
  useEffect(() => { if (!props.open) {requestGeneration.current++;setCreatedToken(undefined);setCredential('');setCreateOpen(false);setKeysOpen(false);setDetailsOpen(false);setCopyStatus('');setAccess(undefined);setInspection('');setResult('');setModels([]);setModel('');setRequestMeta(undefined);requestRef.current?.abort();requestRef.current=undefined;setTesting(false);} }, [props.open]);
  const allowedPermissions = ['state', ...(allProjects ? ['settings','aiProxy'] : []), ...DASHBOARD_API_ACTIONS.filter(action => allProjects || PROJECT_API_ACTIONS.has(action))];
  const browser = location.protocol === 'http:' || location.protocol === 'https:';
  const baseUrl = browser ? location.origin : props.baseUrl;
  const canUse = props.enabled && props.connected && !props.pending && !props.uncertain;
  const changeModel = (value: string) => {
    setModel(value);
    if (selectedEndpoint.method==='GET') return;
    try {
      const current: unknown = JSON.parse(payload);
      if (!current || typeof current!=='object' || Array.isArray(current)) throw new Error('Invalid payload');
      setPayload(JSON.stringify({...current,model:value},null,2));
    } catch { setRequestCopy('Fix the JSON payload or load an example before changing its model.'); }
  };
  useEffect(() => {
    setAccess(undefined);
    if (!props.open || createOpen || !browser || !props.connected || !props.enabled || !bearer) { setInspection(''); return; }
    const controller = new AbortController();
    let active = true;
    setInspection('Checking token permissions…');
    const timeout = setTimeout(() => controller.abort(), 10000);
    const debounce = setTimeout(() => { void (async () => {
      try {
        const response = await fetch('/api/schema', { headers: { Authorization: `Bearer ${bearer}` }, signal: controller.signal, cache: 'no-store' });
        const body = await readApiResponse(response);
        if (!active) return;
        if (!response.ok) { setInspection(formatApiResponse(response.status, body)); return; }
        const schema = JSON.parse(body.text) as { actions?: unknown; token?: { name?: unknown; projectPaths?: unknown; permissions?: unknown } };
        if (body.truncated || !Array.isArray(schema.actions) || !schema.actions.every(action => typeof action === 'string' && DASHBOARD_API_ACTIONS.includes(action as never)) || !schema.token || typeof schema.token.name !== 'string' || !Array.isArray(schema.token.projectPaths) || !schema.token.projectPaths.every(path => typeof path === 'string')) throw new Error('Invalid permission response. Recheck the token.');
        const actions = schema.actions as string[], projects = schema.token.projectPaths as string[];
        const permissions = schema.token.permissions;
        if (permissions !== undefined && (!Array.isArray(permissions) || !permissions.every(item=>typeof item==='string'))) throw new Error('Invalid token permissions. Recheck the token.');
        setAccess({ credential: bearer, actions, projects, permissions: permissions as string[] | undefined ?? [], name: schema.token.name });
        setOperation(current => actions.includes(current) ? current : actions[0] ?? '');
        setTestProject(current => projects.includes(current) ? current : projects[0] ?? '');
        setInspection('');
      } catch (error) { if (active) setInspection(`Token check failed: ${(error as Error).message}. No action was sent.`); }
      finally { clearTimeout(timeout); }
    })(); }, 300);
    return () => { active = false; clearTimeout(debounce); clearTimeout(timeout); controller.abort(); };
  }, [props.open, createOpen, bearer, props.connected, props.enabled, inspectRetry]);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => { if (!props.connected) requestRef.current?.abort('Connection lost'); }, [props.connected]);
  const test = async (target = endpoint) => {
    if (!canUse || !browser || !canTestApiEndpoint(target, checked, operation) || requestRef.current) return;
    setTesting(true); setResult('Sending once…'); setRequestMeta(undefined); setRequestCopy('');
    const controller = new AbortController(); requestRef.current = controller;
    const generation = requestGeneration.current;
    const started = performance.now();
    const timer = setTimeout(() => controller.abort('Request timed out'), 60000);
    try {
      const request = buildApiTestRequest(target, payload, operation, checked!.projects.length ? testProject : '', 'api-'+crypto.randomUUID());
      const response = await fetch(request.path, { method: request.method, signal: controller.signal, cache:'no-store',
        headers: { Authorization: 'Bearer '+bearer, ...(request.body ? {'Content-Type':'application/json'} : {}) },
        ...(request.body ? {body:request.body} : {}) });
      const body = await readApiResponse(response);
      if (generation!==requestGeneration.current) return;
      setResult(formatApiResponse(response.status, body));
      setRequestMeta({status:response.status,duration:Math.round(performance.now()-started),bytes:new TextEncoder().encode(body.text).length});
      if (target==='models' && response.ok && !body.truncated) {
        try {
        const data = JSON.parse(body.text) as {data?:Array<{id?:unknown}>};
        const ids = Array.isArray(data.data) ? data.data.flatMap(item=>item && typeof item.id==='string' ? [item.id] : []).slice(0,200) : [];
        setModels(ids); setModel(current=>ids.includes(current) ? current : ids[0] ?? '');
        } catch { setRequestCopy('The response is not a valid model catalogue. Review the response before sending a generation.'); }
      }
    } catch (error) {
      if (generation!==requestGeneration.current) return;
      setRequestMeta({duration:Math.round(performance.now()-started)});
      setResult('Request not confirmed: '+(controller.signal.aborted ? String(controller.signal.reason) : (error as Error).message)+'. Check current state before retrying a write.');
    }
    finally { clearTimeout(timer); if(requestRef.current===controller) {requestRef.current = undefined; setTesting(false);} }
  };
  const copy = (value: string) => { void Promise.resolve().then(()=>navigator.clipboard.writeText(value)).then(()=>setRequestCopy('Copied.'),()=>setRequestCopy('Copy blocked. Select the text and copy it manually.')); };
  let requestPreview = '';
  try { const request = buildApiTestRequest(endpoint,payload,operation,checked?.projects.length ? testProject : '', 'unique-request-id'); requestPreview = JSON.stringify({...request,...(request.body ? {body:JSON.parse(request.body) as unknown} : {})},null,2); } catch { requestPreview = 'Enter a valid request payload to see the complete request.'; }
  return <>
  <ModalShell open={props.open && !createOpen && !keysOpen && !detailsOpen} title="API access" closeLabel="Close" closeDisabled={props.pending || testing} onClose={() => { setCreateOpen(false); props.onClose(); }} className="dashboard-api-modal" headerActions={<button type="button" class="api-key-button" aria-label="Manage API keys" title="Manage API keys" disabled={props.pending || testing} onClick={()=>setKeysOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3" fill="none" stroke="currentColor" stroke-width="1.7"/></svg></button>}>
    {!props.enabled ? <p role="status">Enable Dashboard API in Settings to create and use tokens.</p> : null}
    {!props.connected ? <p role="status">Offline. Reconnect before managing API tokens.</p> : null}
    {props.error ? <p class="share-outcome is-error" role="alert">{props.error}</p> : null}
    {props.uncertain ? <p role="status">Refresh the list to verify the previous request before creating another token.</p> : null}
    <div class="api-playground" aria-label="Explorer and Test">
      <div class="api-auth-bar">
        <label>Bearer token<input type="password" autoComplete="off" value={credential} placeholder={props.token ? 'Uses the newly created token' : 'Paste an API token'} disabled={testing} onInput={event => { setCredential(event.currentTarget.value); setAccess(undefined); setModels([]); setModel(''); setResult(''); setRequestMeta(undefined); }} /></label>
        <div class="api-access-check"><button type="button" disabled={!canUse || testing} onClick={() => { setCreatedToken(undefined); setCopyStatus(''); setCreateOpen(true); }}>+ Create token</button><button type="button" disabled={!browser || !props.connected || !props.enabled || !bearer || testing} onClick={() => setInspectRetry(current => current + 1)}>Recheck token</button>{checked ? <small>{checked.name} · {checked.actions.length} operations · {checked.projects.length ? checked.projects.length+' project folders' : 'Host-wide'}</small> : null}</div>
        {inspection ? <p class="settings-note" role="status">{inspection}</p> : null}
        {!browser ? <p role="status">Open the browser dashboard to test HTTP API requests.</p> : null}
      </div>

      <div class="api-playground-layout">
        <nav class="api-endpoints" aria-label="API endpoints">{['Manager','AI proxy'].map(group=><div key={group}><h4>{group}</h4>{API_ENDPOINTS.filter(item=>item.group===group).map(item=><button type="button" key={item.id} aria-pressed={endpoint===item.id} disabled={testing} onClick={()=>{setEndpoint(item.id);setResult('');setRequestMeta(undefined);setRequestCopy('');}}><span class={item.method==='GET' ? 'api-method is-get' : 'api-method'}>{item.method}</span><span><strong>{item.label}</strong><code>{item.path}</code></span></button>)}</div>)}</nav>

            <section class="api-test-form" aria-label="Request editor"><div class="api-section-heading"><h4>Request</h4><div class="api-send-row"><button type="button" class="modal-primary-btn api-send-icon" title={testing ? 'Waiting for response' : 'Send request once'} aria-label={testing ? 'Waiting…' : 'Send request once'} disabled={!canUse || !browser || testing || !canTestApiEndpoint(endpoint,checked,operation)} onClick={()=>{void test();}}>{testing ? <span class="cli-live-spinner" aria-hidden="true"/> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 3 17 9-17 9 3-9-3-9Zm3 9h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>}</button>{testing ? <button type="button" onClick={()=>requestRef.current?.abort('Cancelled by user')}>Cancel request</button> : null}</div></div>
              {endpoint==='action' ? <><label>Operation<select aria-label="Operation" value={checked ? operation : ''} disabled={!checked?.actions.length || testing} onChange={event=>setOperation(event.currentTarget.value)}>{!checked?.actions.length ? <option value="">Check a token to see permitted operations</option> : checked.actions.map(action=><option key={action} value={action}>{action}</option>)}</select></label>{checked?.projects.length ? <label>Host project<select aria-label="Host project" value={testProject} disabled={testing} onChange={event=>setTestProject(event.currentTarget.value)}>{checked.projects.map(path=><option key={path} value={path}>{path}</option>)}</select></label> : null}</> : null}
              {selectedEndpoint.permission==='aiProxy' && selectedEndpoint.method==='POST' ? <div class="api-model-controls"><label>Model ID<input list="api-proxy-models" value={model} disabled={testing} placeholder="Discover or enter a model ID" onInput={event=>changeModel(event.currentTarget.value)} /><datalist id="api-proxy-models">{models.map(id=><option key={id} value={id}/>)}</datalist></label><button type="button" disabled={!canUse || !browser || testing || !canTestApiEndpoint('models',checked,operation)} onClick={()=>{void test('models');}}>Load models</button></div> : null}
              <label>Endpoint<div class="api-endpoint-field"><span class={selectedEndpoint.method==='GET' ? 'api-method is-get' : 'api-method'}>{selectedEndpoint.method}</span><input aria-label="Endpoint" readOnly value={(baseUrl ?? '<host>')+selectedEndpoint.path} onFocus={event=>event.currentTarget.select()} /><button type="button" aria-label="Copy endpoint" title="Copy endpoint" onClick={()=>copy((baseUrl ?? '<host>')+selectedEndpoint.path)}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15 8V4H4v11h4" fill="none" stroke="currentColor" stroke-width="1.7"/></svg></button></div></label>
              {selectedEndpoint.method==='POST' ? <><div class="api-payload-heading"><label for="api-request-body">Payload (JSON)</label><button type="button" disabled={testing} onClick={()=>setPayload(apiPayloadExample(endpoint,model || undefined))}>Load example</button></div><textarea id="api-request-body" aria-label="Payload (JSON)" rows={8} spellcheck={false} value={payload} disabled={testing} onInput={event=>setPayload(event.currentTarget.value)} /></> : null}

              {checked && !canTestApiEndpoint(endpoint,checked,operation) ? <p role="status" class="settings-note">This token does not grant access to this endpoint.</p> : null}
            </section>
            <section class="api-response-pane" aria-label="Response"><div class="api-section-heading"><h4>Response</h4>{requestMeta ? <span class={requestMeta.status && requestMeta.status<400 ? 'api-response-meta is-success' : 'api-response-meta'}>{requestMeta.status ? 'HTTP '+requestMeta.status+' · ' : ''}{requestMeta.duration} ms{requestMeta.bytes!==undefined ? ' · '+requestMeta.bytes+' B' : ''}</span> : <small>Ready when you are</small>}</div>{result ? <pre class="api-test-result" role="status">{result}</pre> : <div class="api-response-empty">Response appears here.</div>}{result && !testing ? <button type="button" class="api-copy-response" title="Copy response" aria-label="Copy response" onClick={()=>copy(result)}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15 8V4H4v11h4" fill="none" stroke="currentColor" stroke-width="1.7"/></svg></button> : null}</section>
      </div>
          <button type="button" class="api-details-button" disabled={testing} onClick={()=>setDetailsOpen(true)}>Details</button>
          {requestCopy ? <small role="status">{requestCopy}</small> : null}
    </div>
  </ModalShell>
  <ModalShell open={props.open && detailsOpen} title="Request details" closeLabel="Close request details" onClose={()=>setDetailsOpen(false)} className="dashboard-api-modal api-details-modal"><p>{selectedEndpoint.description}</p><p>Authorization: Bearer &lt;token&gt;. Proxy calls need host-wide aiProxy permission and create no local session.</p><pre>{requestPreview}</pre><button type="button" onClick={()=>copy(requestPreview)}>Copy request</button>{requestCopy ? <small role="status">{requestCopy}</small> : null}</ModalShell>
  <ModalShell open={props.open && keysOpen && !createOpen} title="API keys" closeLabel="Close key management" closeDisabled={props.pending} onClose={()=>setKeysOpen(false)} className="dashboard-api-modal api-create-modal">
    {props.error ? <p role="alert">{props.error}</p> : null}
    {!props.connected ? <p role="status">Offline. Reconnect to manage keys.</p> : null}
    <div class="api-key-actions"><button type="button" disabled={!canUse} onClick={()=>{setCreatedToken(undefined);setCopyStatus('');setCreateOpen(true);}}>+ Create token</button></div>
    <div class="api-token-workspace">
      <section class="api-token-pane api-token-list-pane" aria-label="API tokens">
        <div class="api-pane-heading"><strong>Tokens</strong><span>{props.loading ? 'Loading…' : `${props.tokens.length} active`} <button type="button" disabled={!props.connected || props.loading || props.pending} onClick={props.onRefresh}>Refresh</button></span></div>
        <div class="api-table-scroll" role="region" aria-label="API tokens" tabIndex={0}><table class="api-token-table"><thead><tr><th>Name</th><th>Project scope</th><th>Permissions</th><th>Created</th><th>Action</th></tr></thead><tbody>{props.tokens.map(token => <tr key={token.id}><td>{token.name}</td><td title={apiTokenProjects(token).join('\n')}>{apiTokenProjects(token).map(path => path.split(/[\\/]/).pop()).join(', ') || 'All projects'}</td><td title={token.permissions.join(', ')}>{token.permissions.includes('*') ? 'All operations' : `${token.permissions.length} operations`}</td><td>{new Date(token.createdAt).toLocaleDateString()}</td><td><button type="button" disabled={!canUse} onClick={() => props.onRevoke(token.id)}>Revoke</button></td></tr>)}</tbody></table>{!props.tokens.length ? <p class="task-board-empty">{props.loading ? "Loading tokens…" : props.error ? "Token list unavailable. Refresh to retry." : "No API tokens yet."}</p> : null}</div>
      </section>
    </div>
  </ModalShell>
  <ModalShell open={props.open && createOpen} title="Create API token" closeLabel="Close token form" closeDisabled={props.pending} onClose={() => setCreateOpen(false)} className="dashboard-api-modal api-create-modal">

    {!props.connected ? <p role="status">Offline. Reconnect before managing API tokens.</p> : null}
    {props.error ? <p class="share-outcome is-error" role="alert">{props.error}</p> : null}
    {props.uncertain ? <div role="status">Verify the previous request before retrying. <button type="button" disabled={!props.connected || props.loading} onClick={props.onRefresh}>{props.loading ? 'Checking…' : 'Refresh token list'}</button></div> : null}
    <form class="api-token-create" onSubmit={event => { event.preventDefault(); if (canUse && !createdToken && (allProjects || selectedProjects.length)) props.onGenerate(name, allProjects ? undefined : selectedProjects, permissions); }}>
      <section class="api-token-identity"><label>Token name<input value={name} maxLength={80} required onInput={event => setName(event.currentTarget.value)} placeholder="Build pipeline" /></label>
      <fieldset class="api-project-scope"><legend>Project scope</legend><label class="api-check-all"><input type="checkbox" checked={allProjects} onChange={event => { const all = event.currentTarget.checked; setAllProjects(all); if (!all) setPermissions(current => current.filter(permission => permission === 'state' || PROJECT_API_ACTIONS.has(permission as import('../../src/domain/dashboard/types').DashboardActionName))); }} />All projects</label><div class="api-project-options">{props.projects?.map(item => <label key={item.path} title={item.path}><input type="checkbox" checked={allProjects || selectedProjects.includes(item.path)} onChange={event => { const checked = event.currentTarget.checked; const current = allProjects ? (props.projects ?? []).map(project => project.path) : selectedProjects; setSelectedProjects(checked ? [...new Set([...current,item.path])] : current.filter(path => path !== item.path)); setAllProjects(false); setPermissions(current => current.filter(permission => permission === 'state' || PROJECT_API_ACTIONS.has(permission as import('../../src/domain/dashboard/types').DashboardActionName))); }} />{item.label || item.path.split(/[\\/]/).pop()}</label>)}</div>{!props.projects?.length ? <small>No open project folders on this host. Enter an existing host folder below.</small> : null}<label>Additional host project folder<input value={projectInput} placeholder="Absolute folder path on this host" onInput={event => setProjectInput(event.currentTarget.value)} /></label><button type="button" disabled={!projectInput.trim() || props.pending || selectedProjects.length>=32} onClick={() => {setSelectedProjects(current=>[...new Set([...current,projectInput.trim()])]);setAllProjects(false);setProjectInput('');setPermissions(current=>current.filter(permission=>permission==='state'||PROJECT_API_ACTIONS.has(permission as import('../../src/domain/dashboard/types').DashboardActionName)));}}>Add folder</button>{selectedProjects.filter(path=>!props.projects?.some(project=>project.path===path)).map(path=><label key={path}><input type="checkbox" checked onChange={()=>setSelectedProjects(current=>current.filter(value=>value!==path))}/>{path}</label>)}</fieldset></section>
      <section class="api-token-permission-column"><label class="api-check-all"><input type="checkbox" checked={allowedPermissions.every(action => permissions.includes(action))} onChange={event => setPermissions(event.currentTarget.checked ? [...allowedPermissions] : [])} />Check all permissions</label>
      <details class="api-permissions" open><summary>{permissions.length} permissions selected</summary><div>{allowedPermissions.map(action => <label key={action}><input type="checkbox" checked={permissions.includes(action)} onChange={event => setPermissions(current => event.currentTarget.checked ? [...current, action] : current.filter(value => value !== action))} />{action}</label>)}</div></details></section>
      <div class="dialog-actions"><button type="button" class="modal-secondary-btn" disabled={props.pending} onClick={() => setCreateOpen(false)}>Cancel</button><button type="submit" class="modal-primary-btn" disabled={!canUse || !!createdToken || !name.trim() || !permissions.length || !allProjects && (!selectedProjects.length || selectedProjects.length > 32)}>{props.pending ? 'Creating…' : createdToken ? 'Token created' : 'Create token'}</button></div>
    </form>
    {createdToken ? <div class="api-token-result"><strong>Copy this token now</strong><textarea readOnly value={createdToken} rows={2} aria-label="New API token" onFocus={event => event.currentTarget.select()} /><button type="button" onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(createdToken)).then(() => setCopyStatus('Token copied.'), () => setCopyStatus('Copy blocked. Select the token and copy it manually.')); }}>Copy token</button><p role="status">{copyStatus}</p></div> : null}
  </ModalShell>
  </>;
}
