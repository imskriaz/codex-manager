import { useEffect, useRef, useState } from 'preact/hooks';
import { request } from './teamSettingsRequest';
import type { OfficeLimits } from '../../src/services/officeQuota';
import { ModalShell } from './primitives';

type Preferences = {instructions: string; limits?: OfficeLimits; usage?: {tokens: number; requests: number; storageBytes?: number; storageWarning?: string; resetsAt: number; unconfirmed?: boolean; reservedTokens?:number; pending?: boolean}};

export function UserWorkspaceInstructions(props: { open: boolean; owner: string; view: string }) {
  const [draft, setDraft] = useState(''), [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>();
  const [editing, setEditing] = useState(false);
  const cancelEdit = () => { setEditing(false); setDraft(saved ?? ''); setStatus('Instruction editing cancelled.'); setError(false); };
  const revision=useRef(0);
  useEffect(() => {
    if (!props.open) return;
    let active = true;
    revision.current++;setPreferences(undefined);setDraft('');setEditing(false);
    setSaved(undefined); setBusy(true); setStatus('Loading instructions…'); setError(false);
    void request<Preferences>('/api/workspace/preferences').then(value => {
      if (active) { setPreferences(value); setDraft(value.instructions); setSaved(value.instructions); setStatus(''); }
    }).catch(() => { if (active) { setError(true); setStatus('Instructions could not be loaded. Close settings and try again.'); } })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; revision.current++; };
  }, [props.open, props.owner]);
  return <><div hidden={props.view !== 'usage'}>{preferences?.usage ? <section class="settings-block settings-block-wide user-workspace-usage" aria-label="Your usage"><h3 class="settings-block-title">Usage</h3><dl>{([
    ['Tokens today', preferences.usage.tokens, preferences.limits?.dailyTokens],
    ['Requests today', preferences.usage.requests, preferences.limits?.dailyRequests],
    ['File storage (MB)', preferences.usage.storageBytes === undefined ? undefined : Math.ceil(preferences.usage.storageBytes / 1024 / 1024 * 100) / 100, preferences.limits?.storageMb]
  ] as const).map(([label, used, limit]) => <div key={label}><dt>{label}</dt><dd>{used === undefined ? 'Unavailable' : used.toLocaleString()} / {limit ? limit.toLocaleString() : 'Unlimited'}</dd>{used !== undefined && limit ? <progress aria-label={label} max={limit} value={Math.min(used,limit)} /> : null}</div>)}</dl><small>Daily reset: {new Date(preferences.usage.resetsAt).toLocaleString()}.</small>{preferences.usage.unconfirmed ? <p role="status">Some usage is awaiting confirmation. {preferences.usage.reservedTokens ? `${preferences.usage.reservedTokens.toLocaleString()} tokens are reserved; your remaining allowance is available.` : 'Contact your workspace administrator to review it.'}</p> : preferences.usage.pending ? <p role="status">A response is running. Usage will update when it finishes.</p> : null}{preferences.usage.storageWarning ? <p role="status">{preferences.usage.storageWarning}</p> : null}</section> : <p role={error ? 'alert' : 'status'}>{busy ? 'Loading usage…' : error ? status : 'Usage is unavailable. Reopen settings to retry.'}</p>}</div><section hidden={props.view !== 'personalization'} class="settings-block settings-block-wide user-workspace-instructions"><div class="user-memory-heading"><h3 class="settings-block-title">Custom instructions</h3><button type="button" disabled={busy || saved === undefined} onClick={() => { setDraft(saved ?? ''); setEditing(true); setStatus(''); setError(false); }}>Edit instructions</button></div><p class="user-instructions-preview">{saved || 'Language, tone, and how you want work delivered.'}</p>{!editing && status ? <p role={error ? 'alert' : 'status'}>{status}</p> : null}
    <ModalShell open={props.open && editing} title="Custom instructions" closeLabel="Close instructions editor" className="office-user-settings user-editor-modal" closeDisabled={busy} onClose={cancelEdit}><form onSubmit={event => {
    event.preventDefault(); if (saved === undefined || busy) return;
    const current=revision.current;
    setBusy(true); setError(false); setStatus('Saving instructions…');
    void request<{instructions: string}>('/api/workspace/preferences', 'PUT', {instructions: draft, expected: saved}).then(value => {
      if(current===revision.current){setSaved(value.instructions); setStatus('Instructions saved.');setEditing(false);}
    }).catch(reason => { if(current===revision.current){setError(true); setStatus(reason instanceof Error ? reason.message : 'Save could not be confirmed. Reload settings before retrying.');} })
      .finally(() => {if(current===revision.current)setBusy(false);});
  }}>
    <label for="user-workspace-instructions">How should your assistant respond?</label>
    <textarea id="user-workspace-instructions" autoFocus maxLength={8000} rows={6} value={draft} disabled={busy || saved === undefined} placeholder="Tell your assistant what works best for you." onInput={event => setDraft(event.currentTarget.value)} />
    <div class="user-page-actions"><button type="button" disabled={busy} onClick={cancelEdit}>Cancel</button><button type="submit" disabled={busy || saved === undefined || draft === saved}>Save instructions</button></div>
    {status ? <div role={error ? 'alert' : 'status'} aria-live="polite">{status}</div> : null}
  </form></ModalShell></section></>;
}
