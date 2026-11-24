import type { ComponentProps } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SavedAccountCard } from './savedAccountCard';
import { useAnchoredPopover } from './anchoredPopover';
import { getSensitiveDisplayValue } from './helpers';
import { renderRefreshIcon, renderRemoveIcon, renderSwitchIcon } from './icons';
import { ActionButton } from './primitives';

export function ApiAccountCard(props: ComponentProps<typeof SavedAccountCard>) {
  const { account, copy, onAction } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const menuContent = useRef<HTMLDivElement>(null);
  useAnchoredPopover(menuOpen, menuAnchor, menuContent);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!menuAnchor.current?.contains(event.target as Node) && !menuContent.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuOpen(false); menuAnchor.current?.focus(); }
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [menuOpen]);

  const name = getSensitiveDisplayValue(account.displayName || account.email, props.privacyMode, 'name');
  const label = `API Key: ${account.authProviderLabel} · ${name}`;
  const stateClass = [account.isActive ? 'active' : '', !account.enabled ? 'account-disabled' : '', props.selected ? 'selected' : '', menuOpen ? 'has-open-menu' : ''].filter(Boolean).join(' ');
  const offline = props.connected === false;
  const selectionLabel = props.selected ? copy.deselectAccount : copy.selectAccount;
  const selection = <button class={`saved-select-toggle ${props.selected ? 'selected' : ''}`} type="button" aria-pressed={props.selected} aria-label={selectionLabel} title={selectionLabel} onClick={props.onToggleSelected}><span class="saved-select-toggle-mark" aria-hidden="true"></span></button>;
  const metadata = <><span class="pill plan saved-plan-badge">API</span><span class="saved-credits-line" title={`${account.authProviderLabel} · ${name}`}>{account.authProviderLabel} · {name}</span></>;
  const starLabel = account.queuePriority ? 'Unstar API account' : 'Star API account';
  const enableLabel = account.enabled ? 'Disable API account' : 'Enable API account';
  const primary = <>
    <button class={`saved-control saved-queue-priority-toggle ${account.queuePriority ? 'is-prioritized' : ''}`} type="button" title={starLabel} aria-label={starLabel} aria-pressed={account.queuePriority} aria-busy={props.queuePriorityPending} disabled={offline || props.queuePriorityPending} onClick={() => onAction('setAccountQueuePriority', account.id, { queuePriority: !account.queuePriority })}><span aria-hidden="true">{account.queuePriority ? '★' : '☆'}</span></button>
    <div class="saved-enabled-control-wrap"><button class={`saved-control saved-enabled-toggle ${account.enabled ? 'is-checked' : ''}`} type="button" title={enableLabel} aria-label={enableLabel} aria-pressed={account.enabled} aria-busy={props.enabledPending} disabled={offline || props.enabledPending} onClick={() => onAction('toggleAccountEnabled', account.id, { enabled: !account.enabled })}>
      {props.enabledPending ? <span class="saved-toggle-spinner" aria-hidden="true"></span> : <span class="saved-enabled-toggle-indicator" aria-hidden="true"><span></span></span>}
    </button></div>
  </>;
  const secondary = <>
    <ActionButton icon={renderSwitchIcon()} iconOnly label={account.isActive ? 'Selected API account' : 'Select API account'} pending={props.switchPending} disabled={offline || props.switchPending || account.isActive || !account.enabled} onClick={() => onAction('switch', account.id)} />
    <ActionButton icon={renderRefreshIcon()} iconOnly label="Verify API key" pending={props.refreshPending} disabled={offline || props.refreshPending} onClick={() => onAction('refresh', account.id)} />
    <div class="saved-overflow-wrap">
      <button ref={menuAnchor} class={`saved-overflow-trigger ${menuOpen ? 'active' : ''}`} type="button" aria-label="More account actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>•••</button>
      {menuOpen ? createPortal(<div ref={menuContent} class="saved-overflow-menu saved-overflow-menu-portal" role="menu">
        <div class="saved-api-details">{account.authProviderLabel} · {name}<br />{props.privacyMode ? 'Key hidden' : account.apiKeyHint}<br />{account.apiBaseUrl}</div>
        <button type="button" role="menuitem" disabled={offline || props.removePending} onClick={() => { setMenuOpen(false); onAction('remove', account.id); }}>{renderRemoveIcon()}<span>Remove account</span></button>
      </div>, document.body) : null}
    </div>
  </>;
  const { input, output, cachedInput } = account.apiTokenUsage ?? {};
  const cached = input !== undefined && cachedInput !== undefined ? Math.min(input, cachedInput) : undefined;
  const fresh = input !== undefined && cached !== undefined ? input - cached : undefined;
  const count = (value?: number) => value === undefined ? 'Not recorded' : value.toLocaleString(props.lang);
  const inputDescription = `Recorded input: ${count(input)}; Fresh: ${count(fresh)}; Cached: ${count(cached)}. Recorded Manager sessions; not provider-wide billing.`;
  const metrics = <>
    <div class="row">
      <div class="row-head"><div class="label-wrap"><span class="metric-label">Input tokens</span></div><div class="metric-row-summary"><span class="metric-reset-inline" title={inputDescription}>{count(input)}</span></div></div>
      <div class="bar saved-api-token-bar" role="img" aria-label={inputDescription} title={inputDescription}>
        <span class="saved-api-fresh" style={{ width: input && fresh !== undefined ? `${fresh / input * 100}%` : '0%' }}></span><span class="saved-api-cached" style={{ width: input && cached !== undefined ? `${cached / input * 100}%` : '0%' }}></span>
      </div>
      <div class="foot saved-api-token-legend"><span class="saved-api-fresh-label">Fresh {count(fresh)}</span><span class="saved-api-cached-label">Cached {count(cached)}</span></div>
    </div>
    <div class="row">
      <div class="row-head"><div class="label-wrap"><span class="metric-label">Output tokens</span></div><div class="metric-row-summary"><span class="metric-reset-inline" title="Output tokens recorded in Manager sessions; not provider-wide billing.">{count(output)}</span></div></div>
      <div class="bar saved-api-token-bar" role="img" aria-label={`Recorded output tokens: ${count(output)}`}><span class="saved-api-output" style={{ width: output ? '100%' : '0%' }}></span></div>
    </div>
  </>;

  return props.compactRow ? <article class={`saved-table-row saved-api-account ${stateClass}`} aria-label={label}>
    <div class="saved-table-identity">{selection}<div class="saved-table-name-block"><div class="saved-table-name-line"><strong title={label}>API Key</strong></div><div class="saved-table-meta">{metadata}</div></div></div>
    <div class="saved-table-metrics">{metrics}</div><div class="saved-table-actions">{primary}{secondary}</div>
  </article> : <article class={`saved-card-container saved-api-account ${stateClass}`} aria-label={label}>
    <section class="saved-card saved-card-front" aria-label={label}>
      <div class="saved-head"><div class="saved-title"><div class="saved-identity-line"><h3>{selection}<span class="saved-title-text" title={label}>API Key</span></h3></div></div><div class="saved-top-actions">{primary}</div></div>
      <div class="saved-progress">{metrics}</div><div class="saved-card-footer"><div class="saved-credit-summary">{metadata}</div><div class="saved-actions">{secondary}</div></div>
    </section>
  </article>;
}
