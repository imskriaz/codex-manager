import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardActionPayload, DashboardHostMessage, DashboardSettings, WorkspaceRuntime } from '../../src/domain/dashboard/types';
import { SettingsToggleBlock } from './components';
import { ModalShell } from './primitives';
import type { SendAction } from './hookTypes';

export function requestWorkspaceRuntime(send: SendAction, request: NonNullable<DashboardActionPayload['runtimeRequest']>, signal?: AbortSignal): Promise<WorkspaceRuntime> {
  return new Promise((resolve, reject) => {
    let id: string;
    const finish = () => { clearTimeout(timer); window.removeEventListener('message', receive); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { finish(); reject(new Error('Stopped waiting for runtime setup. Its outcome is unconfirmed; check the host before retrying.')); };
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== 'dashboard:action-result' || message.action !== 'manageWorkspaceRuntime' || message.requestId !== id) return;
      finish();
      if (message.status !== 'completed' || message.payload?.workspaceRuntime?.provider !== request.provider) reject(new Error(message.error || 'Runtime setup was not confirmed. Check the host before retrying.'));
      else resolve(message.payload.workspaceRuntime);
    };
    const timer = setTimeout(() => { finish(); reject(new Error('Runtime setup timed out. Its outcome is unconfirmed; check the host before retrying.')); }, 120_000);
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    window.addEventListener('message', receive);
    try { id = send('manageWorkspaceRuntime', undefined, { runtimeRequest: request }); }
    catch (error) { finish(); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}

function RuntimeModule(props: { provider: 'codex' | 'claude'; enabled: boolean; connected: boolean; parentOpen: boolean; sendAction: SendAction; onEnabled: () => void; onDisable: () => void }) {
  const [runtime, setRuntime] = useState<WorkspaceRuntime>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; message: string }>();
  const controller = useRef<AbortController>();
  useEffect(() => () => controller.current?.abort(), []);
  const label = props.provider === 'codex' ? 'Codex' : 'Claude';
  const enable = async () => {
    if (busy) return;
    setOpen(true); setRuntime(undefined);
    if (!props.connected) { setNotice({ error: true, message: 'Reconnect to this host before enabling this module.' }); return; }
    const active = new AbortController(); controller.current = active;
    setBusy(true); setNotice({ error: false, message: `Checking ${label}. If missing, its runtime will be downloaded separately and verified. This may take up to two minutes...` });
    try {
      const detected = await requestWorkspaceRuntime(props.sendAction, { provider: props.provider, operation: 'check' }, active.signal);
      if (active.signal.aborted) return;
      setNotice({ error: false, message: detected.available ? `Existing ${label} verified. Enabling module...` : `${label} is missing. Downloading and verifying its runtime...` });
      const result = await requestWorkspaceRuntime(props.sendAction, { provider: props.provider, operation: 'enable' }, active.signal);
      if (active.signal.aborted) return;
      if (!result.enabled) throw new Error('The host did not confirm the module was enabled. Check Settings before retrying.');
      setRuntime(result); setNotice({ error: false, message: result.message }); props.onEnabled();
    } catch (error) {
      if (!active.signal.aborted) setNotice({ error: true, message: error instanceof Error ? error.message : 'Module setup could not be confirmed.' });
    } finally { if (!active.signal.aborted) setBusy(false); }
  };
  const close = () => {
    if (busy) return;
    setOpen(false);
    if (!runtime?.enabled) setNotice({ error: false, message: `${label} setup closed. The module was not confirmed enabled. Check its switch before retrying.` });
  };
  return <>
    <SettingsToggleBlock title={label} sub={`Optional ${label} sessions. Enabling checks for an existing runtime and installs it separately if missing. Requires Node.js with npm, internet access and free disk space on the host PC.`} enabled={props.enabled} disabled={busy || !props.connected}
      onToggle={enabled => { if (enabled) void enable(); else props.onDisable(); }} />
    {!open && notice ? <p class="settings-note" role={notice.error ? 'alert' : 'status'}>{notice.message}</p> : null}
    <ModalShell open={props.parentOpen && open} title={`Set up ${label} module`} closeLabel={`Close ${label} setup`} className="dashboard-modal-compact dashboard-confirm-modal" closeDisabled={busy} onClose={close}>
      <p>Manager uses {label} on the host PC. Existing installations are reused; missing runtimes are downloaded into Manager's data folder. The module stays off until verification succeeds.</p>
      <p>Authentication is separate from installation. Use the host PC, even when viewing this dashboard from another device.</p>
      <a href={props.provider === 'codex' ? 'https://developers.openai.com/codex/cli/' : 'https://code.claude.com/docs/en/setup'} target="_blank" rel="noopener noreferrer">Official {label} installation instructions</a>
      {notice ? <p class={`settings-note ${notice.error ? 'settings-notice-warning' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.message}</p> : null}
      {runtime?.loginCommand ? <p class="settings-note">Sign in on this host (PowerShell on Windows, a terminal on macOS/Linux): <code style={{ overflowWrap: 'anywhere' }}>{runtime.loginCommand}</code>. Then refresh the model list. Existing API-key accounts can also authenticate new turns.</p> : null}
      <div class="modal-actions"><button type="button" disabled={busy} onClick={close}>{runtime?.enabled ? 'Done' : 'Close'}</button>
        {notice?.error ? <button type="button" class="primary" disabled={busy || !props.connected} onClick={() => void enable()}>Retry setup</button> : null}</div>
    </ModalShell>
  </>;
}

export function WorkspaceRuntimeSettings(props: { settings: DashboardSettings; connected: boolean; parentOpen: boolean; targetDeviceId?: string; sendAction: SendAction; onEnabled: (provider: 'codex' | 'claude') => void; onDisable: (provider: 'codex' | 'claude') => void }) {
  const remote = !!props.targetDeviceId && props.targetDeviceId !== 'local';
  return <section class="settings-block settings-block-wide" aria-label="Session modules">
    <div class="settings-block-head"><h3 class="settings-block-title">Session modules</h3><p class="settings-block-sub">Enable Codex and Claude separately. Their runtimes are downloaded only when needed, outside the extension package. Workspace files and terminals work independently.</p></div>
    {remote ? <p class="settings-note" role="status">Open this system's own dashboard and sign in as master to set up its modules.</p> : null}
    {(['codex', 'claude'] as const).map(provider => <RuntimeModule key={`${props.targetDeviceId ?? 'local'}-${provider}`} provider={provider} enabled={props.settings[`${provider}ModuleEnabled`] === true} parentOpen={props.parentOpen} connected={props.connected && !remote} sendAction={props.sendAction} onEnabled={() => props.onEnabled(provider)} onDisable={() => props.onDisable(provider)} />)}
  </section>;
}
