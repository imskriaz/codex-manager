import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DashboardPeerView } from '../../src/domain/dashboard/types';
import { normalizeSystemStatus } from '../../src/domain/systemStatus';
import { getSensitiveDisplayValue } from './helpers';
import { useAnchoredPopover } from './anchoredPopover';

type Peer = Pick<DashboardPeerView, 'id' | 'name' | 'connected' | 'local'> & Partial<Pick<DashboardPeerView, 'sessionCount' | 'systemStatus'>>;
const bytes = (value: number) => value >= 1024 ** 4 ? `${(value / 1024 ** 4).toFixed(1)} TB` : `${(value / 1024 ** 3).toFixed(1)} GB`;
const uptime = (seconds: number) => seconds >= 86400 ? `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h` : seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : `${Math.floor(seconds / 60)}m`;

function StatusIcon({ kind }: { kind: 'battery' | 'network' | 'cpu' | 'memory' | 'disk' | 'uptime' }) {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">{kind === 'battery' ? <><rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10v4M6 10v4m3-4v4m3-4v4"/></> : kind === 'network' ? <><path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0m-9 4a5 5 0 0 1 6 0"/><circle cx="12" cy="20" r="1"/></> : kind === 'cpu' ? <><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/></> : kind === 'memory' ? <><rect x="3" y="6" width="18" height="11" rx="2"/><path d="M7 10v3m5-3v3m5-3v3M6 17v4m4-4v4m4-4v4m4-4v4"/></> : kind === 'disk' ? <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 14h18m-5 3h2"/></> : <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>}</svg>;
}

export function SystemStatusRows({ peer, connected, counts }: { peer: Peer; connected: boolean; counts?: { accounts?: number; sessions?: number } }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const status = normalizeSystemStatus(peer.systemStatus);
  if (!status) return null;
  const saved = !connected || now - status.observedAt > 90_000;
  const title = `${saved ? 'Saved reading · ' : ''}Updated ${new Date(status.observedAt).toLocaleTimeString()}. Network indicates an active host adapter; internet reachability is not measured. Disk is the system home volume. CPU is sampled between updates.`;
  return <div class={`system-status-rows ${saved ? 'is-saved' : ''}`} aria-label={`${saved ? 'Saved' : 'Current'} system statistics`} title={title}>
    <div>{counts ? <><span>{counts.accounts ?? "—"} accounts</span><span>{counts.sessions ?? "—"} sessions</span></> : null}{status.battery ? <span aria-label={`Battery ${status.battery.percent}%${status.battery.charging ? ', charging' : ''}`} class={status.battery.percent <= 20 ? 'is-low' : ''}><StatusIcon kind="battery"/>{status.battery.percent}%{status.battery.charging ? counts ? <svg width="10" height="12" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true"><path d="M7 0 1 9h4l-1 7 7-10H7z"/></svg> : ' Charging' : ''}</span> : null}{!counts ? status.networkConnected !== undefined ? <span aria-label={status.networkConnected ? 'Network connected' : 'Network offline'}><StatusIcon kind="network"/>{status.networkConnected ? 'Connected' : 'Offline'}</span> : null : null}{status.uptimeSeconds !== undefined ? <span aria-label={`Uptime ${uptime(status.uptimeSeconds)}`}><StatusIcon kind="uptime"/>{uptime(status.uptimeSeconds)}</span> : null}{saved && !counts ? <small>Saved</small> : null}</div>
    <div>{counts && status.networkConnected !== undefined ? <span aria-label={status.networkConnected ? "Network connected" : "Network offline"} title={status.networkConnected ? "Network connected" : "Network offline"}><StatusIcon kind="network"/></span> : null}{status.cpuPercent !== undefined ? <span><StatusIcon kind="cpu"/>CPU {Math.round(status.cpuPercent)}%</span> : null}{status.memoryUsed !== undefined && status.memoryTotal ? <span aria-label={`RAM ${bytes(status.memoryUsed)} of ${bytes(status.memoryTotal)}`}><StatusIcon kind="memory"/>RAM {Math.round(status.memoryUsed / status.memoryTotal * 100)}%</span> : null}{status.diskFree !== undefined ? <span aria-label={`Disk ${bytes(status.diskFree)} free${status.diskTotal ? ` of ${bytes(status.diskTotal)}` : ''}`}><StatusIcon kind="disk"/>{bytes(status.diskFree)} free</span> : null}</div>
  </div>;
}

export function SystemPicker(props: { anchor: { current: HTMLButtonElement | null }; systemInfoEnabled: boolean; peers: Peer[]; selectedId: string; connected: boolean; privacyMode: boolean; accountCount: (peer: Peer) => number | undefined; onSelect: (id: string) => void; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(props.onClose); closeRef.current = props.onClose;
  const close = (restoreFocus = false) => { closeRef.current(); if (restoreFocus) props.anchor.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    const menu = panel.current, trigger = props.anchor.current;
    if (!menu || !trigger) return;
    const resize = () => { menu.style.width = `${Math.max(280, (trigger.parentElement?.getBoundingClientRect().width ?? 320) - 24) / (Number(document.body.style.zoom) || 1)}px`; };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(trigger.parentElement ?? trigger);
    return () => observer.disconnect();
  }, []);
  useAnchoredPopover(true, props.anchor, panel, 'start');
  useLayoutEffect(() => {
    const menu = panel.current;
    (menu?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? menu?.querySelector<HTMLButtonElement>('[role="option"]') ?? menu)?.focus({ preventScroll: true });
    const outside = (event: Event) => { if (!menu?.contains(event.target as Node) && !props.anchor.current?.contains(event.target as Node)) closeRef.current(); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside); };
  }, []);
  return <div ref={panel} popover="manual" class="system-picker-dropdown" role="listbox" aria-label="Choose system" tabIndex={-1} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const options = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
    }
  }}>
    <div class="system-picker-list">{props.peers.map(peer => <button type="button" role="option" tabIndex={peer.id === props.selectedId ? 0 : -1} key={peer.id} class={`system-picker-item ${peer.id === props.selectedId ? 'is-selected' : ''}`} aria-selected={peer.id === props.selectedId} onClick={() => { props.onSelect(peer.id); close(true); }}>
      <div class="system-picker-heading"><strong>{getSensitiveDisplayValue(peer.name, props.privacyMode, 'name')}</strong><span class={props.connected && peer.connected ? 'is-online' : 'is-offline'}>{props.connected && peer.connected ? 'Online' : 'Offline'}{peer.local ? ' · Local' : ''}</span></div>
      {props.systemInfoEnabled && normalizeSystemStatus(peer.systemStatus) ? <SystemStatusRows peer={peer} connected={props.connected && peer.connected} counts={{ accounts: props.accountCount(peer), sessions: peer.sessionCount }}/> : <div class="system-picker-counts"><span>{props.accountCount(peer) ?? '—'} accounts</span><span>{peer.sessionCount ?? '—'} sessions</span></div>}
    </button>)}</div>
  </div>;
}
