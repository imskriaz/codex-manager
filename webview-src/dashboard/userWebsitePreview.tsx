import { useEffect, useState } from 'preact/hooks';
import { useWorkspaceRequest } from './workspaceRequest';
import { userWorkspaceNotice } from './userWorkspacePresentation';
import { ToolIcon, renderRefreshIcon } from './icons';

/** Opaque-origin preview: generated scripts cannot read dashboard credentials or data. */
export default function UserWebsitePreview(props: { path?: string; projectPath?: string; sessionId?: string; connected: boolean }) {
  const request = useWorkspaceRequest(props.projectPath, undefined, props.connected, props.sessionId);
  const [path, setPath] = useState(props.path ?? '');
  const [draft, setDraft] = useState(props.path ?? '');
  const [state, setState] = useState<{content?: string; error?: string}>({});
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setState({});
    if (!path) return;
    void request('readWorkspaceFile', {filePath: path}).then(result => {
      if (!active) return;
      const file = result.workspaceFile;
      if (file?.kind !== 'text' || typeof file.content !== 'string' || !/\.html?$/i.test(path)) throw new Error('Choose a saved HTML website to preview.');
      setState({content: file.content});
    }).catch(error => { if (active) setState({error: userWorkspaceNotice(error instanceof Error ? error.message : 'Preview could not be loaded.')}); });
    return () => { active = false; };
  }, [request, path, refresh]);
  const opening = !!path && !state.error && state.content === undefined;
  const reloading = !!path && path === draft.trim();
  return <section class="user-website-preview" aria-label="Website preview">
    <form class="workspace-browser-address" onSubmit={event => {event.preventDefault();if (!draft.trim() || !props.connected || opening) return;setPath(draft.trim());setRefresh(value => value + 1);}}><input aria-label="Website file" autoComplete="off" spellcheck={false} placeholder="Open an HTML file…" value={draft} onInput={event => setDraft(event.currentTarget.value)} /><button class="workspace-browser-icon-button" type="submit" aria-label={reloading ? 'Refresh preview' : 'Open preview'} title={reloading ? 'Refresh preview' : 'Open preview'} disabled={!draft.trim() || !props.connected || opening}>{reloading ? renderRefreshIcon() : <ToolIcon kind="right" />}</button></form>
    {!props.connected ? <p role="status">Offline. Reconnect to open or refresh a preview.</p> : null}
    {!path ? <div class="user-website-preview-empty"><ToolIcon kind="eye" /><strong>Website preview</strong><p>Open an HTML file from Files or Library.</p></div> : state.error ? <p role="alert">{state.error}</p> : state.content === undefined ? <p role="status">Opening preview…</p> : <iframe title={`Website ${path}`} sandbox="allow-scripts" referrerPolicy="no-referrer" src={`/api/workspace/preview?${new URLSearchParams({filePath:path, ...(props.projectPath ? {projectPath:props.projectPath} : {})})}`} key={refresh} />}
  </section>;
}
