import { useEffect, useState } from 'preact/hooks';
import { request } from './teamSettingsRequest';
import type { OfficeLimits } from '../../src/services/officeQuota';

type Preferences = {instructions: string; limits?: OfficeLimits; usage?: {tokens: number; requests: number; storageBytes?: number; storageWarning?: string; resetsAt: number; unconfirmed?: boolean; pending?: boolean}};

export function UserWorkspaceInstructions(props: { open: boolean; owner: string }) {
  const [draft, setDraft] = useState(''), [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>();
  useEffect(() => {
    if (!props.open) return;
    let active = true;
    setSaved(undefined); setBusy(true); setStatus('Loading instructions…'); setError(false);
    void request<Preferences>('/api/workspace/preferences').then(value => {
      if (active) { setPreferences(value); setDraft(value.instructions); setSaved(value.instructions); setStatus(''); }
    }).catch(() => { if (active) { setError(true); setStatus('Instructions could not be loaded. Close settings and try again.'); } })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [props.open, props.owner]);
  return <>{preferences?.usage ? <section class="settings-block settings-block-wide user-workspace-usage" aria-label="Your usage"><div class="settings-block-title">Your usage</div><dl>{([
    ['Tokens today', preferences.usage.tokens, preferences.limits?.dailyTokens],
    ['Requests today', preferences.usage.requests, preferences.limits?.dailyRequests],
    ['File storage (MB)', preferences.usage.storageBytes === undefined ? undefined : Math.ceil(preferences.usage.storageBytes / 1024 / 1024 * 100) / 100, preferences.limits?.storageMb]
  ] as const).map(([label, used, limit]) => <div key={label}><dt>{label}</dt><dd>{used === undefined ? 'Unavailable' : used.toLocaleString()} / {limit ? limit.toLocaleString() : 'Unlimited'}</dd></div>)}</dl><small>Daily allowances reset {new Date(preferences.usage.resetsAt).toLocaleString()}. A response already running may finish.</small>{preferences.usage.unconfirmed || preferences.usage.pending ? <p role="status">Some token usage could not be confirmed. Your remaining allowance will be available after the daily reset.</p> : null}{preferences.usage.storageWarning ? <p role="status">{preferences.usage.storageWarning}</p> : null}</section> : null}<form class="settings-block settings-block-wide user-workspace-instructions" onSubmit={event => {
    event.preventDefault(); if (saved === undefined || busy) return;
    setBusy(true); setError(false); setStatus('Saving instructions…');
    void request<{instructions: string}>('/api/workspace/preferences', 'PUT', {instructions: draft, expected: saved}).then(value => {
      setSaved(value.instructions); setStatus('Workspace instructions saved. They apply to your next message.');
    }).catch(reason => { setError(true); setStatus(reason instanceof Error ? reason.message : 'Save could not be confirmed. Reload settings before retrying.'); })
      .finally(() => setBusy(false));
  }}>
    <div class="settings-block-head"><label class="settings-block-title" for="user-workspace-instructions">How should your assistant respond?</label><div class="settings-block-sub">Add your goals, preferred language, tone, and how you like work delivered. These instructions apply across your conversations.</div></div>
    <textarea id="user-workspace-instructions" maxLength={8000} rows={5} value={draft} disabled={busy || saved === undefined} placeholder="For example: Explain clearly, ask when requirements are unclear, and create files when I ask for a deliverable." onInput={event => setDraft(event.currentTarget.value)} />
    <button type="submit" disabled={busy || saved === undefined || draft === saved}>Save instructions</button>
    <div role={error ? 'alert' : 'status'} aria-live="polite">{status}</div>
  </form></>;
}
