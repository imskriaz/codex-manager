import { useEffect, useRef, useState } from 'preact/hooks';
import { OFFICE_PROXY_DEFAULTS, type OfficeProxyAlias, type OfficeProxySnapshot, type OfficeProxySettings, type OfficeProxyKey } from '../../src/domain/officeProxy';
import { officeProfileLabel } from '../../src/domain/officeModels';
import { CLAUDE_PROXY_MODEL_OVERRIDES } from '../../src/domain/dashboard/apiProxy';
import { request } from './teamSettingsRequest';
import { handleTabKeyDown, ModalShell } from './primitives';

type Snapshot = OfficeProxySnapshot & { key?: {id: string; value: string}; message?: string };
export function UserWorkspaceProxy({ connected }: { connected: boolean }) {
  const [tab, setTab] = useState('keys'), [snapshot, setSnapshot] = useState<Snapshot>();
  const [mappings, setMappings] = useState<OfficeProxySettings['mappings']>({});
  const [name, setName] = useState(''), [secret, setSecret] = useState('');
  const [client, setClient] = useState<'codex' | 'claude'>(), [revoking, setRevoking] = useState<OfficeProxyKey>();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [failed, setFailed] = useState(false);
  const pending = useRef(false), alive = useRef(true), createId = useRef(crypto.randomUUID());
  const run = async (method = 'GET', input?: unknown) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false); setStatus(method === 'GET' ? 'Loading proxy…' : 'Saving…');
    try {
      const result = await request<Snapshot>('/api/workspace/proxy', method, input);
      if (!alive.current) return;
      setSnapshot({ ...result, key: undefined });
      if (!snapshot || method === 'PUT') setMappings(result.settings.mappings);
      setRevoking(undefined);
      if (result.key) { setSecret(result.key.value); setName(''); createId.current = crypto.randomUUID(); }
      if (method === 'DELETE') setSecret('');
      setStatus(result.message || (method === 'GET' ? 'Proxy refreshed. Review your mapping draft before saving.' : 'Proxy updated.'));
    } catch (error) {
      if (alive.current) { setFailed(true); setStatus(error instanceof Error ? error.message : 'The result could not be confirmed. Reload before retrying.'); }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => { alive.current = true; void run(); return () => { alive.current = false; }; }, []);
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setFailed(false); setStatus('Copied to clipboard.'); }
    catch { setFailed(true); setStatus('Clipboard is unavailable. Select and copy the displayed text manually.'); }
  };
  const feedback = status ? <p role={failed ? 'alert' : 'status'}>{status}</p> : null;
  const origin = window.location.origin;
  const config = client === 'claude' ? JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: '<YOUR_PROXY_KEY>', ANTHROPIC_MODEL: 'claude-sonnet',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku'
  }, modelOverrides: CLAUDE_PROXY_MODEL_OVERRIDES }, null, 2) :
    `model = "professional"\nmodel_provider = "workspace_proxy"\n\n[model_providers.workspace_proxy]\nname = "Workspace Proxy"\nbase_url = ${JSON.stringify(`${origin}/v1`)}\nenv_key = "MANAGER_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false`;
  const closeClient = () => { setClient(undefined); setFailed(false); setStatus('Client configuration closed.'); };
  const autoLabel = (alias: OfficeProxyAlias) => {
    const profile = snapshot?.profiles.find(choice => choice.profile === OFFICE_PROXY_DEFAULTS[alias])?.profile ?? snapshot?.profiles[0]?.profile;
    return profile ? officeProfileLabel(profile) : 'Unavailable';
  };
  return <section class="settings-block settings-block-wide user-proxy" aria-label="Proxy">
    <h3 class="settings-block-title">Proxy</h3>
    <p>Use your workspace models in Claude Code or Codex with your own proxy key. Your plan and usage limits still apply.</p>
    {!connected ? <p role="alert">Disconnected. Reconnect before changing Proxy.</p> : null}
    {snapshot && !snapshot.enabled ? <p role="alert">Proxy access is disabled by your administrator. You can still review settings and revoke keys.</p> : null}
    <div role="tablist" aria-label="Proxy sections" onKeyDown={handleTabKeyDown} class="api-token-tabs">
      {['keys', 'settings'].map(value => <button type="button" role="tab" id={`user-proxy-tab-${value}`} aria-selected={tab === value} aria-controls={`user-proxy-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}>{value === 'keys' ? 'Keys' : 'Settings'}</button>)}
    </div>
    {!client && !revoking ? feedback : null}
    <button type="button" disabled={busy || !connected} onClick={() => void run()}>Refresh proxy</button>
    {snapshot ? <>
      <div id="user-proxy-panel-keys" role="tabpanel" aria-labelledby="user-proxy-tab-keys" hidden={tab !== 'keys'}>
        <form onSubmit={event => { event.preventDefault(); void run('POST', { name, requestId: createId.current }); }}>
          <label>Key name<input required maxLength={80} value={name} disabled={busy || !connected || !snapshot.enabled} onInput={event => setName(event.currentTarget.value)} /></label>
          <button type="submit" disabled={busy || !connected || !snapshot.enabled || !name.trim()}>Generate key</button>
        </form>
        {secret ? <div class="user-proxy-secret"><label>New API key<input readOnly type="text" value={secret} spellcheck={false} autoComplete="off" onFocus={event => event.currentTarget.select()} /></label><p>Copy now. This key is only shown once. Keep it private.</p><button type="button" onClick={() => void copy(secret)}>Copy key</button><button type="button" onClick={() => { setSecret(''); setStatus('Key hidden. It cannot be shown again.'); }}>Hide key</button></div> : null}
        {snapshot.keys.length ? <ul class="user-proxy-keys">{snapshot.keys.map(key => <li key={key.id}><span>{key.name}<small>Created {new Date(key.createdAt).toLocaleDateString()}</small></span><button type="button" disabled={busy || !connected} aria-label={`Revoke ${key.name}`} onClick={() => setRevoking(key)}>Revoke</button></li>)}</ul> : <p>No proxy keys yet.</p>}
      </div>
      <div id="user-proxy-panel-settings" role="tabpanel" aria-labelledby="user-proxy-tab-settings" hidden={tab !== 'settings'}>
        <p>Auto configures each model for you. Change a target only if you want a different workspace profile. The proxy sends requests to that profile’s actual configured model.</p>
        <div class="modal-actions"><button type="button" onClick={() => { setStatus(''); setClient('claude'); }}>Claude settings</button><button type="button" onClick={() => { setStatus(''); setClient('codex'); }}>Codex settings</button></div>
        <form onSubmit={event => { event.preventDefault(); void run('PUT', { mappings, expected: snapshot.settings.revision }); }}>
          {(Object.keys(OFFICE_PROXY_DEFAULTS) as OfficeProxyAlias[]).map(alias => <label key={alias}>{alias}<select aria-label={`Map ${alias}`} disabled={busy || !connected} value={mappings[alias] ?? ''} onChange={event => { const next = { ...mappings }; const value = event.currentTarget.value; if (value) next[alias] = value as typeof OFFICE_PROXY_DEFAULTS[OfficeProxyAlias]; else delete next[alias]; setMappings(next); }}><option value="">Auto ({autoLabel(alias)})</option>{mappings[alias] && !snapshot.profiles.some(choice => choice.profile === mappings[alias]) ? <option value={mappings[alias]} disabled>{officeProfileLabel(mappings[alias]!)} (unavailable)</option> : null}{snapshot.profiles.map(({ profile }) => <option value={profile}>{officeProfileLabel(profile)}</option>)}</select></label>)}
          <button type="submit" disabled={busy || !connected}>Save mappings</button>
        </form>
      </div>
    </> : null}
    <ModalShell open={!!client} title={client === 'claude' ? 'Claude settings' : 'Codex settings'} closeLabel="Close client settings" onClose={closeClient} className="office-user-settings user-proxy">
      {feedback}<p>{client === 'claude' ? 'Merge this into your Claude Code settings.json. Replace the key placeholder with a key from Proxy → Keys.' : 'Merge this into your Codex config.toml. Set MANAGER_API_KEY in your environment to a key from Proxy → Keys.'}</p>
      <textarea aria-label="Client configuration" readOnly rows={12} value={config} spellcheck={false} onFocus={event => event.currentTarget.select()} />
      <button type="button" onClick={() => void copy(config)}>Copy configuration</button>
      <p>Default roles: Opus → Expert; Sonnet → Professional; Haiku → Regular. Auto uses an available profile from your plan when a default is unavailable. Review or change the targets in Proxy → Settings.</p>
    </ModalShell>
    <ModalShell open={!!revoking} title="Revoke proxy key" closeLabel="Cancel key revocation" closeDisabled={busy} onClose={() => { setRevoking(undefined); setStatus('Key revocation cancelled.'); setFailed(false); }} className="office-user-settings user-proxy">
      {feedback}<p>Revoke {revoking?.name}? Clients using this key will lose access.</p><button type="button" disabled={busy || !connected} onClick={() => void run('DELETE', {id: revoking?.id, confirmed: true})}>Confirm revoke</button>
    </ModalShell>
  </section>;
}
