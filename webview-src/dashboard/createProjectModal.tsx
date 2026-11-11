import { useEffect, useRef, useState } from "preact/hooks";
import type { DashboardActionResultPayload, DashboardCliProject, DashboardHostMessage, DashboardNotice } from "../../src/domain/dashboard/types";
import { createActionRequestId, postMessageToHost } from "./host";
import { renderRefreshIcon } from './icons';
import { ModalShell } from "./primitives";

export const CREATE_PROJECT_OPTION = "__create_workspace_project__";

function FolderIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /><path d="M3 8h18" /></svg>;
}

export function CreateProjectModal(props: {
  deviceId?: string;
  initialFolder?: string;
  disabled?: boolean;
  onClose: () => void;
  onCreated: (project: DashboardCliProject) => void;
  onFeedback: (notice: DashboardNotice) => void;
}) {
  const [name, setName] = useState(''), [folder, setFolder] = useState(props.initialFolder ?? '');
  const [pending, setPending] = useState(false), [browserOpen, setBrowserOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false), [location, setLocation] = useState('');
  const [listing, setListing] = useState<DashboardActionResultPayload['workspaceFolders']>();
  const request = useRef<{ id: string; timer: ReturnType<typeof setTimeout> }>();
  const browseRequest = useRef<{ id: string; timer: ReturnType<typeof setTimeout> }>();
  const current = useRef(props);
  current.current = props;
  const closeBrowser = () => {
    if (browseRequest.current) clearTimeout(browseRequest.current.timer);
    browseRequest.current = undefined;
    setBrowsing(false); setBrowserOpen(false);
  };
  useEffect(() => {
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== 'dashboard:action-result') return;
      if (browseRequest.current && message.requestId === browseRequest.current.id) {
        clearTimeout(browseRequest.current.timer); browseRequest.current = undefined; setBrowsing(false);
        if (message.status === 'completed' && message.payload?.workspaceFolders) {
          setListing(message.payload.workspaceFolders); setLocation(message.payload.workspaceFolders.path);
          if (message.payload.workspaceFolders.warning) current.current.onFeedback({ level: 'warning', message: message.payload.workspaceFolders.warning });
        } else current.current.onFeedback({ level: 'error', message: message.error || 'Folder browsing was not confirmed. Retry when connected.' });
        return;
      }
      if (!request.current || message.requestId !== request.current.id) return;
      clearTimeout(request.current.timer); request.current = undefined; setPending(false);
      if (message.status === 'completed' && message.payload?.workspaceProject) {
        current.current.onCreated(message.payload.workspaceProject);
        if (message.payload.notice && message.payload.notice.level !== 'info') current.current.onFeedback(message.payload.notice);
        current.current.onClose();
      } else current.current.onFeedback({ level: message.status === 'cancelled' ? 'warning' : 'error', message: message.error || 'Project creation was not confirmed. Check the folder before retrying.' });
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      if (browseRequest.current) clearTimeout(browseRequest.current.timer);
      browseRequest.current = undefined;
      if (request.current) {
        clearTimeout(request.current.timer); request.current = undefined;
        current.current.onFeedback({ level: 'warning', message: 'The selected workspace changed before creation was confirmed. Check the original system’s folder before retrying.' });
      }
    };
  }, [props.deviceId]);
  const browse = (parentFolder?: string) => {
    if (browseRequest.current || pending || props.disabled) return;
    if (!navigator.onLine) { props.onFeedback({ level: 'warning', message: 'Reconnect before browsing folders on the selected system.' }); return; }
    setBrowsing(true); setLocation(parentFolder ?? '');
    const id = createActionRequestId(true);
    const timer = setTimeout(() => {
      if (browseRequest.current?.id !== id) return;
      browseRequest.current = undefined; setBrowsing(false);
      current.current.onFeedback({ level: 'warning', message: 'Folder browsing timed out. Reconnect or try another folder.' });
    }, 12_000);
    browseRequest.current = { id, timer };
    try { postMessageToHost({ type: 'dashboard:action', requestId: id, action: 'browseWorkspaceFolders', payload: { parentFolder, targetDeviceId: props.deviceId, automatic: true } }); }
    catch (failure) {
      clearTimeout(timer); browseRequest.current = undefined; setBrowsing(false);
      props.onFeedback({ level: 'error', message: failure instanceof Error ? failure.message : 'Folder browsing could not be sent.' });
    }
  };
  const separator = folder.includes('\\') ? '\\' : '/';
  const destination = folder.trim() && name.trim() ? `${folder.trim().replace(/[\\/]+$/, '')}${separator}${name.trim()}` : 'Your new folder will appear here';
  const blocked = browsing || props.disabled;
  return <>
    <ModalShell open title="Create new project" closeLabel="Close create project" className="create-project-modal dashboard-modal-compact" closeDisabled={pending || browserOpen} closeOnBackdrop={false} onClose={() => { props.onClose(); }}>
      <form class="workspace-dialog-fields create-project-form" onSubmit={event => {
        event.preventDefault();
        if (request.current || browserOpen || props.disabled || !name.trim() || !folder.trim()) return;
        if (!navigator.onLine) { props.onFeedback({ level: 'warning', message: 'Reconnect before creating a project. Nothing was sent or queued.' }); return; }
        const id = createActionRequestId(true); setPending(true);
        const timer = setTimeout(() => {
          if (request.current?.id !== id) return;
          request.current = undefined; setPending(false);
          current.current.onFeedback({ level: 'warning', message: 'Creation was not confirmed. Check the destination folder before retrying; this request was not replayed.' });
        }, 25_000);
        request.current = { id, timer };
        try { postMessageToHost({ type: 'dashboard:action', requestId: id, action: 'createWorkspaceProject', payload: { projectName: name.trim(), parentFolder: folder.trim(), targetDeviceId: props.deviceId, automatic: true } }); }
        catch (failure) { clearTimeout(timer); request.current = undefined; setPending(false); props.onFeedback({ level: 'error', message: failure instanceof Error ? failure.message : 'The request could not be sent.' }); }
      }}>
        <p class="workspace-dialog-description">Give your project a name and choose where it lives on the selected system.</p>
        <label>Project name<input autoFocus required maxLength={120} value={name} disabled={pending} placeholder="my-project" autoComplete="off" onInput={event => setName(event.currentTarget.value)} /></label>
        <label>Parent folder<div class="create-project-location-field"><input aria-label="Parent folder" aria-describedby="create-project-parent-help" required value={folder} maxLength={4096} disabled={pending} placeholder="Choose a folder" spellcheck={false} autoComplete="off" onInput={event => setFolder(event.currentTarget.value)} /><button type="button" aria-label="Browse folders…" disabled={pending || props.disabled} onClick={() => { if (browserOpen) return; setBrowserOpen(true); setListing(undefined); browse(folder.trim() || undefined); }}><FolderIcon /><span>Browse…</span></button></div><small id="create-project-parent-help">A new folder named after your project will be created here.</small></label>
        <div class="create-project-destination"><small>PROJECT FOLDER</small><code>{destination}</code></div>
        <footer class="workspace-dialog-footer"><button type="button" disabled={pending} onClick={() => { props.onClose(); }}>Cancel</button><button type="submit" class="primary" disabled={pending || props.disabled || !name.trim() || !folder.trim()}>{pending ? 'Creating…' : 'Create project'}</button></footer>
      </form>
    </ModalShell>
    {browserOpen ? <ModalShell open title="Select parent folder" closeLabel="Close folder picker" className="project-folder-picker dashboard-modal-compact" closeOnBackdrop={false} onClose={closeBrowser}>
      <p class="folder-picker-description">Choose an existing folder on the selected system.</p>
      <div class="folder-picker-toolbar">
        <button type="button" class="folder-picker-icon-button" aria-label="Up one level" title="Up one level" disabled={blocked || !listing || listing.path === listing.parent} onClick={() => browse(listing!.parent)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m5 12 7-7 7 7M12 5v15" /></svg></button>
        <form class="folder-picker-path" onSubmit={event => { event.preventDefault(); if (!blocked && location.trim()) browse(location.trim()); }}><FolderIcon /><input autoFocus aria-label="Folder path" value={location} disabled={blocked} maxLength={4096} spellcheck={false} autoComplete="off" placeholder="Enter a folder path" onInput={event => setLocation(event.currentTarget.value)} /><button type="submit" aria-label="Go to folder" title="Go to folder" disabled={blocked || !location.trim()}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m9 5 7 7-7 7" /></svg></button></form>
        <button type="button" class="folder-picker-icon-button" aria-label="Refresh folders" title="Refresh folders" disabled={blocked || !listing} onClick={() => browse(listing!.path)}>{renderRefreshIcon()}</button>
      </div>
      <div class="folder-picker-layout">
        <aside class="folder-picker-locations"><small>LOCATIONS</small><nav aria-label="Folder locations"><button type="button" disabled={blocked} onClick={() => browse()}><FolderIcon />Home</button>{listing?.roots.map(root => <button type="button" key={root} class={listing.path.toLowerCase().startsWith(root.toLowerCase()) ? 'is-active' : ''} disabled={blocked} onClick={() => browse(root)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 14h18M16 17h2" /></svg><span>{root.replace(/[\\/]+$/, '') || 'File system'}</span></button>)}</nav></aside>
        <section class="folder-picker-content" aria-label="Folders on selected system" aria-busy={browsing}>
          <div class="folder-picker-columns"><span>Name</span><span>Type</span></div>
          {browsing ? <div class="folder-picker-empty" role="status"><span class="cli-live-spinner" /><span>Loading folders…</span></div> : listing?.folders.length ? <ul class="folder-picker-list">{listing.folders.map(item => <li key={item.path}><button type="button" aria-label={`Open ${item.name}`} title={item.path} disabled={props.disabled} onClick={() => browse(item.path)}><FolderIcon /><strong>{item.name}</strong><small>Folder</small><svg class="folder-picker-chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m9 5 7 7-7 7" /></svg></button></li>)}</ul> : <div class="folder-picker-empty"><FolderIcon /><strong>{listing ? 'No subfolders' : 'Choose a location'}</strong><span>{listing ? 'You can select this folder.' : 'Open a location or enter a folder path above.'}</span></div>}
        </section>
      </div>
      <footer class="folder-picker-footer"><div class="folder-picker-selection"><small>SELECTED FOLDER</small><code title={listing?.path}>{listing?.path || 'No folder selected'}</code></div><div class="folder-picker-actions"><button type="button" onClick={closeBrowser}>Cancel</button><button type="button" class="modal-primary-btn" disabled={blocked || !listing || location.trim() !== listing.path} onClick={() => { setFolder(listing!.path); closeBrowser(); }}>Select folder</button></div></footer>
    </ModalShell> : null}
  </>;
}
