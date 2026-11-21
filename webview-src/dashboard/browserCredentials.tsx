import { useEffect, useState } from 'preact/hooks';
import type { useWorkspaceRequest } from './workspaceRequest';
import { ModalShell } from './primitives';

type Login = { id: string; name: string; origin: string; username: string; usernameSelector?: string; passwordSelector?: string };
type Vault = { locked: boolean; exists: boolean; entries: Login[]; message?: string };
export function BrowserCredentials(props: { request: ReturnType<typeof useWorkspaceRequest>; pageId?: string; revision?: string; url?: string; onFilled: () => void; onClose: () => void }) {
  const [vault, setVault] = useState<Vault>({ locked: true, exists: true, entries: [] });
  const [master, setMaster] = useState(''), [name, setName] = useState(''), [origin, setOrigin] = useState('');
  const [editing, setEditing] = useState<string | undefined>(), [editor, setEditor] = useState(false);
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [usernameSelector, setUsernameSelector] = useState('input[autocomplete="username"],input[type="email"]'), [passwordSelector, setPasswordSelector] = useState('input[type="password"]');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
  const closeEditor = () => { if (!busy) { setEditor(false); setPassword(''); setMessage(''); } };
  const openEditor = (row?: Login) => {
    let currentOrigin = ''; try { const url = new URL(props.url ?? ''); if (['http:', 'https:'].includes(url.protocol)) currentOrigin = url.origin; } catch { /* No website selected. */ }
    setEditing(row?.id); setName(row?.name ?? ''); setOrigin(row?.origin ?? currentOrigin); setUsername(row?.username ?? ''); setPassword('');
    setUsernameSelector(row?.usernameSelector ?? 'input[autocomplete="username"],input[type="email"]'); setPasswordSelector(row?.passwordSelector ?? 'input[type="password"]');
    setMessage(''); setFailed(false); setEditor(true);
  };
  async function command(action: string, params: Record<string, unknown> = {}) {
    if (busy) return;
    setBusy(true); setMessage(''); setFailed(false);
    try {
      const response = await props.request('workspaceBrowser', { browserRequest: { operation: 'credentials', operationId: crypto.randomUUID(), confirmed: true, ...(action === 'fill' ? { pageId: props.pageId, revision: props.revision } : {}), params: { action, ...params } } });
      if (!response.workspaceBrowser?.value) throw new Error('Credential outcome was not returned. Refresh before retrying.');
      const value = response.workspaceBrowser.value as Vault & { filled?: boolean };
      if (value.filled) props.onFilled(); else setVault(value);
      setMessage(value.message ?? (action === 'unlock' ? 'Vault unlocked for 15 minutes.' : action === 'lock' ? 'Vault locked.' : ''));
      if (action === 'save') { setPassword(''); setEditor(false); }
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); if (action === 'unlock') setMaster(''); }
  }
  useEffect(() => { void command('list'); }, []);
  return <><ModalShell open={!editor} title="Credentials" closeLabel="Close credential manager" className="workspace-browser-credentials" closeDisabled={busy} onClose={props.onClose}>
    <p>Encrypted for this project. Automation fills only on the saved website.</p>
    <div class="workspace-browser-credential-status" role={failed ? 'alert' : 'status'}>{message}</div>
    {vault.locked ? <form onSubmit={event => { event.preventDefault(); void command('unlock', { masterPassword: master }); }}>
      <label>Master password<input type="password" aria-label="Vault master password" autoComplete="off" disabled={busy} required minLength={vault.exists ? 1 : 12} maxLength={1024} value={master} onInput={event => setMaster(event.currentTarget.value)} /></label>
      <small>{vault.exists ? 'Unlock your vault. The master password is never saved.' : 'Create a vault with at least 12 characters. Keep the master password; it cannot be recovered.'}</small>
      <button disabled={busy} type="submit">{vault.exists ? 'Unlock vault' : 'Create vault'}</button>
    </form> : <>
      <div class="workspace-browser-pane-toolbar"><button type="button" disabled={busy} onClick={() => openEditor()}>Add login</button><span class="workspace-browser-pane-actions"><button disabled={busy} type="button" onClick={() => void command('lock')}>Lock vault</button></span></div>
      <div class="workspace-browser-credential-table"><table aria-label="Saved logins"><thead><tr><th>Login</th><th>Website</th><th>User</th><th>Actions</th></tr></thead><tbody>{vault.entries.map(row => <tr key={row.id}><td title={row.name}>{row.name}</td><td title={row.origin}>{row.origin}</td><td title={row.username}>{row.username}</td><td><button type="button" title="Fill login" aria-label={`Fill ${row.name}`} disabled={busy || !props.pageId} onClick={() => void command('fill', { id: row.id })}>↳</button><button type="button" title="Edit login" aria-label={`Edit ${row.name}`} disabled={busy} onClick={() => openEditor(row)}>✎</button><button type="button" title="Delete login" aria-label={`Delete ${row.name}`} disabled={busy} onClick={() => void command('delete', { id: row.id })}>×</button></td></tr>)}</tbody></table>{!vault.entries.length ? <p>No saved logins.</p> : null}</div>
    </>}
  </ModalShell><ModalShell open={editor} title={editing ? 'Edit login' : 'Add login'} closeLabel="Close login editor" className="workspace-browser-credentials workspace-browser-login-editor" closeDisabled={busy} onClose={closeEditor}>
      <div class="workspace-browser-credential-status" role={failed ? 'alert' : 'status'}>{message}</div>
      <form onSubmit={event => { event.preventDefault(); void command('save', { ...(editing ? { id: editing } : {}), name, origin, username, password, usernameSelector, passwordSelector }); }}>
        <label>Name<input aria-label="Login name" required maxLength={128} value={name} onInput={event => setName(event.currentTarget.value)} /></label>
        <label>Website origin<input type="url" aria-label="Login website" required value={origin} onInput={event => setOrigin(event.currentTarget.value)} /></label>
        <label>Username<input aria-label="Login username" required autoComplete="off" maxLength={1024} value={username} onInput={event => setUsername(event.currentTarget.value)} /></label>
        <label>Password<input type="password" aria-label="Login password" required={!editing} placeholder={editing ? 'Leave blank to keep saved password' : ''} autoComplete="new-password" maxLength={4096} value={password} onInput={event => setPassword(event.currentTarget.value)} /></label>
        <details><summary>Login field selectors</summary><label>Username selector<input aria-label="Username selector" required value={usernameSelector} onInput={event => setUsernameSelector(event.currentTarget.value)} /></label><label>Password selector<input aria-label="Password selector" required value={passwordSelector} onInput={event => setPasswordSelector(event.currentTarget.value)} /></label></details>
        <button type="submit" disabled={busy}>Save login</button>
      </form>
  </ModalShell></>;
}
