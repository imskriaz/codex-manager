import { useEffect, useRef, useState } from 'preact/hooks';
import { OFFICE_PROXY_DEFAULTS, type OfficeProxyAlias, type OfficeProxySnapshot, type OfficeProxySettings, type OfficeProxyKey } from '../../src/domain/officeProxy';
import { officeProfileLabel } from '../../src/domain/officeModels';
import { CLAUDE_PROXY_MODEL_OVERRIDES } from '../../src/domain/dashboard/apiProxy';
import { request } from './teamSettingsRequest';
import { handleTabKeyDown, ModalShell } from './primitives';
import { ToolIcon, CopyIcon, renderRefreshIcon } from './icons';

type Snapshot = OfficeProxySnapshot & { key?: {id: string; value: string}; message?: string };
const MODEL_GROUPS = [
  { name: 'Claude Code', aliases: ['claude-opus', 'claude-sonnet', 'claude-haiku', 'claude-fable'] },
  { name: 'Codex', aliases: ['regular', 'professional', 'expert'] }
] as const;
export function UserWorkspaceProxy({ connected }: { connected: boolean }) {
  const [tab, setTab] = useState('keys'), [snapshot, setSnapshot] = useState<Snapshot>();
  const [mappings, setMappings] = useState<OfficeProxySettings['mappings']>({});
  const [name, setName] = useState(''), [secret, setSecret] = useState('');
  const [client, setClient] = useState<'codex' | 'claude'>(), [revoking, setRevoking] = useState<OfficeProxyKey>();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [failed, setFailed] = useState(false);
  const pending = useRef(false), alive = useRef(true), createId = useRef(crypto.randomUUID());
  const run = async (method = 'GET', input?: unknown, automatic = false) => {
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
      setStatus(automatic ? '' : result.message || (method === 'GET' ? 'Proxy refreshed. Your mapping draft is kept.' : 'Proxy updated.'));
    } catch (error) {
      if (alive.current) { setFailed(true); setStatus(error instanceof Error ? error.message : 'The result could not be confirmed. Reload before retrying.'); }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => { alive.current = true; void run('GET', undefined, true); return () => { alive.current = false; }; }, []);
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setFailed(false); setStatus('Copied to clipboard.'); }
    catch { setFailed(true); setStatus('Clipboard is unavailable. Select and copy the displayed text manually.'); }
  };
  const feedback = status ? <p class={`user-proxy-notice${failed ? ' is-error' : ''}`} role={failed ? 'alert' : 'status'}>{status}</p> : null;
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
  const dirty = (Object.keys(OFFICE_PROXY_DEFAULTS) as OfficeProxyAlias[]).some(alias => mappings[alias] !== snapshot?.settings.mappings[alias]);
  const customCount = Object.keys(mappings).length;
  return <section class="settings-block settings-block-wide user-proxy" aria-label="Proxy">
    <header class="user-proxy-heading"><div><h3 class="settings-block-title">Proxy</h3><p>Connect your coding tools.</p></div><button class="user-proxy-refresh" type="button" aria-label="Refresh proxy" disabled={busy || !connected} onClick={() => void run()}>{renderRefreshIcon()}<span>Refresh</span></button></header>
    {!connected ? <p class="user-proxy-notice is-error" role="alert">Disconnected. Reconnect before changing Proxy.</p> : null}
    {snapshot && !snapshot.enabled ? <p class="user-proxy-notice" role="alert">Proxy access is disabled by your administrator. You can still review settings and revoke keys.</p> : null}
    <div role="tablist" aria-label="Proxy sections" onKeyDown={handleTabKeyDown} class="user-proxy-tabs">
      {['keys', 'settings'].map(value => <button type="button" role="tab" aria-label={value === 'keys' ? 'Keys' : 'Settings'} id={`user-proxy-tab-${value}`} aria-selected={tab === value} aria-controls={`user-proxy-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => { setTab(value); if (!failed) setStatus(''); }}>{value === 'keys' ? <>Keys{snapshot ? <span aria-hidden="true">{snapshot.keys.length}</span> : null}</> : 'Settings'}</button>)}
    </div>
    {!client && !revoking ? feedback : null}
    {snapshot ? <>
      <div id="user-proxy-panel-keys" role="tabpanel" aria-labelledby="user-proxy-tab-keys" hidden={tab !== 'keys'}>
        <div class="user-proxy-section-heading"><h4>API keys</h4><p>Private keys for AI requests only.</p></div>
        <form class="user-proxy-create" onSubmit={event => { event.preventDefault(); void run('POST', { name, requestId: createId.current }); }}>
          <label>Key name<input required maxLength={80} placeholder="e.g. Work laptop" value={name} disabled={busy || !connected || !snapshot.enabled} onInput={event => setName(event.currentTarget.value)} /></label>
          <button class="user-proxy-primary" type="submit" disabled={busy || !connected || !snapshot.enabled || !name.trim()}><ToolIcon kind="plus" />Generate key</button>
        </form>
        {secret ? <div class="user-proxy-secret"><div class="user-proxy-section-heading"><h4>Save your new key</h4><p>This is the only time it will be shown. Keep it private.</p></div><label>New API key<input readOnly type="text" value={secret} spellcheck={false} autoComplete="off" onFocus={event => event.currentTarget.select()} /></label><div class="user-proxy-actions"><button class="user-proxy-primary" type="button" onClick={() => void copy(secret)}><CopyIcon />Copy key</button><button type="button" onClick={() => { setSecret(''); setStatus('Key hidden. It cannot be shown again.'); }}>Hide key</button></div></div> : null}
        {snapshot.keys.length ? <ul class="user-proxy-keys">{snapshot.keys.map(key => <li key={key.id}><span class="user-proxy-key-icon"><ToolIcon kind="key" /></span><span class="user-proxy-key-name">{key.name}<small>Created {new Date(key.createdAt).toLocaleDateString()}</small></span><button class="user-proxy-danger" type="button" disabled={busy || !connected} aria-label={`Revoke ${key.name}`} onClick={() => setRevoking(key)}>Revoke</button></li>)}</ul> : <div class="user-proxy-empty"><ToolIcon kind="key" /><p>No proxy keys yet.</p><small>Name a key above to connect your first client.</small></div>}
        <p class="user-proxy-footnote">Your plan and usage limits apply to every key. Revoke a key to stop its access.</p>
      </div>
      <div id="user-proxy-panel-settings" role="tabpanel" aria-labelledby="user-proxy-tab-settings" hidden={tab !== 'settings'}>
        <div class="user-proxy-section-heading"><h4>Connect a client</h4><p>Use a key from the Keys tab with either configuration.</p></div>
        <div class="user-proxy-clients">{(['claude', 'codex'] as const).map(value => <div class="user-proxy-client" key={value}><span class="user-proxy-client-icon"><ToolIcon kind="terminal" /></span><div><h4>{value === 'claude' ? 'Claude Code' : 'Codex'}</h4><p>{value === 'claude' ? 'Anthropic-compatible connection' : 'OpenAI-compatible connection'}</p></div><button type="button" aria-label={value === 'claude' ? 'Claude settings' : 'Codex settings'} onClick={() => { setStatus(''); setClient(value); }}>Configure</button></div>)}</div>
        <details class="user-proxy-mappings"><summary><span>Model mapping<small>{customCount ? `${customCount} custom ${customCount === 1 ? 'mapping' : 'mappings'}` : 'Auto configured · no setup needed'}</small></span><ToolIcon kind="down" /></summary>
          <p>Auto uses your available workspace profiles. Customize a target only when you need a different model.</p>
          <form onSubmit={event => { event.preventDefault(); void run('PUT', { mappings, expected: snapshot.settings.revision }); }}>
            {MODEL_GROUPS.map(group => <fieldset key={group.name}><legend>{group.name}</legend>{group.aliases.map(alias => <label class="user-proxy-map-row" key={alias}><span>{alias.startsWith('claude-') ? alias.slice(7).replace(/^./, character => character.toUpperCase()) : officeProfileLabel(alias as 'regular' | 'professional' | 'expert')}<code>{alias}</code></span><select aria-label={`Map ${alias}`} disabled={busy || !connected} value={mappings[alias] ?? ''} onChange={event => { const next = { ...mappings }; const value = event.currentTarget.value; if (value) next[alias] = value as typeof OFFICE_PROXY_DEFAULTS[OfficeProxyAlias]; else delete next[alias]; setMappings(next); }}><option value="">Auto ({autoLabel(alias)})</option>{mappings[alias] && !snapshot.profiles.some(choice => choice.profile === mappings[alias]) ? <option value={mappings[alias]} disabled>{officeProfileLabel(mappings[alias]!)} (unavailable)</option> : null}{snapshot.profiles.map(({ profile }) => <option value={profile}>{officeProfileLabel(profile)}</option>)}</select></label>)}</fieldset>)}
            <div class="user-proxy-save"><span>{dirty ? 'Unsaved changes' : 'Mappings up to date'}</span><button class="user-proxy-primary" type="submit" disabled={busy || !connected || !dirty}>Save mappings</button></div>
          </form>
        </details>
      </div>
    </> : null}
    <ModalShell open={!!client} title={client === 'claude' ? 'Claude settings' : 'Codex settings'} closeLabel="Close client settings" onClose={closeClient} className="office-user-settings user-proxy user-proxy-dialog">
      <p class="user-proxy-dialog-intro">{client === 'claude' ? 'Merge this configuration into your Claude Code settings.' : 'Merge this configuration into your Codex settings.'}</p>
      {feedback}
      <div class="user-proxy-code"><div class="user-proxy-code-heading"><code>{client === 'claude' ? 'settings.json' : 'config.toml'}</code><button type="button" aria-label="Copy configuration" onClick={() => void copy(config)}><CopyIcon />Copy</button></div><textarea aria-label="Client configuration" readOnly rows={12} wrap="off" value={config} spellcheck={false} onFocus={event => event.currentTarget.select()} /></div>
      <div class="user-proxy-dialog-help"><ToolIcon kind="key" /><p>{client === 'claude' ? 'Replace <YOUR_PROXY_KEY> with a key from Proxy → Keys.' : 'Set MANAGER_API_KEY in your environment to a key from Proxy → Keys.'} Never share your key.</p></div>
      <p class="user-proxy-footnote">{client === 'claude' ? 'Auto defaults: Opus → Expert, Sonnet → Professional, Haiku → Regular.' : 'Regular, Professional and Expert automatically use your workspace models.'} You can customize these in Proxy → Settings.</p>
    </ModalShell>
    <ModalShell open={!!revoking} title="Revoke proxy key" closeLabel="Cancel key revocation" closeDisabled={busy} onClose={() => { setRevoking(undefined); setStatus('Key revocation cancelled.'); setFailed(false); }} className="office-user-settings user-proxy user-proxy-dialog user-proxy-confirm">
      {feedback}<p>Revoke <strong>{revoking?.name}</strong>? Clients using this key will lose access immediately.</p><div class="user-proxy-actions"><button type="button" disabled={busy} onClick={() => { setRevoking(undefined); setStatus('Key revocation cancelled.'); setFailed(false); }}>Cancel</button><button class="user-proxy-danger" type="button" disabled={busy || !connected} onClick={() => void run('DELETE', {id: revoking?.id, confirmed: true})}>Confirm revoke</button></div>
    </ModalShell>
  </section>;
}
