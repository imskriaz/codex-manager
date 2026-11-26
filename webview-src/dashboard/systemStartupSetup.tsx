import { ModalShell } from './primitives';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardHostMessage } from '../../src/domain/dashboard/types';
import type { SystemStartupCheck } from '../../src/domain/systemStartup';
import type { SendAction } from './hookTypes';
import { SettingsToggleBlock } from './components';

export function SystemStartupSetting(props: {
  enabled: boolean; connected: boolean; parentOpen: boolean; targetDeviceId?: string; targetName: string;
  sendAction: SendAction; onDisable: () => void; onEnabled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<SystemStartupCheck>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<{ id: string; action: 'checkSystemStartup' | 'enableSystemStartup'; timer: ReturnType<typeof setTimeout> }>();
  const clear = () => { if (pending.current) clearTimeout(pending.current.timer); pending.current = undefined; };
  useEffect(() => {
    setOpen(false); setVerified(false); setBusy(false); setChecking(false); setCheck(undefined); setError(''); setNotice('');
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== 'dashboard:action-result' || message.action !== pending.current?.action || message.requestId !== pending.current?.id) return;
      const action = pending.current.action;
      clear(); setBusy(false); setChecking(false);
      if (message.status !== 'completed') { setError(message.error || 'System startup could not be checked. Retry the check.'); return; }
      if (action === 'checkSystemStartup') {
        if (!message.payload?.systemStartupCheck) { setError('The system returned no check results. Retry the check.'); return; }
        setCheck(message.payload.systemStartupCheck); return;
      }
      props.onEnabled(); setNotice('System startup registration verified and enabled.'); setVerified(true);
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); clear(); };
  }, [props.targetDeviceId, props.parentOpen]);
  const request = (action: 'checkSystemStartup' | 'enableSystemStartup') => {
    if (pending.current) return;
    if (!props.connected) { setError('Reconnect to this system, then check again.'); return; }
    setError(''); setBusy(true); setChecking(action === 'checkSystemStartup');
    if (action === 'checkSystemStartup') setCheck(undefined);
    const id = props.sendAction(action, undefined, { targetDeviceId: props.targetDeviceId });
    pending.current = { id, action, timer: setTimeout(() => {
      clear(); setBusy(false); setChecking(false);
      setError(action === 'checkSystemStartup' ? 'System check timed out. No startup settings were changed. Retry the check.' : 'Verification timed out. Its outcome is unconfirmed. Refresh settings before retrying; no request was replayed.');
    }, action === 'checkSystemStartup' ? 12_000 : 30_000) };
  };
  const cancel = () => { setOpen(false); if (!verified) setNotice('System startup setup cancelled.'); };
  return <>
    <SettingsToggleBlock title="Start with system" sub="Check this system and verify startup before enabling."
      enabled={props.enabled} disabled={busy}
      onToggle={enabled => {
        setError(''); setNotice('');
        if (enabled) { setVerified(false); setCheck(undefined); setOpen(true); request('checkSystemStartup'); }
        else props.onDisable();
      }} />
    {notice ? <div class="settings-note" role="status">{notice}</div> : null}
    <ModalShell open={props.parentOpen && open} title="Set up system startup" closeLabel={verified ? 'Close startup setup' : 'Cancel startup setup'} className="dashboard-modal-compact dashboard-confirm-modal" closeDisabled={busy && !checking} onClose={() => { clear(); setBusy(false); setChecking(false); cancel(); }}>
      <section class="startup-readiness" aria-label="System startup readiness" aria-busy={busy}>
        <strong>{props.targetName}</strong>
        {busy ? <p role="status">{checking ? 'Checking this system before showing setup instructions...' : 'Registering and verifying system startup...'}</p> : null}
        {verified ? <p role="status">Startup registration passed verification. Start with system is now enabled.</p> : null}
        {check && !verified ? <>
          <dl class="startup-check-results">{check.checks.map(item => <div key={item.label}>
            <dt>{item.label}</dt><dd>{item.detail}</dd>
          </div>)}</dl>
          {check.checks.some(item => item.instruction) ? <div class="startup-check-instructions">
            <strong>Next steps for this system</strong>
            <ul>{check.checks.filter(item => item.instruction).map(item => <li key={item.label}>{item.instruction}</li>)}</ul>
          </div> : <p>Prerequisite checks passed. Choose Verify and enable to register startup.</p>}
          {check.ready ? <p class="settings-note">{check.platform === 'darwin' ? 'Manager will start at your next sign-in. Allow it in macOS Login Items if prompted.' : 'Manager will try startup before sign-in, with sign-in startup as a fallback when Windows permissions require it.'} Startup stays off until registration is verified.</p> : null}
        </> : null}
        {error ? <div class="settings-note settings-notice-warning" role="alert">{error}</div> : null}
        <div class="modal-actions"><button type="button" disabled={busy && !checking} onClick={() => { clear(); setBusy(false); setChecking(false); cancel(); }}>{verified ? 'Done' : 'Cancel'}</button>
          {!verified && !busy ? <button type="button" disabled={!props.connected} onClick={() => request('checkSystemStartup')}>Check again</button> : null}
          {!verified && check?.ready ? <button type="button" class="primary" disabled={busy || !props.connected || !!error} onClick={() => request('enableSystemStartup')}>{busy ? 'Verifying...' : 'Verify and enable'}</button> : null}</div>
      </section>
    </ModalShell>
  </>;
}
