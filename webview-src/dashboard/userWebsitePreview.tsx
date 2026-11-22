import { useEffect, useState } from 'preact/hooks';
import { useWorkspaceRequest } from './workspaceRequest';
import { userWorkspaceNotice } from './userWorkspacePresentation';

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
  return <section class="user-website-preview" aria-label="Website preview">
    <form onSubmit={event => {event.preventDefault();setPath(draft.trim());setRefresh(value => value + 1);}}><input aria-label="Website file" placeholder="index.html" value={draft} onInput={event => setDraft(event.currentTarget.value)} /><button type="submit" disabled={!draft.trim() || !props.connected}>{path === draft.trim() ? 'Refresh preview' : 'Open preview'}</button></form>
    {!path ? <p>Open a saved HTML website here, or ask the assistant to create one.</p> : state.error ? <p role="alert">{state.error}</p> : state.content === undefined ? <p role="status">Opening preview…</p> : <iframe title={`Website ${path}`} sandbox="allow-scripts" referrerPolicy="no-referrer" src={`/api/workspace/preview?${new URLSearchParams({filePath:path, ...(props.projectPath ? {projectPath:props.projectPath} : {})})}`} key={refresh} />}
  </section>;
}
