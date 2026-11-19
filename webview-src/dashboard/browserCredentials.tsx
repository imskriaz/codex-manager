import { useEffect, useState } from 'preact/hooks';
import type { useWorkspaceRequest } from './workspaceRequest';

type Vault = { locked: boolean; exists: boolean; entries: Array<{ id: string; name: string; origin: string; username: string }>; message?: string };
export function BrowserCredentials(props: { request: ReturnType<typeof useWorkspaceRequest>; pageId?: string; revision?: string; url?: string; onFilled: () => void; onClose: () => void }) {
  const [vault, setVault] = useState<Vault>({ locked: true, exists: true, entries: [] });
  const [master, setMaster] = useState(''), [name, setName] = useState(''), [origin, setOrigin] = useState(() => { try { return new URL(props.url ?? '').origin; } catch { return ''; } });
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [usernameSelector, setUsernameSelector] = useState('input[autocomplete="username"],input[type="email"]'), [passwordSelector, setPasswordSelector] = useState('input[type="password"]');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
  async function command(action: string, params: Record<string, unknown> = {}) {
    if (busy) return;
    setBusy(true); setMessage(''); setFailed(false);
    try {
      const response = await props.request('workspaceBrowser', { browserRequest: { operation: 'credentials', operationId: crypto.randomUUID(), confirmed: true, ...(action === 'fill' ? { pageId: props.pageId, revision: props.revision } : {}), params: { action, ...params } } });
      if (!response.workspaceBrowser?.value) throw new Error('Credential outcome was not returned. Refresh before retrying.');
      const value = response.workspaceBrowser.value as Vault & { filled?: boolean };
      if (value.filled) props.onFilled(); else setVault(value);
      setMessage(value.message ?? (action === 'unlock' ? 'Vault unlocked for 15 minutes.' : action === 'lock' ? 'Vault locked.' : ''));
      if (action === 'save') { setPassword(''); setName(''); setUsername(''); }
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); setMaster(''); }
  }
  useEffect(() => { void command('list'); }, []);
  return <section class="workspace-browser-credentials" aria-label="Credential manager" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); } }}>
    <header><strong>Credentials</strong><button type="button" aria-label="Close credential manager" onClick={props.onClose}>×</button></header>
    <p>Encrypted on this PC for this project. Automation fills saved logins only on the exact website origin.</p>
    <div class="workspace-browser-credential-status" role={failed ? 'alert' : 'status'}>{message}</div>
    {vault.locked ? <form onSubmit={event => { event.preventDefault(); void command('unlock', { masterPassword: master }); }}>
      <label>Master password<input type="password" aria-label="Vault master password" autoComplete="off" required minLength={vault.exists ? 1 : 12} maxLength={1024} value={master} onInput={event => setMaster(event.currentTarget.value)} /></label>
      <small>{vault.exists ? 'Unlock your vault. The master password is never saved.' : 'Create a vault with at least 12 characters. Keep the master password; it cannot be recovered.'}</small>
      <button disabled={busy} type="submit">{vault.exists ? 'Unlock vault' : 'Create vault'}</button>
    </form> : <>
      <div class="workspace-browser-pane-toolbar"><button disabled={busy} type="button" onClick={() => void command('lock')}>Lock vault</button><button disabled={busy} type="button" aria-label="Refresh credentials" onClick={() => void command('list')}>↻</button></div>
      <table><thead><tr><th>Login</th><th>Website</th><th>User</th><th>Actions</th></tr></thead><tbody>{vault.entries.map(row => <tr key={row.id}><td title={row.name}>{row.name}</td><td title={row.origin}>{row.origin}</td><td title={row.username}>{row.username}</td><td><button type="button" title="Fill login" aria-label={`Fill ${row.name}`} disabled={busy || !props.pageId} onClick={() => void command('fill', { id: row.id })}>↳</button><button type="button" title="Delete login" aria-label={`Delete ${row.name}`} disabled={busy} onClick={() => void command('delete', { id: row.id })}>×</button></td></tr>)}</tbody></table>
      <form onSubmit={event => { event.preventDefault(); void command('save', { name, origin, username, password, usernameSelector, passwordSelector }); }}>
        <label>Name<input aria-label="Login name" required maxLength={128} value={name} onInput={event => setName(event.currentTarget.value)} /></label>
        <label>Website origin<input type="url" aria-label="Login website" required value={origin} onInput={event => setOrigin(event.currentTarget.value)} /></label>
        <label>Username<input aria-label="Login username" required autoComplete="off" maxLength={1024} value={username} onInput={event => setUsername(event.currentTarget.value)} /></label>
        <label>Password<input type="password" aria-label="Login password" required autoComplete="new-password" maxLength={4096} value={password} onInput={event => setPassword(event.currentTarget.value)} /></label>
        <details><summary>Login field selectors</summary><label>Username selector<input aria-label="Username selector" required value={usernameSelector} onInput={event => setUsernameSelector(event.currentTarget.value)} /></label><label>Password selector<input aria-label="Password selector" required value={passwordSelector} onInput={event => setPasswordSelector(event.currentTarget.value)} /></label></details>
        <button type="submit" disabled={busy}>Save login</button>
      </form>
    </>}
  </section>;
}
