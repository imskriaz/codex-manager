import { ModalShell } from './primitives';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardHostMessage } from '../../src/domain/dashboard/types';
import type { SendAction } from './hookTypes';
import { SettingsToggleBlock } from './components';

export function SystemStartupSetting(props: {
  enabled: boolean; connected: boolean; parentOpen: boolean; targetDeviceId?: string; targetName: string;
  sendAction: SendAction; onDisable: () => void; onEnabled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<{ id: string; timer: ReturnType<typeof setTimeout> }>();
  const clear = () => { if (pending.current) clearTimeout(pending.current.timer); pending.current = undefined; };
  useEffect(() => {
    setOpen(false); setBusy(false); setError(''); setNotice('');
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== 'dashboard:action-result' || message.action !== 'enableSystemStartup' || message.requestId !== pending.current?.id) return;
      clear(); setBusy(false);
      if (message.status !== 'completed') { setError(message.error || 'Windows boot startup was not verified. It remains off.'); return; }
      props.onEnabled(); setNotice('Windows boot startup verified and enabled.'); setOpen(false);
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); clear(); };
  }, [props.targetDeviceId, props.parentOpen]);
  const verify = () => {
    if (pending.current) return;
    if (!props.connected) { setError('Reconnect to this system before verifying startup.'); return; }
    setError(''); setBusy(true);
    const id = props.sendAction('enableSystemStartup', undefined, { targetDeviceId: props.targetDeviceId });
    pending.current = { id, timer: setTimeout(() => {
      clear(); setBusy(false); setError('Verification timed out. Its outcome is unconfirmed. Refresh settings before retrying; no request was replayed.');
    }, 30_000) };
  };
  const cancel = () => { setOpen(false); setNotice('Windows boot startup setup cancelled.'); };
  return <>
    <SettingsToggleBlock title="Start with system" sub="Start the local host when Windows boots, before sign-in. Setup must be verified before enabling."
      enabled={props.enabled} disabled={busy}
      onToggle={enabled => { setError(''); setNotice(''); if (enabled) setOpen(true); else props.onDisable(); }} />
    {notice ? <div class="settings-note" role="status">{notice}</div> : null}
    <ModalShell open={props.parentOpen && open} title="Set up Windows boot startup" closeLabel="Cancel startup setup" className="dashboard-modal-compact dashboard-confirm-modal" closeDisabled={busy} onClose={cancel}>
      <strong>Windows boot startup</strong>
      <p>Set up startup on <strong>{props.targetName}</strong>. The switch stays off until Windows confirms registration.</p>
      <ol><li>On this PC, close VS Code and reopen it using <strong>Run as administrator</strong>.</li>
        <li>Open Codex Manager settings again and choose <strong>Start with system</strong>.</li>
        <li>Choose <strong>Verify and enable</strong> below. Manager registers and checks the Windows boot task before enabling this setting.</li></ol>
      <p>Always Active keeps the host running after VS Code closes and works separately from Windows boot startup.</p>
      {error ? <div class="settings-note settings-notice-warning" role="alert">{error}</div> : null}
      {busy ? <p role="status">Registering and verifying Windows boot startup…</p> : null}
      <div class="modal-actions"><button type="button" disabled={busy} onClick={cancel}>Cancel</button>
        <button type="button" class="primary" disabled={busy || !props.connected} onClick={verify}>{busy ? 'Verifying…' : 'Verify and enable'}</button></div>
    </ModalShell>
  </>;
}
