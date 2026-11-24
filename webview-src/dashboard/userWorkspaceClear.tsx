import { useEffect, useRef, useState } from 'preact/hooks';
import { ModalShell } from './primitives';
import { request } from './teamSettingsRequest';
import { userWorkspaceNotice } from './userWorkspacePresentation';
import type { DashboardNotice } from '../../src/domain/dashboard/types';

type Kind = 'chats' | 'files';
type Preview = { kind: Kind; count: number; revision: string };
export function UserWorkspaceClear(props: { connected: boolean; files?: boolean; library?: boolean; disabled?: boolean; onCleared?: () => void; onFeedback: (notice: DashboardNotice) => void }) {
  const [preview, setPreview] = useState<Preview>(), [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const feedback = (text: string, error = false) => { setStatus(text); setFailed(error); if (text && (props.library || !mounted.current)) props.onFeedback({ level: error ? 'error' : 'info', message: text }); };
  const cancel = () => { setPreview(undefined); feedback('Clear action cancelled.'); };
  const prepare = async (kind: Kind) => {
    if (busy) return;
    setBusy(true); feedback(`Checking ${kind}...`);
    try { setPreview(await request<Preview>('/api/workspace/clear?kind=' + kind)); feedback(''); }
    catch (error) { feedback(userWorkspaceNotice(error instanceof Error ? error.message : 'The clear action could not be checked.'), true); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (busy || !preview) return;
    setBusy(true); feedback(`Clearing ${preview.kind}...`);
    try {
      const result = await request<{ message: string }>('/api/workspace/clear', 'POST', { ...preview, confirmed: true });
      setPreview(undefined); feedback(result.message); props.onCleared?.();
    } catch (error) { setPreview(undefined); feedback(userWorkspaceNotice(error instanceof Error ? error.message : 'Clearing could not be confirmed. Refresh before retrying.'), true); props.onCleared?.(); }
    finally { setBusy(false); window.dispatchEvent(new Event('codex:workspace-data-changed')); }
  };
  const disabled = busy || props.disabled || !props.connected;
  const controls = props.library ? <button type="button" class="user-page-icon" aria-label="Clear all files" title="Clear all files" disabled={disabled} onClick={() => void prepare('files')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></svg></button> : <section class="settings-block settings-block-wide" aria-label="Clear workspace data"><h3 class="settings-block-title">Clear workspace data</h3><div class="user-page-actions"><button type="button" disabled={disabled} onClick={() => void prepare('chats')}>Clear all chats</button>{props.files ? <button type="button" disabled={disabled} onClick={() => void prepare('files')}>Clear all files</button> : null}</div></section>;
  return <>{controls}{status && !props.library ? <p role={failed ? 'alert' : 'status'}>{status}</p> : null}<ModalShell open={!!preview} title={`Clear all ${preview?.kind ?? 'files'}`} closeLabel="Close clear confirmation" className="user-confirm-modal" closeDisabled={busy} onClose={cancel}><p>Permanently delete {preview?.count} {preview?.count === 1 ? preview.kind.slice(0, -1) : preview?.kind}? This cannot be undone.</p><p>{preview?.kind === 'chats' ? 'All conversation history, including previously deleted chats, will be removed. Your files will stay in Library.' : 'All uploads, project files, saved versions, and Trash will be removed. Your chat text will be kept.'}</p>{status ? <p role={failed ? 'alert' : 'status'}>{status}</p> : null}<div class="user-page-actions"><button type="button" disabled={busy} onClick={cancel}>Cancel</button><button type="button" disabled={busy || !props.connected} onClick={() => void clear()}>Delete permanently</button></div></ModalShell></>;
}
