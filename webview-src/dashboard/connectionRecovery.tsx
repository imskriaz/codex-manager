import type { DashboardHostMessage, DashboardPeerView } from '../../src/domain/dashboard/types';
import { HOST_RELOAD_WAIT_MS, isDashboardHostReload, type DashboardHostReload } from '../../src/domain/dashboard/hostReload';

export type ReloadProgress = DashboardHostReload & { disconnected?: boolean; receivedAt: number };
export type Reloads = Record<string, ReloadProgress>;
export type HostStatus = Extract<DashboardHostMessage, { type: 'dashboard:host-status' }>;
export type ConnectionStage = HostStatus['stage'] | 'system-offline' | 'reloading' | 'reload-slow' | 'reload-failed' | 'reload-cancelled';

export function receiveReload(current: Reloads, message: DashboardHostReload, now = Date.now()): Reloads {
  if (!isDashboardHostReload(message, now)) return current;
  const key = message.deviceId ?? 'local', previous = current[key];
  const previousPhase = previous?.phase as string | undefined, messagePhase = message.phase as string;
  if (previous && previous.startedAt > message.startedAt) return current;
  if (previous && previous.startedAt === message.startedAt) {
    if (previousPhase !== 'reloading' || messagePhase === 'reloading') return current;
  }
  return Object.fromEntries(Object.entries({ ...current, [key]: { ...message, disconnected: previous?.startedAt === message.startedAt && previous.disconnected, receivedAt: previous?.startedAt === message.startedAt ? previous.receivedAt : now } })
    .sort((a, b) => b[1].receivedAt - a[1].receivedAt).slice(0, 32));
}

export function reconcileReloads(current: Reloads, peers: DashboardPeerView[], transportLost = false): Reloads {
  let changed = false;
  const next: Reloads = {};
  for (const [key, reload] of Object.entries(current)) {
    const peer = key === 'local' ? peers.find(item => item.local) : peers.find(item => item.id === key);
    const disconnected = transportLost || peer?.connected === false;
    if (!transportLost && peer?.connected && reload.disconnected) { changed = true; continue; }
    next[key] = disconnected && !reload.disconnected ? { ...reload, disconnected: true } : reload;
    changed ||= next[key] !== reload;
  }
  return changed ? next : current;
}

export function reloadStage(reload: ReloadProgress, now: number): ConnectionStage {
  return reload.phase === 'failed' ? 'reload-failed' : reload.phase === 'cancelled' ? 'reload-cancelled'
    : now - reload.receivedAt >= HOST_RELOAD_WAIT_MS ? 'reload-slow' : 'reloading';
}

export function connectionCopy(stage: ConnectionStage, system = 'Selected system', transition?: string) {
  switch (stage) {
    case 'offline': return { title: 'This device is offline', detail: 'Your browser reports no network connection. Reconnect this device; we’ll check again automatically.' };
    case 'system-offline': return { title: `${system} is offline`, detail: 'This system stopped checking in. Its network, power, and VS Code status are not confirmed. Open VS Code there to reconnect.' };
    case 'reloading': return { title: transition ? 'Switching accounts · reloading' : 'Reloading VS Code', detail: `${transition ? `${transition} ` : ''}A brief disconnect is expected. We’ll reconnect automatically.` };
    case 'reload-slow': return { title: 'Reload is taking longer than expected', detail: `${transition ? `${transition} ` : ''}The system has not reconnected after 90 seconds. Check VS Code there, then check the connection again. The account switch will not be repeated.` };
    case 'reload-failed': return { title: 'VS Code could not reload', detail: `${transition ? `${transition} ` : ''}Run Developer: Reload Window on that system to finish applying the change. Check the current account before switching again.` };
    case 'reload-cancelled': return { title: 'Automatic reload was cancelled', detail: 'Automatic reload is disabled. Reload VS Code on that system to apply the pending account change.' };
    case 'degraded': return { title: 'Live updates are unavailable', detail: 'Saved data is available, but the live connection is not ready. Actions are paused while we reconnect.' };
    case 'connecting': return { title: 'Connecting to the dashboard', detail: 'Waiting for the system to respond. Your current view stays open.' };
    case 'reconnecting': return { title: 'Reconnecting to the dashboard', detail: 'The live connection was interrupted. The cause is not confirmed; we’re checking automatically.' };
    default: return { title: 'Dashboard connection unavailable', detail: 'The dashboard is not responding. The cause is not confirmed. Check the system’s connection and that Codex Manager is running.' };
  }
}

export function ConnectionRecovery(props: {
  stage: ConnectionStage; compact?: boolean; system?: string; transition?: string; lastSyncAt?: number;
  status?: HostStatus; onRetry: () => void; onDismiss?: () => void;
}) {
  const copy = props.stage === 'degraded' && props.status?.stage === 'live'
    ? { title: 'Displayed data may be stale', detail: 'The live connection is available. Check the connection to refresh saved data.' }
    : connectionCopy(props.stage, props.system, props.transition);
  const pending = props.status?.retrying === true;
  const progress = props.stage === 'reloading' || pending;
  return <section class={`dashboard-connection-recovery ${props.compact ? 'is-inline' : ''} is-${props.stage}`} aria-label="Connection status">
    <div class="connection-heading" role="status" aria-live="polite" aria-atomic="true">
      <span class={progress ? 'dashboard-connection-progress' : 'connection-state-mark'} aria-hidden="true" />
      <h1>{copy.title}</h1>
    </div>
    <p>{copy.detail}</p>
    {props.stage !== 'offline' && props.status?.stage === 'offline' ? <p class="connection-detail">Your browser also reports no network connection.</p> : null}
    {props.status?.detail ? <p class="connection-detail" role="status">{props.status.detail}</p> : null}
    <div class="connection-meta"><span>{props.lastSyncAt ? `Saved view · last update ${new Date(props.lastSyncAt).toLocaleTimeString()}` : 'Waiting for verified data'}</span></div>
    <div class="connection-actions">
      <button type="button" disabled={pending} aria-busy={pending} onClick={props.onRetry}>{pending ? 'Checking…' : 'Check connection'}</button>
      {props.onDismiss ? <button type="button" class="connection-dismiss" onClick={props.onDismiss}>Continue</button> : null}
    </div>
  </section>;
}
