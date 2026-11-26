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
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<{ id: string; timer: ReturnType<typeof setTimeout> }>();
  const clear = () => { if (pending.current) clearTimeout(pending.current.timer); pending.current = undefined; };
  useEffect(() => {
    setOpen(false); setVerified(false); setBusy(false); setError(''); setNotice('');
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== 'dashboard:action-result' || message.action !== 'enableSystemStartup' || message.requestId !== pending.current?.id) return;
      clear(); setBusy(false);
      if (message.status !== 'completed') { setError(message.error || 'System startup registration was not verified. It remains off.'); return; }
      props.onEnabled(); setNotice('System startup registration verified and enabled. Windows starts at boot or sign-in; macOS starts at your next sign-in.'); setVerified(true);
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
  const cancel = () => { setOpen(false); if (!verified) setNotice('System startup setup cancelled.'); };
  return <>
    <SettingsToggleBlock title="Start with system" sub="Start the local host at Windows boot or sign-in, or at macOS sign-in. Verify setup before enabling."
      enabled={props.enabled} disabled={busy}
      onToggle={enabled => { setError(''); setNotice(''); if (enabled) { setVerified(false); setOpen(true); } else props.onDisable(); }} />
    {notice ? <div class="settings-note" role="status">{notice}</div> : null}
    <ModalShell open={props.parentOpen && open} title="Set up system startup" closeLabel={verified ? 'Close startup setup' : 'Cancel startup setup'} className="dashboard-modal-compact dashboard-confirm-modal" closeDisabled={busy} onClose={cancel}>
      <section class="startup-readiness" aria-label="System startup readiness" aria-busy={busy}>
        <div class="startup-readiness-heading"><strong>{props.targetName}</strong>
          <span role="status">{busy ? 'Checking system...' : verified ? 'Ready: startup verified' : error.startsWith('Verification timed out.') ? 'Unconfirmed: check timed out' : error ? 'Blocked: verification needed' : !props.connected ? 'Blocked: system offline' : 'Not checked'}</span></div>
        <p>{busy ? 'Registering and checking startup on the selected system. Keep this dialog open.' : verified ? 'Startup registration passed verification. Start with system is now enabled.' : error ? 'Startup is not confirmed. Review the error below before trying again.' : !props.connected ? 'Reconnect the selected system to check and enable startup.' : 'The system is connected. Choose Verify and enable to register startup and check the result.'}</p>
        {!verified ? <p class="settings-note">Startup stays off until registration is verified. This check changes startup settings on the selected system.</p> : null}
        {error ? <div class="settings-note settings-notice-warning" role="alert">{error}</div> : null}
        <div class="modal-actions"><button type="button" disabled={busy} onClick={cancel}>{verified ? 'Done' : 'Cancel'}</button>
          {!verified ? <button type="button" class="primary" disabled={busy || !props.connected} onClick={verify}>{busy ? 'Checking...' : 'Verify and enable'}</button> : null}</div>
      </section>
      <p>Need help? Follow the instructions for how Manager runs on the selected system, even when viewing from another device.</p>
      <details><summary>Windows</summary>
      <p><strong>Running in VS Code</strong></p>
      <ol><li>Close VS Code on that PC and reopen it using <strong>Run as administrator</strong>.</li>
        <li>Open Codex Manager settings again and choose <strong>Start with system</strong>.</li></ol>
      <p><strong>Running directly with Node.js</strong></p>
      <ol><li>Open Windows PowerShell as administrator, or run <code>Start-Process powershell -Verb RunAs</code> and accept the Windows prompt.</li>
        <li>In the administrator terminal, use <code>Set-Location 'C:\path\to\codex-manager'</code> with your cloned checkout's path. Node.js 22.13 or newer is required.</li>
        <li>For a new clone, run <code>npm.cmd ci</code>, then <code>npm.cmd run compile</code>.</li>
        <li>Run <code>npm.cmd run standalone:restart</code> to start or restart the standalone host from this checkout, then reopen its browser dashboard and choose <strong>Start with system</strong>.</li></ol>
      <p>Choose <strong>Verify and enable</strong> above. Manager registers and checks Windows startup before enabling this setting. Administrator access allows startup before sign-in; Windows may otherwise allow only startup at sign-in.</p>
      </details>
      <details><summary>macOS</summary>
        <p><strong>Using the VS Code extension</strong>: open Manager settings on the Mac, choose <strong>Start with system</strong>, then <strong>Verify and enable</strong>. Use your normal signed-in account; administrator access and sudo are unnecessary.</p>
        <p><strong>Using a Node.js clone</strong>: in Terminal, run <code>cd /path/to/codex-manager</code>. For a new clone, run <code>npm ci</code> and <code>npm run compile</code>, then start it with <code>npm start -- --background</code>. To restart an existing standalone host, use <code>npm run standalone:restart</code>. Requires Node.js 22.13 or newer.</p>
        <p>Open the Mac's browser dashboard and choose <strong>Verify and enable</strong>. Manager saves a validated LaunchAgent in <code>~/Library/LaunchAgents</code> for your next sign-in. It does not start before sign-in. Allow Manager in macOS Login Items if prompted. Keep the clone and Node.js at their registered paths.</p>
      </details>
      <p>Always Active keeps the host running after VS Code closes and works separately from system startup. A direct Node.js host runs without VS Code.</p>
    </ModalShell>
  </>;
}
