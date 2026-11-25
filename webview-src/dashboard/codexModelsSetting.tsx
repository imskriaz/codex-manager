import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_CODEX_FALLBACK_MODEL_IDS, parseCodexFallbackModelIds } from '../../src/domain/codexModelFallback';
import type { DashboardHostMessage, DashboardActionPayload } from '../../src/domain/dashboard/types';
import type { SendAction } from './hookTypes';
import { renderRemoveIcon } from './icons';

export function requestCodexModels(send: SendAction, request: NonNullable<DashboardActionPayload['codexModelRequest']>, targetDeviceId?: string, signal?: AbortSignal): Promise<{ ids?: string; message: string }> {
  return new Promise((resolve, reject) => {
    let id: string;
    const finish = () => { clearTimeout(timer); window.removeEventListener('message', receive); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { finish(); reject(new Error('Model request cancelled. Its outcome is unconfirmed.')); };
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== 'dashboard:action-result' || message.action !== 'manageCodexModels' || message.requestId !== id) return;
      finish();
      if (message.status !== 'completed' || !message.payload?.codexModels) reject(new Error(message.error || 'The host did not confirm the model request. Reopen Settings before retrying.'));
      else resolve(message.payload.codexModels);
    };
    const timer = setTimeout(() => { finish(); reject(new Error('Model request timed out. Its outcome is unconfirmed. Reopen Settings before retrying.')); }, 35_000);
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    window.addEventListener('message', receive);
    try { id = send('manageCodexModels', undefined, { targetDeviceId, codexModelRequest: request }); }
    catch (error) { finish(); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}

export function CodexModelsSetting(props: { saved?: string; connected: boolean; targetDeviceId?: string; sendAction: SendAction; onSaved: (ids: string) => void }) {
  const saved = props.saved ?? DEFAULT_CODEX_FALLBACK_MODEL_IDS;
  const [ids, setIds] = useState(() => saved.split('\n').filter(Boolean));
  const [expected, setExpected] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; message: string }>();
  const [results, setResults] = useState<Record<string, { error: boolean; message: string }>>({});
  const controller = useRef<AbortController>();
  useEffect(() => {
    if (!dirty) { setIds(saved.split('\n').filter(Boolean)); setExpected(saved); }
  }, [saved, dirty]);
  useEffect(() => {
    setIds(saved.split('\n').filter(Boolean)); setExpected(saved); setDirty(false); setResults({}); setNotice(undefined); setBusy(false);
    return () => { controller.current?.abort(); };
  }, [props.targetDeviceId]);
  const change = (next: string[]) => { setIds(next); setDirty(true); };
  const act = async (model?: string, load = false) => {
    if (busy) return;
    if (!props.connected) { setNotice({ error: true, message: 'Reconnect to this host before saving or testing models.' }); return; }
    const active = new AbortController(); controller.current = active;
    setBusy(true); setNotice({ error: false, message: model ? `Testing ${model}…` : load ? 'Loading models…' : 'Saving fallback models…' });
    try {
      const normalized = parseCodexFallbackModelIds(model ?? ids.join('\n')).join('\n');
      const result = await requestCodexModels(props.sendAction, model ? { operation: 'test', model: normalized } : load ? { operation: 'load' } : { operation: 'save', ids: normalized, expected }, props.targetDeviceId, active.signal);
      if (active.signal.aborted) return;
      const feedback = { error: false, message: result.message };
      setNotice(feedback);
      if (model) setResults(current => ({ ...current, [model]: feedback }));
      else {
        const next = result.ids ?? normalized; props.onSaved(next); setIds(next.split('\n').filter(Boolean)); setExpected(next); setDirty(false);
        props.sendAction('listCodexCliSessions', undefined, { targetDeviceId: props.targetDeviceId, automatic: true });
      }
    } catch (error) {
      if (active.signal.aborted) return;
      const feedback = { error: true, message: error instanceof Error ? error.message : 'The model request could not be confirmed. Retry when connected.' };
      setNotice(feedback); if (model) setResults(current => ({ ...current, [model]: feedback }));
    } finally { if (!active.signal.aborted) setBusy(false); }
  };
  return <section class="settings-block settings-block-wide codex-models-setting" aria-label="Codex fallback models">
    <div class="settings-block-head"><h3 class="settings-block-title">Codex fallback models</h3><p class="settings-block-sub">Keep models available in the picker when live discovery omits them. Successful discovery adds new model IDs to this saved list.</p></div>
    <p class="settings-note">Fallback entries do not confirm account access. The test button sends a small request using the selected host’s account and consumes a small amount of usage.</p>
    <fieldset disabled={busy}>
      {ids.map((id, index) => <div class="codex-model-entry" key={index}>
        <div class="codex-model-row"><input class="settings-text-input" aria-label={`Fallback model ${index + 1}`} value={id} maxLength={128} spellcheck={false} onInput={event => change(ids.map((value, i) => i === index ? event.currentTarget.value : value))} />
          <button type="button" class="icon-btn" disabled={!id.trim() || !props.connected} title={`Test ${id || 'model'}`} aria-label={`Test ${id || 'model'}`} onClick={() => void act(id.trim())}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m8 5 11 7-11 7Z" /></svg></button>
          <button type="button" class="icon-btn" title={`Remove ${id || 'model'}`} aria-label={`Remove ${id || 'model'}`} onClick={() => change(ids.filter((_, i) => i !== index))}>{renderRemoveIcon()}</button></div>
        {results[id] ? <p class="settings-note" role={results[id]!.error ? 'alert' : 'status'}>{results[id]!.message}</p> : null}
      </div>)}
      <div class="codex-model-actions"><button type="button" class="settings-action-btn" disabled={ids.length >= 100} onClick={() => change([...ids, ''])}>Add model</button><button type="button" class="settings-action-btn" disabled={dirty || !props.connected} title={dirty ? 'Save your edits before loading models' : 'Refresh models from Codex'} onClick={() => void act(undefined, true)}>Load models</button><button type="button" class="settings-action-btn" disabled={!dirty || !props.connected} onClick={() => void act()}>Save fallback models</button></div>
    </fieldset>
    {notice ? <p class={`settings-note ${notice.error ? 'settings-notice-warning' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.message}</p> : null}
  </section>;
}
