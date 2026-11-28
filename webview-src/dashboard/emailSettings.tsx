import { useEffect, useState } from 'preact/hooks';
import type { EmailPreferences, PublicSmtpConfig } from '../../src/services/emailNotifications';
import { request } from './teamSettingsRequest';

type EmailState = { preferences: EmailPreferences; watches: string[]; available: boolean; status?: { state: string; at: number; error?: string } };
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Email settings could not be confirmed. Refresh and retry.';

export async function requestEmailPreferences(method = 'GET', body?: unknown): Promise<EmailState & { message?: string }> {
  const value = await request<EmailState & { message?: string }>('/api/email/preferences', method, body);
  const preferences = value?.preferences;
  if (!preferences || typeof preferences.address !== 'string' || typeof preferences.revision !== 'string' ||
      !['enabled', 'ready', 'needsAnswer', 'failed', 'includeResult'].every(key => typeof preferences[key as keyof EmailPreferences] === 'boolean') ||
      !Array.isArray(value.watches) || !value.watches.every(key => typeof key === 'string') || typeof value.available !== 'boolean' ||
      method !== 'GET' && typeof value.message !== 'string')
    throw new Error('The host returned incomplete email settings. Refresh before retrying. Your changes were kept.');
  return value;
}

export async function requestEmailSmtp(method = 'GET', body?: unknown): Promise<{ config: PublicSmtpConfig; message?: string }> {
  const value = await request<{ config: PublicSmtpConfig; message?: string }>('/api/email/smtp', method, body);
  const config = value?.config;
  if (!config || !['revision', 'host', 'user', 'from', 'baseUrl'].every(key => typeof config[key as keyof PublicSmtpConfig] === 'string') ||
      typeof config.enabled !== 'boolean' || typeof config.hasPassword !== 'boolean' || !Number.isInteger(config.port) ||
      config.port < 1 || config.port > 65535 || !['starttls', 'tls'].includes(config.security) ||
      method !== 'GET' && typeof value.message !== 'string')
    throw new Error('The host returned incomplete SMTP settings. Refresh before retrying. Your changes were kept.');
  return value;
}

export function EmailSettings({ master = false }: { master?: boolean }) {
  const [state, setState] = useState<EmailState>();
  const [config, setConfig] = useState<PublicSmtpConfig>();
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('Loading email settings…');
  const [failed, setFailed] = useState(false);
  const load = async () => {
    setBusy(true); setFailed(false); setFeedback('Loading email settings…');
    try {
      const [value, smtp] = await Promise.all([requestEmailPreferences(), master ? requestEmailSmtp() : undefined]);
      setState(value); setConfig(smtp?.config); setFeedback('');
    } catch (error) { setFeedback(errorText(error)); setFailed(true); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [master]);
  const act = async (kind: 'smtp' | 'preferences' | 'test') => {
    if (busy) return;
    setBusy(true); setFailed(false); setFeedback(kind === 'test' ? 'Sending test email…' : 'Saving email settings…');
    try {
      if (kind === 'smtp' && config) {
        const result = await requestEmailSmtp('PUT', { ...config, password, clearPassword });
        setConfig(result.config); setPassword(''); setClearPassword(false); setState(value => value ? { ...value, available: result.config.enabled } : value); setFeedback(result.message!);
      } else if (kind === 'preferences' && state) {
        const result = await requestEmailPreferences('PUT', state.preferences); setState(result); setFeedback(result.message!);
      } else {
        if (state) { const saved = await requestEmailPreferences('PUT', state.preferences); setState(saved); }
        const result = await request<{ message: string }>('/api/email/test', 'POST', {});
        if (!result || typeof result.message !== 'string') throw new Error('Test email acceptance was not confirmed. Refresh before retrying.');
        setFeedback(result.message);
      }
    } catch (error) { setFeedback(errorText(error)); setFailed(true); }
    finally { setBusy(false); }
  };
  const patch = (value: Partial<EmailPreferences>) => setState(current => current ? { ...current, preferences: { ...current.preferences, ...value } } : current);
  const smtp = (value: Partial<PublicSmtpConfig>) => setConfig(current => current ? { ...current, ...value } : current);
  return <section class="settings-block settings-block-wide email-settings" aria-label="Email notifications">
    <h3 class="settings-block-title">Email notifications</h3>
    <p>Choose when to receive an email, even after you close the workspace.</p>
    {feedback ? <p role={failed ? 'alert' : 'status'}>{feedback}</p> : null}
    {!state ? <button type="button" disabled={busy} onClick={() => void load()}>Retry loading email settings</button> : <>
      {!state.available ? <p role="status">Email delivery is off. {master ? 'Configure and enable SMTP below.' : 'Ask your administrator to enable SMTP.'}</p> : null}
      <form onSubmit={event => { event.preventDefault(); void act('preferences'); }}>
        <fieldset disabled={busy}>
          {master ? <label>Email address<input type="email" autoComplete="email" maxLength={254} value={state.preferences.address} onInput={event => patch({ address: event.currentTarget.value })} placeholder="you@example.com" /></label> : <p>Notifications are sent to your account email.</p>}
          <label class="email-check"><input type="checkbox" checked={state.preferences.enabled} onChange={event => patch({ enabled: event.currentTarget.checked })} />Email me about all my sessions</label>
          {([['ready', 'Notify me when ready'], ['needsAnswer', 'When an answer or approval is needed'], ['failed', 'When a session fails'], ['includeResult', 'Include a result excerpt in the email']] as const).map(([key, label]) => <label class="email-check" key={key}><input type="checkbox" checked={state.preferences[key]} onChange={event => patch({ [key]: event.currentTarget.checked })} />{label}</label>)}
          <p>For a single conversation, use “Email me when ready” in its three-dot menu. Result excerpts are off by default.</p>
          <div class="email-actions"><button type="submit">Save email preferences</button><button type="button" disabled={!state.available || !state.preferences.address} onClick={() => void act('test')}>Send test email</button></div>
        </fieldset>
      </form>
      {state.status ? <p role={state.status.state === 'failed' ? 'alert' : 'status'}>{state.status.state === 'failed' ? state.status.error : state.status.state === 'accepted' ? 'Latest notification accepted by the SMTP server.' : 'Latest notification is being sent.'} {new Date(state.status.at).toLocaleString()}</p> : null}
    </>}
    {master && config ? <details class="email-smtp"><summary>SMTP configuration</summary><form onSubmit={event => { event.preventDefault(); void act('smtp'); }}><fieldset disabled={busy}>
      <label class="email-check"><input type="checkbox" checked={config.enabled} onChange={event => smtp({ enabled: event.currentTarget.checked })} />Enable email delivery</label>
      <div class="email-smtp-grid"><label>SMTP host<input maxLength={253} value={config.host} autoComplete="off" placeholder="smtp.example.com" onInput={event => smtp({ host: event.currentTarget.value })} /></label><label>Port<input type="number" min={1} max={65535} value={config.port} onInput={event => smtp({ port: Number(event.currentTarget.value) })} /></label></div>
      <label>Connection security<select value={config.security} onChange={event => smtp({ security: event.currentTarget.value as PublicSmtpConfig['security'] })}><option value="starttls">STARTTLS (usually port 587)</option><option value="tls">TLS (usually port 465)</option></select></label>
      <label>SMTP username<input autoComplete="off" maxLength={320} value={config.user} onInput={event => smtp({ user: event.currentTarget.value })} /></label>
      <label>SMTP password or app password<input type="password" autoComplete="new-password" maxLength={4096} value={password} placeholder={config.hasPassword ? 'Saved password — leave blank to keep' : 'Enter SMTP password'} onInput={event => setPassword(event.currentTarget.value)} /></label>
      {config.hasPassword ? <label class="email-check"><input type="checkbox" checked={clearPassword} onChange={event => setClearPassword(event.currentTarget.checked)} />Remove saved password</label> : null}
      <label>Sender email<input type="email" autoComplete="off" maxLength={254} value={config.from} placeholder="notifications@example.com" onInput={event => smtp({ from: event.currentTarget.value })} /></label>
      <label>Dashboard address (optional)<input type="url" maxLength={2048} value={config.baseUrl} placeholder="https://dashboard.example" onInput={event => smtp({ baseUrl: event.currentTarget.value })} /></label>
      <p>Use an address recipients can reach to include conversation links. SMTP credentials stay on this host.</p>
      <button type="submit">Save SMTP settings</button>
    </fieldset></form></details> : null}
  </section>;
}

export function useSessionEmailWatch(sessionKey?: string, onToggle?: () => void) {
  const [enabled, setEnabled] = useState(false), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true; setReady(false); setFeedback(''); setEnabled(false);
    if (!sessionKey) return;
    void requestEmailPreferences().then(value => { if (active) { setEnabled(value.watches.includes(sessionKey)); setReady(true); } }).catch(error => { if (active) { setReady(true); setFailed(true); setFeedback(errorText(error)); } });
    return () => { active = false; };
  }, [sessionKey]);
  const toggle = async () => {
    if (!sessionKey || busy) return;
    onToggle?.();
    setBusy(true); setFailed(false); setFeedback('Saving email preference…');
    try { const value = await requestEmailPreferences('POST', { sessionKey, enabled: !enabled }); setEnabled(value.watches.includes(sessionKey)); setFeedback(value.available ? enabled ? 'Session email turned off.' : 'You’ll receive an email when this session is ready.' : 'Preference saved. Email delivery is off; ask the administrator to enable SMTP.'); }
    catch (error) { setFailed(true); setFeedback(errorText(error)); }
    finally { setBusy(false); }
  };
  return {
    menuItem: <button type="button" role="menuitemcheckbox" aria-checked={enabled} aria-busy={busy} disabled={!ready || busy} onClick={() => void toggle()}><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>Email me when ready{enabled ? ' (on)' : ''}</button>,
    feedback: feedback ? <span class="session-email-watch"><span class="session-email-feedback" role={failed ? 'alert' : 'status'}>{feedback}<button type="button" aria-label="Dismiss email notice" onClick={() => setFeedback('')}>×</button></span></span> : null
  };
}
