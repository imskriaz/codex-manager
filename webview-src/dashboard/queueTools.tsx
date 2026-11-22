import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ModalShell } from './primitives';
import { maintainCliQueues, readCliQueueStatuses, type CliQueueStatus } from './cliMessageQueue';

export function QueueToolsMenuItem(props: { icon?: ComponentChildren } = {}) {
  const [view, setView] = useState<'tools' | 'queues'>(), [queues, setQueues] = useState<CliQueueStatus[]>([]);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [confirmClear, setConfirmClear] = useState(false);
  const generation = useRef(0), working = useRef(false);
  useEffect(() => {
    if (view !== 'queues') return;
    let disposed = false;
    const refresh = () => { void readCliQueueStatuses().then(value => { if (!disposed) setQueues(value); }, error => { if (!disposed) setNotice(String(error)); }); };
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [view]);
  const maintain = async (clear: boolean) => {
    if (working.current) return;
    working.current = true; setBusy(true); setConfirmClear(false);
    const epoch = generation.current;
    try {
      const result = await maintainCliQueues(clear);
      const updated = await readCliQueueStatuses();
      if (epoch !== generation.current) return;
      setQueues(updated);
      setNotice(`${clear ? 'Cleared' : 'Checked'} ${result.updated} queue${result.updated === 1 ? '' : 's'}.${result.skipped ? ` ${result.skipped} could not be changed; an active sender or unavailable storage may own them.` : ''}${clear ? ' Sends already in progress continue.' : ' Unconfirmed deliveries are preserved for review.'}`);
    } catch (error) { if (epoch === generation.current) setNotice(`Queue operation failed: ${String(error)}`); }
    finally { working.current = false; if (epoch === generation.current) setBusy(false); }
  };
  const total = queues.reduce((count, queue) => count + queue.items.length, 0);
  return <>
    <button type="button" role="menuitem" onClick={() => { setView('tools'); setNotice(''); }}>{props.icon}Tools</button>
    <ModalShell open={!!view} title={view === 'queues' ? 'Queue status' : 'Tools'} closeLabel="Close tools" className="dashboard-modal-compact queue-tools-modal" closeDisabled={busy} onClose={() => { generation.current++; setView(undefined); setConfirmClear(false); }}>
      {view === 'tools' ? <button type="button" class="queue-tools-entry" onClick={() => setView('queues')}><strong>Queue status</strong><small>Inspect, repair or clear this browser's saved message queues.</small></button> : <div class="queue-tools-content">
        <p role="status">{queues.length} {queues.length === 1 ? 'queue' : 'queues'} · {total} {total === 1 ? 'message' : 'messages'}</p>
        <div class="queue-tools-actions"><button type="button" disabled={busy} onClick={() => { void maintain(false); }}>Fix queues</button><button type="button" disabled={busy || !queues.length} onClick={() => setConfirmClear(true)}>Clear all</button></div>

        {notice ? <p role="status">{notice}</p> : null}
        <div class="queue-tools-list">{queues.map(queue => <details key={queue.scope}>
          <summary><strong>{queue.items.length} {queue.items.length === 1 ? 'message' : 'messages'}</strong><span>{queue.active ? 'Open' : 'Saved'} · {queue.error || queue.items.some(item => item.state === 'failed' || item.state === 'uncertain') ? 'Needs attention' : queue.items.some(item => item.state === 'sending') ? 'Sending' : queue.ready ? 'Ready' : 'Loading'}</span></summary>
          <small class="queue-tools-scope" title={queue.scope}>{queue.items[0]?.draft.text.slice(0, 120) || 'Saved conversation'}</small>
          {queue.error ? <p role="alert">{queue.error}</p> : null}
          {queue.items.map(item => <article key={item.id}><span>{item.state === 'uncertain' ? 'Needs confirmation' : item.state}</span><p>{item.draft.text || item.draft.attachments[0]?.name || 'Attachment'}</p>{item.error ? <small>{item.error}</small> : null}</article>)}
        </details>)}</div>
      </div>}
    </ModalShell>
    <ModalShell open={!!view&&confirmClear} title="Clear all saved queues?" closeLabel="Cancel clearing queues" className="dashboard-modal-compact dashboard-confirm-modal" closeDisabled={busy} onClose={()=>{setConfirmClear(false);setNotice('Queue clearing cancelled.');}}><p>Remove all waiting and saved messages in this browser? Sends already in progress continue.</p><div class="dialog-actions"><button type="button" disabled={busy} onClick={()=>{setConfirmClear(false);setNotice('Queue clearing cancelled.');}}>Cancel</button><button type="button" disabled={busy} onClick={()=>void maintain(true)}>Confirm clear all</button></div></ModalShell>
  </>;
}
