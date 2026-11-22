import { useEffect, useRef, useState } from 'preact/hooks';
import type { OfficeMemory } from '../../src/domain/officeMemory';
import { request } from './teamSettingsRequest';
import { userWorkspaceNotice } from './userWorkspacePresentation';
import { ModalShell } from './primitives';
import { ToolIcon } from './icons';

export function UserWorkspaceMemory({ open, owner }: { open: boolean; owner: string }) {
  const [memory, setMemory] = useState<OfficeMemory>();
  const [draft, setDraft] = useState(''), [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<{id?: string; text?: string}>();
  const [pendingEnabled, setPendingEnabled] = useState<boolean>();
  const [managing, setManaging] = useState(false), [search, setSearch] = useState(''), [adding, setAdding] = useState(false);
  const version = useRef(0);
  const load = async (reload = false) => {
    const current = version.current;
    setBusy(true); setFailed(false); setStatus('Loading memories...');
    try {
      const result = await request<{ memory: OfficeMemory }>('/api/workspace/memory');
      if (current === version.current) { setMemory(result.memory); setConfirm(undefined); setStatus(reload ? 'Memories reloaded. Review your draft before saving.' : ''); }
    } catch (error) {
      if (current === version.current) { setFailed(true); setStatus(userWorkspaceNotice(error instanceof Error ? error.message : 'Memories could not be loaded. Try again.')); }
    } finally { if (current === version.current) setBusy(false); }
  };
  useEffect(() => {
    if (!open) return;
    version.current++; setMemory(undefined); setDraft(''); setEditing(undefined); setConfirm(undefined); setPendingEnabled(undefined); setManaging(false); setSearch(''); setAdding(false);
    void load();
    return () => { version.current++; };
  }, [open, owner]);
  const change = async (input: Record<string, unknown>) => {
    if (!memory || busy) return;
    const current = version.current;
    if (input['operation'] === 'configure' && typeof input['enabled'] === 'boolean') setPendingEnabled(input['enabled']);
    setBusy(true); setFailed(false); setStatus('Saving memory changes...');
    try {
      const result = await request<{ memory: OfficeMemory; message: string }>('/api/workspace/memory', 'POST', { ...input, expected: memory.revision });
      if (current !== version.current) return;
      setMemory(result.memory); setStatus(result.message); setConfirm(undefined);
      if (input['operation'] === 'save' || input['operation'] === 'clear' || input['operation'] === 'remove' && input['id'] === editing) { setDraft(''); setEditing(undefined); setAdding(false); }
    } catch (error) {
      if (current === version.current) { setFailed(true); setStatus(userWorkspaceNotice(error instanceof Error ? error.message : 'Memory changes could not be confirmed. Reload memories before retrying.')); }
    } finally { if (current === version.current) { setBusy(false); setPendingEnabled(undefined); } }
  };
  const feedback = <>{status ? <p role={failed ? 'alert' : 'status'}>{status}</p> : null}{failed ? <button type="button" disabled={busy} onClick={() => void load(true)}>Reload memories</button> : null}</>;
  const entries = memory?.entries.filter(entry => entry.text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  const cancelEdit = () => { setAdding(false); setEditing(undefined); setDraft(''); setStatus('Memory editing cancelled.'); setFailed(false); };
  const cancelConfirm = () => { setConfirm(undefined); setStatus('Memory removal cancelled.'); setFailed(false); };
  return <section class="settings-block settings-block-wide user-memory" aria-label="Memory settings">
    <div class="user-memory-heading"><h3 class="settings-block-title">Memory</h3>{memory ? <label class="user-memory-toggle"><input type="checkbox" checked={pendingEnabled ?? memory.enabled} disabled={busy || !!confirm} onChange={event => void change({ operation: 'configure', enabled: event.currentTarget.checked })} />Use saved memory</label> : null}</div>
    <p>Save details you ask to remember across chats. Turning this off keeps saved memories.</p>
    {!managing ? feedback : null}
    {memory ? <div class="user-memory-manage"><span>{memory.entries.length} saved</span><button type="button" disabled={busy} onClick={() => setManaging(true)}>Manage memories</button></div> : null}
    <ModalShell open={open && managing} title="Saved memories" closeLabel="Close saved memories" className="office-user-settings user-memory-manager user-memory" closeDisabled={busy || adding || !!confirm} onClose={() => setManaging(false)}>
      {!adding && !confirm ? feedback : null}
      {memory ? <><input type="search" aria-label="Search memories" placeholder="Search memories" value={search} onInput={event => setSearch(event.currentTarget.value)} />
      <button type="button" disabled={busy || adding || !!confirm || !memory.enabled} onClick={() => { setDraft(''); setEditing(undefined); setAdding(true); setStatus(''); }}>Add memory</button>
      {entries.length ? <ul>{entries.map(entry => <li key={entry.id}><p>{entry.text}</p><div class="user-memory-actions"><button type="button" title="Edit" aria-label={`Edit memory: ${entry.text}`} disabled={busy || adding || !!confirm || !memory.enabled} onClick={() => { setEditing(entry.id); setDraft(entry.text); setAdding(true); setStatus(''); }}><ToolIcon kind="edit" /></button><button type="button" title="Remove" disabled={busy || adding || !!confirm} aria-label={`Remove memory: ${entry.text}`} onClick={() => { setConfirm({id:entry.id,text:entry.text}); setStatus(''); }}><ToolIcon kind="clear" /></button></div></li>)}</ul> : <p class="user-memory-empty">{search.trim() ? 'No matching memories.' : 'No saved memories yet.'}</p>}
      {memory.entries.length ? <button type="button" disabled={busy || adding || !!confirm} onClick={() => { setConfirm({}); setStatus(''); }}>Clear all memories</button> : null}
      </> : null}
    </ModalShell>
    <ModalShell open={open && adding} title={editing ? 'Edit memory' : 'Add memory'} closeLabel="Close memory editor" className="office-user-settings user-editor-modal" closeDisabled={busy} onClose={cancelEdit}>
      {feedback}<form onSubmit={event => { event.preventDefault(); if (memory?.enabled) void change({ operation: 'save', id: editing, text: draft }); }}>
        <textarea autoFocus aria-label={editing ? 'Edit memory' : 'Add a memory'} rows={4} maxLength={500} required disabled={busy || !memory?.enabled} value={draft} placeholder="A preference to remember…" onInput={event => setDraft(event.currentTarget.value)} />
        <div class="user-page-actions"><button type="button" disabled={busy} onClick={cancelEdit}>Cancel</button><button type="submit" disabled={busy || !memory?.enabled || !draft.trim()}>{editing ? 'Save memory' : 'Add memory'}</button></div>
      </form>
    </ModalShell>
    <ModalShell open={open && !!confirm} title={confirm?.id ? 'Remove memory' : 'Clear saved memories'} closeLabel="Close memory confirmation" className="office-user-settings user-editor-modal" closeDisabled={busy} onClose={cancelConfirm}>
      <p>{confirm?.id ? `Remove this memory? ${confirm.text}` : 'Clear all saved memories? This cannot be undone. Existing chats are kept.'}</p>{feedback}
      <div class="user-page-actions"><button type="button" disabled={busy} onClick={cancelConfirm}>Cancel</button><button type="button" disabled={busy} onClick={() => void change(confirm?.id ? {operation:'remove',id:confirm.id} : {operation:'clear',confirmed:true})}>{confirm?.id ? 'Remove memory' : 'Clear memories'}</button></div>
    </ModalShell>
  </section>;
}
