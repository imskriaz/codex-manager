import { useEffect, useRef, useState } from 'preact/hooks';
import { normalizeApiAccount, type ApiAccountProvider } from '../../src/domain/apiAccounts';
import type { DashboardAccountViewModel, DashboardHostMessage } from '../../src/domain/dashboard/types';
import type { SendAction } from './hookTypes';
import { getActionTimeoutMs } from './host';

export function ApiAccountForm(props: { account?: DashboardAccountViewModel; sendAction: SendAction; onSaved: () => void; onBack: () => void }) {
  const [provider, setProvider] = useState<ApiAccountProvider>(props.account?.provider === 'claude' ? 'anthropic' : 'openai');
  const [name, setName] = useState(props.account?.displayName ?? '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(props.account?.apiBaseUrl ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(props.account?.healthMessage ?? '');
  const originalAccount = useRef(props.account).current;
  const request = useRef<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const onSaved = useRef(props.onSaved);
  onSaved.current = props.onSaved;
  useEffect(() => {
    const listener = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== 'dashboard:action-result' || message.action !== 'saveApiAccount' || message.requestId !== request.current) return;
      clearTimeout(timer.current); setPending(false); request.current = undefined;
      if (message.status === 'completed' && message.payload?.apiAccountSaved?.id) { setApiKey(''); onSaved.current(); }
      else setError(message.error || 'The account was not confirmed as saved. Your details are kept; refresh before retrying.');
    };
    window.addEventListener('message', listener);
    return () => { window.removeEventListener('message', listener); clearTimeout(timer.current); };
  }, []);
  return <form class="modal-stack" onSubmit={event => {
    event.preventDefault(); if (pending) return;
    try {
      const account = props.account && !apiKey ? { provider, name, apiKey, baseUrl } : normalizeApiAccount({ provider, name, apiKey, baseUrl });
      setError(''); setPending(true);
      request.current = props.sendAction('saveApiAccount', undefined, { apiAccount: account, apiAccountId: originalAccount?.id, apiAccountRevision: originalAccount?.updatedAt });
      timer.current = setTimeout(() => { request.current = undefined; setPending(false); setError('Saving timed out. The outcome is unconfirmed; refresh the account list before retrying. Your details are kept.'); }, getActionTimeoutMs('saveApiAccount'));
    } catch (failure) { setPending(false); setError(failure instanceof Error ? failure.message : 'Unable to save API account.'); }
  }}>
    <label class="modal-label">Provider<select class="modal-input" aria-label="API provider" value={provider} disabled={pending || !!props.account} onChange={event => { setProvider(event.currentTarget.value as ApiAccountProvider); setBaseUrl(''); }}><option value="openai">OpenAI</option><option value="anthropic">Anthropic / Claude</option></select></label>
    <label class="modal-label">Account name<input class="modal-input" aria-label="API account name" autoFocus maxLength={100} required value={name} disabled={pending} onInput={event => setName(event.currentTarget.value)} /></label>
    <label class="modal-label">API key<input class="modal-input" aria-label="Provider API key" type="password" autoComplete="off" spellcheck={false} required={!props.account} placeholder={props.account ? 'Leave blank to test the saved key' : undefined} value={apiKey} disabled={pending} onInput={event => setApiKey(event.currentTarget.value)} /></label>
    <label class="modal-label">Base URL (optional)<input class="modal-input" aria-label="API base URL" type="url" placeholder={provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'} value={baseUrl} disabled={pending} onInput={event => setBaseUrl(event.currentTarget.value)} /></label>
    <p class="modal-note">The key is tested before saving. Stored on this system. Select the saved account to use it for new turns. API billing and limits are managed by the provider.</p>
    {error ? <p class="modal-error" role="alert">{error}</p> : null}
    <div class="modal-actions"><button class="modal-secondary-btn" type="button" disabled={pending} onClick={props.onBack}>Back</button><button class="modal-primary-btn" type="submit" disabled={pending} aria-busy={pending}>{pending ? 'Testing key…' : props.account ? 'Test and save changes' : 'Save API account'}</button></div>
  </form>;
}
