import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ModalShell } from './primitives';
import { maintainCliQueues, readCliQueueStatuses, type CliQueuedMessage, type CliQueueStatus } from './cliMessageQueue';

const messageStates: Record<CliQueuedMessage['state'], string> = {
  queued: 'Waiting',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  uncertain: 'Needs confirmation'
};

function queueState(queue: CliQueueStatus) {
  if (queue.error || queue.items.some(item => item.state === 'failed' || item.state === 'uncertain')) {
    return { label: 'Needs attention', tone: 'warning' };
  }
  if (queue.items.some(item => item.state === 'sending')) {
    return { label: 'Sending', tone: 'info' };
  }
  return queue.ready ? { label: 'Ready', tone: 'ready' } : { label: 'Loading', tone: 'neutral' };
}

function messageText(item: CliQueuedMessage) {
  return item.draft.text.trim() ? item.draft.text : item.draft.attachments[0]?.name ?? 'Attachment';
}

type QueueNotice = { text: string; tone: 'neutral' | 'success' | 'warning' | 'error' };

export function QueueToolsMenuItem(props: { icon?: ComponentChildren } = {}) {
  const [view, setView] = useState<'tools' | 'queues'>();
  const [queues, setQueues] = useState<CliQueueStatus[]>();
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<QueueNotice>();
  const [confirmClear, setConfirmClear] = useState(false);
  const generation = useRef(0);
  const working = useRef(false);
  const fixButton = useRef<HTMLButtonElement>(null);
  const clearDescriptionId = useId();

  useLayoutEffect(() => {
    if (view === 'queues') {
      fixButton.current?.focus();
    }
  }, [view]);

  useEffect(() => {
    if (view !== 'queues') {
      return;
    }
    let disposed = false;
    const refresh = () => {
      void readCliQueueStatuses().then(value => {
        if (!disposed) {
          setQueues(value);
          setLoadError(undefined);
        }
      }, error => {
        if (!disposed) {
          setLoadError(String(error));
        }
      });
    };
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [view]);

  const maintain = async (clear: boolean) => {
    if (working.current) {
      return;
    }
    working.current = true;
    setBusy(true);
    setNotice({ text: clear ? 'Clearing saved queues…' : 'Checking queues…', tone: 'neutral' });
    setConfirmClear(false);
    const epoch = generation.current;
    try {
      const result = await maintainCliQueues(clear);
      const updated = await readCliQueueStatuses();
      if (epoch !== generation.current) {
        return;
      }
      setQueues(updated);
      setLoadError(undefined);
      const summary = `${clear ? 'Cleared' : 'Checked'} ${result.updated} queue${result.updated === 1 ? '' : 's'}.`;
      const warning = result.skipped ? ` Could not update ${result.skipped} due to an active sender or unavailable storage.` : '';
      const detail = clear ? ' Sends already in progress continue.' : ' Unconfirmed deliveries are preserved for review.';
      setNotice({ text: summary + warning + detail, tone: result.skipped ? 'warning' : 'success' });
    } catch (error) {
      if (epoch === generation.current) {
        setNotice({ text: `Queue operation failed: ${String(error)}`, tone: 'error' });
      }
    } finally {
      working.current = false;
      if (epoch === generation.current) {
        setBusy(false);
      }
    }
  };

  const cancelClear = () => {
    setConfirmClear(false);
    setNotice({ text: 'Queue clearing cancelled.', tone: 'neutral' });
  };
  const rows = queues?.map(queue => ({ queue, state: queueState(queue) }))
    .sort((left, right) => Number(right.state.tone === 'warning') - Number(left.state.tone === 'warning'));
  const total = queues?.reduce((count, queue) => count + queue.items.length, 0) ?? 0;
  const attention = rows?.filter(({ state }) => state.tone === 'warning').length ?? 0;

  return <>
    <button type="button" role="menuitem" onClick={() => {
      setQueues(undefined);
      setLoadError(undefined);
      setNotice(undefined);
      setView('tools');
    }}>{props.icon}Tools</button>
    <ModalShell
      open={!!view}
      title={view === 'queues' ? 'Queue status' : 'Tools'}
      closeLabel={view === 'queues' ? 'Close queue status' : 'Close tools'}
      className={view === 'queues' ? 'dashboard-modal-compact queue-tools-modal' : 'dashboard-modal-compact'}
      closeDisabled={busy}
      onClose={() => { generation.current++; setView(undefined); setConfirmClear(false); }}
    >
      {view === 'tools' ? (
        <button type="button" class="queue-tools-entry" onClick={() => setView('queues')}>
          <strong>Queue status</strong>
          <small>Inspect, repair or clear this browser's saved message queues.</small>
        </button>
      ) : (
        <div class="queue-tools-content">
          <div class="queue-tools-toolbar">
            <div class="queue-tools-summary" role="status">
              {rows ? <>
                <span><strong>{rows.length}</strong> {rows.length === 1 ? 'queue' : 'queues'}</span>
                <span><strong>{total}</strong> {total === 1 ? 'message' : 'messages'}</span>
                {attention > 0 ? <span class="is-warning"><strong>{attention}</strong> {attention === 1 ? 'needs attention' : 'need attention'}</span> : null}
              </> : loadError ? null : <span>Loading queues…</span>}
            </div>
            <div class="queue-tools-actions">
              <button ref={fixButton} type="button" class="modal-primary-btn" disabled={busy} onClick={() => { void maintain(false); }}>Fix queues</button>
              <button type="button" class="modal-secondary-btn queue-tools-clear" disabled={busy || !rows?.length} onClick={() => setConfirmClear(true)}>Clear all</button>
            </div>
          </div>
          <div class="queue-tools-feedback" role="status">
            {notice ? <p class={`queue-tools-notice is-${notice.tone}`}>{notice.text}</p> : null}
          </div>
          {loadError ? <p class="queue-tools-notice is-error" role="alert">Could not read saved queues: {loadError}</p> : null}
          {rows?.length ? <div class="queue-tools-list">
            {rows.map(({ queue, state }) => (
              <details key={queue.scope}>
                <summary tabIndex={0}>
                  <span class="queue-tools-row-copy">
                    <span class="queue-tools-preview" title={queue.scope}>
                      {queue.items[0] ? messageText(queue.items[0]) : queue.error ? 'Queue unavailable' : 'Empty queue'}
                    </span>
                    <span class="queue-tools-meta">
                      {queue.active ? 'Open queue' : 'Saved queue'} · {queue.items.length} {queue.items.length === 1 ? 'message' : 'messages'}
                    </span>
                  </span>
                  <span class={`queue-tools-state is-${state.tone}`}>{state.label}</span>
                </summary>
                <div class="queue-tools-details">
                  {queue.error ? <p class="queue-tools-notice is-error" role="alert">{queue.error}</p> : null}
                  {queue.items.map(item => (
                    <article key={item.id}>
                      <strong class={`queue-tools-item-state is-${item.state}`}>{messageStates[item.state]}</strong>
                      <p>{messageText(item)}</p>
                      {item.error ? <p class="queue-tools-item-error">{item.error}</p> : null}
                    </article>
                  ))}
                </div>
              </details>
            ))}
          </div> : rows && !loadError ? <p class="queue-tools-empty">No saved message queues.</p> : null}
        </div>
      )}
    </ModalShell>
    <ModalShell
      open={!!view && confirmClear}
      title="Clear all saved queues?"
      closeLabel="Cancel clearing queues"
      className="dashboard-modal-compact dashboard-confirm-modal"
      closeDisabled={busy}
      onClose={cancelClear}
    >
      <p class="dialog-description" id={clearDescriptionId}>Remove waiting and saved messages in this browser. Sends already in progress continue.</p>
      <div class="dialog-actions">
        <button type="button" class="modal-secondary-btn" disabled={busy} onClick={cancelClear}>Cancel</button>
        <button type="button" class="modal-primary-btn queue-tools-confirm-clear" aria-describedby={clearDescriptionId} disabled={busy} onClick={() => { void maintain(true); }}>Clear all</button>
      </div>
    </ModalShell>
  </>;
}
