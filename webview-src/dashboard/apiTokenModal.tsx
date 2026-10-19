import { useState } from 'preact/hooks';
import type { DashboardCliProject } from '../../src/domain/dashboard/types';
import type { DashboardApiToken } from '../../src/domain/dashboard/apiActions';
import { DASHBOARD_API_ACTIONS, PROJECT_API_ACTIONS } from '../../src/domain/dashboard/apiActions';
import { ModalShell } from './primitives';
export function ApiTokenModal(props: {
  open: boolean; token?: string; tokens: DashboardApiToken[]; projects?: DashboardCliProject[];
  enabled: boolean; connected: boolean; pending: boolean; onClose: () => void;
  onGenerate: (name: string, projectPath: string | undefined, permissions: string[]) => void; onRevoke: (id: string) => void;
}) {
  const [tab, setTab] = useState('tokens'), [name, setName] = useState(''), [project, setProject] = useState('');
  const [permissions, setPermissions] = useState<string[]>(['state','getProjectBoard','getProjectTaskDetails']);
  const [operation, setOperation] = useState('getProjectBoard'), [payload, setPayload] = useState('{}');
  const [credential, setCredential] = useState(''), [result, setResult] = useState(''), [testing, setTesting] = useState(false);
  const allowedPermissions = ['state', ...(project ? [] : ['settings']), ...DASHBOARD_API_ACTIONS.filter(action => !project || PROJECT_API_ACTIONS.has(action))];
  const browser = location.protocol === 'http:' || location.protocol === 'https:';
  const canUse = props.enabled && props.connected && !props.pending;
  const test = async () => {
    if (!props.connected || !browser) return;
    setTesting(true); setResult('Sending once…');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Payload must be a JSON object.');
      const response = await fetch('/api/message', { method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${credential || props.token || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'dashboard:action', requestId: `api-${crypto.randomUUID()}`, action: operation, payload: parsed }) });
      setResult(`HTTP ${response.status}\n${(await response.text()).slice(0, 64000)}`);
    } catch (error) { setResult(`Request not confirmed: ${(error as Error).message}. Check current state before retrying a write.`); }
    finally { clearTimeout(timer); setTesting(false); }
  };
  return <ModalShell open={props.open} title="API access" closeLabel="Close" onClose={props.onClose} className="dashboard-api-modal">
    <p class="settings-note">{props.enabled ? 'Named tokens with project scope and operation permissions. Tokens are shown once; only hashes are stored.' : 'API access is off. Enable Dashboard API in Settings to create and use tokens.'}</p>
    <div class="api-token-tabs" role="tablist" aria-label="API tools">{['tokens','explorer','test'].map(value => <button type="button" key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value[0]!.toUpperCase()+value.slice(1)}</button>)}</div>
    {tab === 'tokens' ? <>
      <div class="api-table-scroll"><table class="api-token-table"><thead><tr><th>Name</th><th>Project scope</th><th>Permissions</th><th>Created</th><th>Action</th></tr></thead><tbody>{props.tokens.map(token => <tr key={token.id}><td>{token.name}</td><td title={token.projectPath}>{token.projectPath?.split(/[\\/]/).pop() || 'All projects'}</td><td title={token.permissions.join(', ')}>{token.permissions.includes('*') ? 'All operations' : `${token.permissions.length} operations`}</td><td>{new Date(token.createdAt).toLocaleDateString()}</td><td><button type="button" disabled={!props.connected || props.pending} onClick={() => props.onRevoke(token.id)}>Revoke</button></td></tr>)}</tbody></table>{!props.tokens.length ? <p class="task-board-empty">No API tokens yet.</p> : null}</div>
      <form class="api-token-create" onSubmit={event => { event.preventDefault(); props.onGenerate(name, project || undefined, permissions); }}>
        <label>Token name<input value={name} maxLength={80} required onInput={event => setName(event.currentTarget.value)} placeholder="Build pipeline" /></label>
        <label>Project scope<input list="api-project-paths" value={project} placeholder="All projects (leave empty)" onInput={event => { const next = event.currentTarget.value; setProject(next); if (next) setPermissions(current => current.filter(permission => permission === '*' || permission === 'state' || PROJECT_API_ACTIONS.has(permission as import('../../src/domain/dashboard/types').DashboardActionName))); }} /><datalist id="api-project-paths">{props.projects?.map(item => <option value={item.path} key={item.path}>{item.label}</option>)}</datalist><small>Leave empty for all projects, or enter an absolute project folder.</small></label>
        <label>Permission preset<select value={permissions.includes('*') ? 'all' : 'selected'} onChange={event => setPermissions(event.currentTarget.value === 'all' ? ['*'] : ['state','getProjectBoard','getProjectTaskDetails'])}><option value="selected">Selected operations</option><option value="all">All operations within scope</option></select></label>
        {!permissions.includes('*') ? <details class="api-permissions"><summary>{permissions.length} permissions selected</summary><div>{allowedPermissions.map(action => <label key={action}><input type="checkbox" checked={permissions.includes(action)} onChange={event => setPermissions(current => event.currentTarget.checked ? [...current, action] : current.filter(value => value !== action))} />{action}</label>)}</div></details> : null}
        <button type="submit" disabled={!canUse || !name.trim() || !permissions.length}>Create token</button>
      </form>
      {props.token ? <div class="api-token-result"><strong>Copy this token now</strong><textarea readOnly value={props.token} rows={2} aria-label="New API token" onFocus={event => event.currentTarget.select()} /><button type="button" onClick={() => { void navigator.clipboard.writeText(props.token!).then(() => setResult('Token copied.'), () => setResult('Copy blocked. Select the token and copy it manually.')); }}>Copy token</button></div> : null}
    </> : tab === 'explorer' ? <>
      <div class="api-explorer-row"><strong>GET /api/state</strong><p>Reads dashboard state, or only the scoped project. Requires state permission.</p></div>
      <div class="api-explorer-row"><strong>GET /api/schema</strong><p>Lists operations allowed by the supplied token.</p></div>
      <div class="api-explorer-row"><strong>POST /api/message</strong><pre>{JSON.stringify({ type: 'dashboard:action', requestId: 'unique-request-id', action: operation, payload: { projectPath: project || '/your/project' } }, null, 2)}</pre></div>
      <label>Operation<select value={operation} onChange={event => setOperation(event.currentTarget.value)}>{DASHBOARD_API_ACTIONS.map(action => <option value={action}>{action}</option>)}</select></label>
      <p class="settings-note">Send Authorization: Bearer &lt;token&gt;. Project tokens cannot access other projects, accounts, terminal control, or global settings. Write actions retain their normal confirmation fields.</p>
    </> : <div class="api-test-form">{!browser ? <p class="settings-note">Open the browser dashboard to test HTTP API requests.</p> : null}
      <label>Bearer token<input type="password" autoComplete="off" value={credential} placeholder={props.token ? 'Uses the newly created token' : 'Paste a token'} onInput={event => setCredential(event.currentTarget.value)} /></label>
      <label>Operation<select value={operation} onChange={event => setOperation(event.currentTarget.value)}>{DASHBOARD_API_ACTIONS.map(action => <option value={action}>{action}</option>)}</select></label>
      <label>Payload (JSON)<textarea rows={6} value={payload} onInput={event => setPayload(event.currentTarget.value)} /></label>
      <button type="button" disabled={!canUse || !browser || testing || !(credential || props.token)} onClick={() => { void test(); }}>{testing ? 'Waiting…' : 'Send request once'}</button>
    </div>}
    {result ? <pre class="api-test-result" role="status">{result}</pre> : null}
  </ModalShell>;
}
