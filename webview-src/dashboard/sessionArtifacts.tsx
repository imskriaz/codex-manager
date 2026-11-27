import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionArtifact, SessionArtifactKind, SessionArtifactRequest } from '../../src/domain/sessionArtifacts';
import type { DashboardNotice } from '../../src/domain/dashboard/types';
import { ModalShell } from './primitives';
import { ShareLinkField } from './shareControls';
import type { useWorkspaceRequest } from './workspaceRequest';

const sourceLabels: Record<SessionArtifactKind, string> = {
  file: 'Project-relative file path',
  app: 'Local HTTP URL or port',
  link: 'Existing HTTP or HTTPS URL'
};

export function SessionArtifactsModal(props: { request: ReturnType<typeof useWorkspaceRequest>; onClose: () => void }) {
  const [items, setItems] = useState<SessionArtifact[]>([]);
  const [kind, setKind] = useState<SessionArtifactKind>('file');
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<DashboardNotice>();
  const mounted = useRef(false);
  const revision = useRef(0);
  const running = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const initialRevision = revision.current;
    let current = true;
    setLoading(true);
    void props.request('sessionArtifact', { artifactRequest: { operation: 'list' } }).then(
      result => { if (current && initialRevision === revision.current) setItems(result.sessionArtifacts ?? []); },
      (error: unknown) => {
        if (current && initialRevision === revision.current) {
          setNotice({ level: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      }
    ).finally(() => { if (current) setLoading(false); });
    return () => { current = false; mounted.current = false; };
  }, [props.request]);

  const change = async (operation: Exclude<SessionArtifactRequest, { operation: 'list' }>) => {
    if (running.current) return;
    running.current = true;
    revision.current++;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await props.request('sessionArtifact', { artifactRequest: operation, confirmed });
      if (!mounted.current) return;
      setItems(result.sessionArtifacts ?? []);
      if (operation.operation === 'create') {
        setTitle('');
        setSource('');
        setConfirmed(false);
      }
      setNotice(result.notice ?? { level: 'info', message: operation.operation === 'create' ? 'Artifact link created.' : 'Artifact link revoked.' });
    } catch (error) {
      if (mounted.current) setNotice({ level: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <ModalShell open title="Session artifacts" closeLabel="Close session artifacts" className="dashboard-modal-compact" closeDisabled={busy} onClose={props.onClose}>
    <form class="user-editor-form" onSubmit={event => {
      event.preventDefault();
      if (confirmed && title.trim() && source.trim()) void change({ operation: 'create', kind, title, source });
    }}>
      <label>Source type <select value={kind} disabled={busy} onChange={event => {
        setKind(event.currentTarget.value as SessionArtifactKind);
        setSource('');
        setConfirmed(false);
      }}>
        <option value="file">Project file</option>
        <option value="app">Running app</option>
        <option value="link">Existing URL</option>
      </select></label>
      <label>Title <input required value={title} maxLength={120} disabled={busy} onInput={event => setTitle(event.currentTarget.value)} /></label>
      <label>{sourceLabels[kind]} <input required value={source} maxLength={2048} disabled={busy} onInput={event => {
        setSource(event.currentTarget.value);
        setConfirmed(false);
      }} /></label>
      {kind === 'file' ? <p>HTML opens as a single-file preview. Other files download.</p> : null}
      {kind === 'app' ? <p>This shares the running app and its routes. Keep the app running while the link is in use.</p> : null}
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.currentTarget.checked)} /> Anyone with the link can open it for up to 24 hours.</label>
      <div class="dialog-actions"><button type="submit" disabled={busy || !confirmed || !title.trim() || !source.trim()}>Create share link</button></div>
    </form>
    {notice ? <p role={notice.level === 'error' ? 'alert' : 'status'}>{notice.message}</p> : null}
    {loading ? <p role="status">Loading shared artifacts…</p> : null}
    {items.map(item => <section key={item.id} class="share-access-management">
      <div>
        <ShareLinkField url={item.url} label={item.title} disabled={busy} onFeedback={setNotice} />
        <p>Expires {new Date(item.expiresAt).toLocaleString()}</p>
        <a href={item.url} target="_blank" rel="noopener noreferrer">Open</a>
      </div>
      <button type="button" class="share-manage-button" disabled={busy} onClick={() => void change({ operation: 'revoke', id: item.id })} aria-label={`Revoke ${item.title}`}>Revoke</button>
    </section>)}
  </ModalShell>;
}
