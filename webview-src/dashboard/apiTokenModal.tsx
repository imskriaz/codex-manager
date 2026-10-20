import { useEffect, useState } from 'preact/hooks';
import type { DashboardCliProject } from '../../src/domain/dashboard/types';
import type { DashboardApiToken } from '../../src/domain/dashboard/apiActions';
import { DASHBOARD_API_ACTIONS, PROJECT_API_ACTIONS, apiTokenProjects } from '../../src/domain/dashboard/apiActions';
import { ModalShell } from './primitives';
export function ApiTokenModal(props: {
  open: boolean; token?: string; tokens: DashboardApiToken[]; projects?: DashboardCliProject[];
  enabled: boolean; connected: boolean; pending: boolean; onClose: () => void;
  onGenerate: (name: string, projectPaths: string[] | undefined, permissions: string[]) => void; onRevoke: (id: string) => void;
}) {
  const [tab, setTab] = useState('tokens'), [createOpen, setCreateOpen] = useState(false), [name, setName] = useState('');
  const [allProjects, setAllProjects] = useState(true), [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const project = allProjects ? '' : selectedProjects[0] ?? '';
  const [permissions, setPermissions] = useState<string[]>(['state','getProjectBoard','getProjectTaskDetails']);
  const [operation, setOperation] = useState('getProjectBoard'), [payload, setPayload] = useState('{}');
  const [credential, setCredential] = useState(''), [result, setResult] = useState(''), [testing, setTesting] = useState(false);
  const [createdToken, setCreatedToken] = useState<string>(), [copyStatus, setCopyStatus] = useState('');
  useEffect(() => { if (createOpen && props.token) setCreatedToken(props.token); }, [props.token]);
  const allowedPermissions = ['state', ...(allProjects ? ['settings'] : []), ...DASHBOARD_API_ACTIONS.filter(action => allProjects || PROJECT_API_ACTIONS.has(action))];
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
  return <>
  <ModalShell open={props.open && !createOpen} title="API access" closeLabel="Close" onClose={() => { setCreateOpen(false); props.onClose(); }} className="dashboard-api-modal">
    <p class="settings-note">{props.enabled ? 'Named tokens with project scope and operation permissions. Tokens are shown once; only hashes are stored.' : 'API access is off. Enable Dashboard API in Settings to create and use tokens.'}</p>
    <div class="api-token-tabs" role="tablist" aria-label="API tools">{['tokens','explorer','test'].map(value => <button type="button" key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value[0]!.toUpperCase()+value.slice(1)}</button>)}</div>
    {tab === 'tokens' ? <div class="api-token-workspace">
      <section class="api-token-pane api-token-list-pane" aria-label="API tokens">
        <div class="api-pane-heading"><strong>Tokens</strong><span>{props.tokens.length} active <button type="button" disabled={!props.enabled || !props.connected || props.pending} onClick={() => { setCreatedToken(undefined); setCopyStatus(''); setCreateOpen(true); }}>+ Create token</button></span></div>
        <div class="api-table-scroll"><table class="api-token-table"><thead><tr><th>Name</th><th>Project scope</th><th>Permissions</th><th>Created</th><th>Action</th></tr></thead><tbody>{props.tokens.map(token => <tr key={token.id}><td>{token.name}</td><td title={apiTokenProjects(token).join('\n')}>{apiTokenProjects(token).map(path => path.split(/[\\/]/).pop()).join(', ') || 'All projects'}</td><td title={token.permissions.join(', ')}>{token.permissions.includes('*') ? 'All operations' : `${token.permissions.length} operations`}</td><td>{new Date(token.createdAt).toLocaleDateString()}</td><td><button type="button" disabled={!props.connected || props.pending} onClick={() => props.onRevoke(token.id)}>Revoke</button></td></tr>)}</tbody></table>{!props.tokens.length ? <p class="task-board-empty">No API tokens yet.</p> : null}</div>
      </section>
    </div> : tab === 'explorer' ? <div class="api-panel api-explorer-panel">
      <div class="api-explorer-row"><strong>GET /api/state</strong><p>Reads dashboard state, or only the scoped project. Requires state permission.</p></div>
      <div class="api-explorer-row"><strong>GET /api/schema</strong><p>Lists operations allowed by the supplied token.</p></div>
      <div class="api-explorer-row"><strong>POST /api/message</strong><pre>{JSON.stringify({ type: 'dashboard:action', requestId: 'unique-request-id', action: operation, payload: { projectPath: project || '/your/project' } }, null, 2)}</pre></div>
      <label>Operation<select value={operation} onChange={event => setOperation(event.currentTarget.value)}>{DASHBOARD_API_ACTIONS.map(action => <option value={action}>{action}</option>)}</select></label>
      <p class="settings-note">Send Authorization: Bearer &lt;token&gt;. Project tokens cannot access other projects, accounts, terminal control, or global settings. Write actions retain their normal confirmation fields.</p>
    </div> : <div class="api-panel api-test-form">{!browser ? <p class="settings-note">Open the browser dashboard to test HTTP API requests.</p> : null}
      <label>Bearer token<input type="password" autoComplete="off" value={credential} placeholder={props.token ? 'Uses the newly created token' : 'Paste a token'} onInput={event => setCredential(event.currentTarget.value)} /></label>
      <label>Operation<select value={operation} onChange={event => setOperation(event.currentTarget.value)}>{DASHBOARD_API_ACTIONS.map(action => <option value={action}>{action}</option>)}</select></label>
      <label>Payload (JSON)<textarea rows={6} value={payload} onInput={event => setPayload(event.currentTarget.value)} /></label>
      <button type="button" disabled={!canUse || !browser || testing || !(credential || props.token)} onClick={() => { void test(); }}>{testing ? 'Waiting…' : 'Send request once'}</button>
    </div>}
    {result ? <pre class="api-test-result" role="status">{result}</pre> : null}
  </ModalShell>
  <ModalShell open={props.open && createOpen} title="Create API token" closeLabel="Close token form" onClose={() => setCreateOpen(false)} className="dashboard-api-modal api-create-modal">
    <p class="settings-note">Create a token for this dashboard. It is shown once and only its hash is stored.</p>
    <form class="api-token-create" onSubmit={event => { event.preventDefault(); if (canUse && (allProjects || selectedProjects.length)) props.onGenerate(name, allProjects ? undefined : selectedProjects, permissions); }}>
      <label>Token name<input value={name} maxLength={80} required onInput={event => setName(event.currentTarget.value)} placeholder="Build pipeline" /></label>
      <fieldset class="api-project-scope"><legend>Project scope</legend><label class="api-check-all"><input type="checkbox" checked={allProjects} onChange={event => { const all = event.currentTarget.checked; setAllProjects(all); if (!all) setPermissions(current => current.filter(permission => permission === 'state' || PROJECT_API_ACTIONS.has(permission as import('../../src/domain/dashboard/types').DashboardActionName))); }} />All projects</label><div class="api-project-options">{props.projects?.map(item => <label key={item.path} title={item.path}><input type="checkbox" checked={allProjects || selectedProjects.includes(item.path)} onChange={event => { const checked = event.currentTarget.checked; const current = allProjects ? (props.projects ?? []).map(project => project.path) : selectedProjects; setSelectedProjects(checked ? [...new Set([...current,item.path])] : current.filter(path => path !== item.path)); setAllProjects(false); setPermissions(current => current.filter(permission => permission === 'state' || PROJECT_API_ACTIONS.has(permission as import('../../src/domain/dashboard/types').DashboardActionName))); }} />{item.label || item.path.split(/[\\/]/).pop()}</label>)}</div>{!props.projects?.length ? <small>No projects discovered yet. Open a project in Workspace to add a scoped token.</small> : null}</fieldset>
      <label class="api-check-all"><input type="checkbox" checked={allowedPermissions.every(action => permissions.includes(action))} onChange={event => setPermissions(event.currentTarget.checked ? [...allowedPermissions] : [])} />Check all permissions</label>
      <details class="api-permissions" open><summary>{permissions.length} permissions selected</summary><div>{allowedPermissions.map(action => <label key={action}><input type="checkbox" checked={permissions.includes(action)} onChange={event => setPermissions(current => event.currentTarget.checked ? [...current, action] : current.filter(value => value !== action))} />{action}</label>)}</div></details>
      <button type="submit" disabled={!canUse || !name.trim() || !permissions.length || !allProjects && (!selectedProjects.length || selectedProjects.length > 32)}>Create token</button>
    </form>
    {createdToken ? <div class="api-token-result"><strong>Copy this token now</strong><textarea readOnly value={createdToken} rows={2} aria-label="New API token" onFocus={event => event.currentTarget.select()} /><button type="button" onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(createdToken)).then(() => setCopyStatus('Token copied.'), () => setCopyStatus('Copy blocked. Select the token and copy it manually.')); }}>Copy token</button><p role="status">{copyStatus}</p></div> : null}
  </ModalShell>
  </>;
}
