import { chatUploadTimeoutMs, chatAttachmentPreviews, MAX_CHAT_WIRE_BYTES } from "../../src/domain/chatAttachments";
import type { DashboardCliSessionMessage } from '../../src/domain/dashboard/types';
import { answeredSessionQuestionIds } from '../../src/domain/sessionQuestions';
import { normalizeCliComposerDraft, type CliComposerDraft, type CliSubmissionResult, isCliSubmissionEcho } from './cliSessionComposerState';
import { useEffect, useRef, useState } from 'preact/hooks';
import { readBrowserCache, writeBrowserCache, listBrowserMessageQueues } from './cliSessionCache';

export type CliQueuedMessage = { id: string; draft: CliComposerDraft; state: 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain'; createdAt: number; requestId?: string; seenIds: string[]; turnId?: string; durable?: boolean; steerRequested?: boolean; retryAt?: number; retryCount?: number; error?: string };
export const CLI_MESSAGE_QUEUE_LIMIT = 20;
export const MAX_CLI_MESSAGE_QUEUE_BYTES = MAX_CHAT_WIRE_BYTES * 2;
const fallbackQueueOwners = new Map<string, symbol>();
export function isRetryableCliSubmissionFailure(message = ''): boolean {
  return [
    'The session has a live writer, but its Codex owner could not be reached. Your message was kept;',
    'Codex is running, but its active turn could not be verified. Your message was kept;',
    'The native Codex owner is unavailable. Your follow-up was not sent;',
    'The active Codex turn changed or could not be verified. Your follow-up was not sent;',
    'The active Codex turn changed. Refresh the session before sending guidance.',
    'The active Codex turn changed. Refresh before sending guidance.',
    'The active Codex turn changed or is stopping. Refresh before sending guidance.',
    'This window does not own an active Codex turn to steer. Refresh the session.'
  ].some(reason => message.includes(reason));
}
type QueueRuntime = { items: CliQueuedMessage[]; ready: boolean; error?: string; reload: () => void; maintain: (clear: boolean) => Promise<boolean> };
const queueRuntimes = new Map<string, QueueRuntime>();
export type CliQueueStatus = { scope: string; items: CliQueuedMessage[]; active: boolean; ready: boolean; error?: string };
export async function readCliQueueStatuses(): Promise<CliQueueStatus[]> {
  const statuses = new Map<string, CliQueueStatus>();
  for (const { scope, value } of await listBrowserMessageQueues()) {
    try { statuses.set(scope, { scope, items: normalizeCliMessageQueue(value), active: false, ready: true }); }
    catch (error) { statuses.set(scope, { scope, items: [], active: false, ready: false, error: String(error) }); }
  }
  for (const [scope, runtime] of queueRuntimes) if (runtime.items.length || runtime.error) statuses.set(scope, { scope, ...runtime, active: true });
  return [...statuses.values()];
}
export async function maintainCliQueues(clear: boolean): Promise<{ updated: number; skipped: number }> {
  let updated = 0, skipped = 0;
  for (const status of await readCliQueueStatuses()) {
    const runtime = queueRuntimes.get(status.scope);
    const work = async () => {
      if (runtime?.ready) return runtime.maintain(clear);
      if (clear) return writeBrowserCache(`message-queue:${status.scope}`, []);
      const value = await readBrowserCache(`message-queue:${status.scope}`, Number.MAX_SAFE_INTEGER);
      const items = normalizeCliMessageQueue(value ?? []);
      // Unconfirmed sends require an echo or explicit resend, never a blind repair replay.
      const next = items.map(item => item.state === 'failed' && (!item.requestId || isRetryableCliSubmissionFailure(item.error)) ? { ...item, state: 'queued' as const, error: undefined, requestId: undefined, turnId: undefined, retryAt: undefined } : item);
      return writeBrowserCache(`message-queue:${status.scope}`, next);
    };
    try {
      const saved = runtime?.ready ? await work() : typeof navigator.locks?.request === 'function'
        ? await navigator.locks.request(`codex-message-queue:${status.scope}`, { ifAvailable: true }, lock => lock ? work() : false) : false;
      if (saved) { updated++; if (runtime && !runtime.ready) runtime.reload(); } else skipped++;
    } catch { skipped++; }
  }
  return { updated, skipped };
}
export function normalizeCliMessageQueue(value: unknown): CliQueuedMessage[] {
  if (!Array.isArray(value) || value.length > CLI_MESSAGE_QUEUE_LIMIT || JSON.stringify(value).length * 2 > MAX_CLI_MESSAGE_QUEUE_BYTES) throw new Error('The saved message queue could not be read. It was kept for recovery.');
  const ids = new Set<string>();
  return (value as unknown[]).map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Unreadable saved message. It was kept for recovery.');
    const item = raw as Partial<CliQueuedMessage>;
    const draft = normalizeCliComposerDraft(item?.draft);
    if (!draft || !item || typeof item.id !== 'string' || item.id.length > 256 || ids.has(item.id) || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || item.createdAt < 0 || item.createdAt > 8.64e15 || typeof item.state !== 'string' || !['queued','sending','sent','failed','uncertain'].includes(item.state) || !Array.isArray(item.seenIds) || item.seenIds.length > 3000 || item.seenIds.some((id: unknown) => typeof id !== 'string' || id.length > 256) || (!draft.text.trim() && !draft.attachments.length)) throw new Error('The saved message queue contains unreadable content. It was kept for recovery.');
    ids.add(item.id);
    return { id: item.id, draft, state: item.state === 'sending' || item.state === 'sent' ? 'uncertain' : item.state, createdAt: item.createdAt, seenIds: item.seenIds, ...(typeof item.requestId === 'string' ? { requestId: item.requestId } : {}), ...(typeof item.turnId === 'string' ? { turnId: item.turnId } : {}), durable: true, ...(isRetryableCliSubmissionFailure(item.error) && Number.isFinite(item.retryAt) && item.retryAt! > 0 ? { retryAt: item.retryAt, retryCount: Math.min(6, Math.max(0, item.retryCount ?? 0)) } : {}), ...(item.steerRequested === true ? { steerRequested: true } : {}), ...(typeof item.error === 'string' ? { error: item.error } : {}) };
  });
}
export function queuedMessageEchoes(items: CliQueuedMessage[], messages: DashboardCliSessionMessage[]) {
  const consumed = new Set<string>(), matched = new Set<string>();
  for (const item of items) {
    if (item.state === 'queued' || item.state === 'failed' && !item.requestId) continue;
    // A confirmed native steer may be handed to the owner's next turn.
    const echo = messages.find(message => !consumed.has(message.id) && isCliSubmissionEcho(message, item.draft, new Set(item.seenIds), item.state === 'sent' ? undefined : item.turnId));
    if (echo) { consumed.add(echo.id); matched.add(item.id); }
  }
  return { items: items.filter(item => !matched.has(item.id)).map(item => ({ ...item, seenIds: [...new Set([...item.seenIds, ...consumed])].slice(-3000) })), matched };
}
export function queuedMessageView(item: CliQueuedMessage): DashboardCliSessionMessage {
  return { id: `pending-${item.id}`, role: 'user', kind: 'message', text: item.draft.text, timestamp: new Date(item.createdAt).toISOString(), images: item.draft.attachments.filter(file => file.kind === 'image').map(file => ({ src: file.data, alt: file.name })), textAttachments: chatAttachmentPreviews(item.draft.attachments) };
}

/** An acknowledged send is visible before the owner's journal catches up. */
export function withAcceptedQueuedMessages(messages: DashboardCliSessionMessage[], items: CliQueuedMessage[]): DashboardCliSessionMessage[] {
  // Keep the user input in the transcript while the steer/send request is in flight.
  const accepted = queuedMessageEchoes(items, messages).items.filter(item => item.state === 'sending' || item.state === 'sent');
  if (!accepted.length) return messages;
  const result = [...messages], inserted = new Set<string>();
  for (const item of accepted) {
    const seen = new Set(item.seenIds);
    let after = -1;
    result.forEach((message, index) => { if (seen.has(message.id) || inserted.has(message.id)) after = index; });
    const message = { ...queuedMessageView(item), turnId: item.turnId };
    result.splice(after < 0 ? result.length : after + 1, 0, message);
    inserted.add(message.id);
  }
  return result;
}

/** Save the dispatch fence first; reopened in-flight messages require review. */
export function useCliMessageQueue(props: { webview?: boolean; scope?: string; messages: DashboardCliSessionMessage[]; results: CliSubmissionResult[]; canDispatch: boolean; canDispatchDraft?: (draft: CliComposerDraft) => boolean; canSteer?: boolean; dispatchReason?: string; connected?: boolean; turnId?: string; send: (draft: CliComposerDraft) => string | undefined; steer?: (draft: CliComposerDraft) => string | undefined; restore: (draft: CliComposerDraft) => boolean; feedback: (message: string, cancel?: () => Promise<boolean>) => void }) {
  const [items, setItems] = useState<CliQueuedMessage[]>([]), [ready, setReady] = useState(false), [error, setError] = useState<string>(), [loadAttempt, setLoadAttempt] = useState(0);
  const [notice, setNotice] = useState<string>();
  const current = useRef(items), options = useRef(props), noticeVersion = useRef(0); options.current = props;
  const owned = useRef(false), draining = useRef(false), writes = useRef(Promise.resolve(true)), generation = useRef(0), releaseInBackground = useRef<() => void>(() => {});
  const loadFailed = (message: string) => { setError(message); };
  const update = (next: CliQueuedMessage[]) => { current.current = next; setItems(next); };
  const save = (next: CliQueuedMessage[], scope = options.current.scope) => {
    const snapshot = structuredClone(next.filter(item => item.state !== 'sent'));
    const work = writes.current.catch(() => false).then(() => scope ? writeBrowserCache(`message-queue:${scope}`, snapshot) : true);
    writes.current = work; return work;
  };
  useEffect(() => {
    const epoch = ++generation.current;
    owned.current = false; draining.current = false; update([]); setReady(false); setError(undefined); setNotice(undefined);
    if (!props.scope) return;
    let release = () => {}, disposed = false, waiting = false;
    const scope = props.scope;
    const isForeground = () => document.visibilityState === 'visible';
    const hasNativeLocks = typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
    if (!hasNativeLocks && !props.webview) {
      loadFailed('This browser cannot safely own a saved message queue. Use a browser with Web Locks support. Your draft is kept.');
      return;
    }
    // VS Code gives each webview an isolated storage origin; keep one owner in that document.
    const requestLock = (work: (lock: object | null) => Promise<void>): Promise<void> => {
      if (hasNativeLocks) return navigator.locks.request(`codex-message-queue:${scope}`, work).then(() => undefined);
      if (fallbackQueueOwners.has(scope)) return work(null);
      const owner = Symbol(scope);
      fallbackQueueOwners.set(scope, owner);
      return work({}).finally(() => { if (fallbackQueueOwners.get(scope) === owner) fallbackQueueOwners.delete(scope); });
    };
    const acquire = () => {
      if (disposed || waiting || owned.current || !isForeground()) return;
      waiting = true; setError(undefined);
      let retryForeground = false;
      void requestLock(async lock => {
        if (disposed) return;
        if (!isForeground()) { retryForeground = true; return; }
        if (!lock) { loadFailed('This session queue is already open in another view. Close that view and retry.'); return; }
        await new Promise<void>(resolve => {
          release = resolve;
          void readBrowserCache<unknown>(`message-queue:${scope}`, Number.MAX_SAFE_INTEGER).then(saved => {
            if (disposed || !isForeground()) { retryForeground = true; resolve(); return; }
            try { update(normalizeCliMessageQueue(saved ?? [])); owned.current = true; setReady(true); setError(undefined); }
            catch (error) { loadFailed((error as Error).message); resolve(); }
          }).catch(error => { if (!disposed) { loadFailed(`Saved queue is unavailable: ${(error as Error).message}`); resolve(); } });
        });
      }).catch(error => { if (!disposed) loadFailed(`Message queue ownership failed: ${(error as Error).message}`); })
        .finally(() => { waiting = false; if (retryForeground && !disposed && isForeground() && !owned.current) acquire(); });
    };
    const foreground = () => {
      if (isForeground()) acquire();
      else if (owned.current && !draining.current && !current.current.length) {
        owned.current = false; setReady(false); setError(undefined); void writes.current.finally(release);
      }
    };
    releaseInBackground.current = () => { if (!isForeground() && owned.current && !draining.current && !current.current.some(item => item.state === 'sending')) foreground(); };
    document.addEventListener('visibilitychange', foreground); window.addEventListener('focus', foreground);
    foreground();
    return () => { disposed = true; releaseInBackground.current = () => {}; document.removeEventListener('visibilitychange', foreground); window.removeEventListener('focus', foreground); if (generation.current === epoch) { owned.current = false; generation.current++; } void writes.current.finally(release); };
  }, [props.scope, props.webview, loadAttempt]);
  useEffect(() => {
    if (!ready || !owned.current) return;
    const reconciled = queuedMessageEchoes(current.current, props.messages);
    if (reconciled.matched.size) {
      update(reconciled.items); void save(reconciled.items).finally(() => releaseInBackground.current());
    }
    const results = new Map(props.results.map(result => [result.requestId, result]));
    let changed = false;
    const next = current.current.map(item => {
      const result = item.requestId && results.get(item.requestId);
      if (!result || !(['sending','uncertain'].includes(item.state) || item.state === 'failed' && result.status === 'completed')) return item;
      changed = true;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'sendCodexCliSessionMessage', ...result, requestId: item.id } }));
      const retryCount = Math.min((item.retryCount ?? 0) + 1, 6);
      return { ...item, state: result.status === 'completed' ? 'sent' as const : 'failed' as const, error: result.message,
        ...(result.status === 'failed' && isRetryableCliSubmissionFailure(result.message) ? { retryAt: Date.now() + Math.min(60_000, 2_000 * 2 ** (retryCount - 1)), retryCount } : { retryAt: undefined }) };
    });
    if (changed) { update(next); void save(next).finally(() => releaseInBackground.current()); }
  }, [props.messages, props.results, ready, items]);
  useEffect(() => {
    if (!ready || !owned.current || draining.current) return;
    const steerAnswer = !props.canDispatch && props.connected !== false && props.canSteer && props.steer;
    if (!props.canDispatch && !steerAnswer) return;
    if (current.current.some(item => item.state === 'sending' || item.state === 'uncertain')) return;
    // A waiting turn needs its answer before ordinary queued follow-ups can run.
    const canDispatchDraft = (item: CliQueuedMessage) => options.current.canDispatchDraft?.(item.draft) !== false;
    const next = steerAnswer ? current.current.find(item => item.state === 'queued' && canDispatchDraft(item) && (item.steerRequested && (props.turnId || !answeredSessionQuestionIds([queuedMessageView(item)]).size) || props.turnId && answeredSessionQuestionIds([queuedMessageView(item)]).size > 0)) : current.current.find(item => item.state === 'queued' && item.steerRequested && canDispatchDraft(item)) ?? current.current.find(item => item.state !== 'sent' && canDispatchDraft(item));
    if (!next || next.state !== 'queued' || !next.durable) return;
    draining.current = true;
    const epoch = generation.current;
    const fenced = { ...next, state: 'sending' as const, seenIds: props.messages.map(message => message.id).slice(-3000), turnId: props.turnId };
    const pending = current.current.map(item => item.id === next.id ? fenced : item); update(pending);
    void save(pending).then(saved => {
      if (epoch !== generation.current || !owned.current) return;
      if (!current.current.some(item => item.id === next.id && item.state === 'sending')) return;
      if (!saved) throw new Error('Browser storage could not save the send state. Your message was kept and was not sent. Free storage before retrying.');
      const currentOptions = options.current;
      const steer = (next.steerRequested && (currentOptions.turnId || !answeredSessionQuestionIds([queuedMessageView(next)]).size) || currentOptions.turnId && answeredSessionQuestionIds([queuedMessageView(next)]).size > 0) && (currentOptions.canSteer ?? currentOptions.canDispatch) ? currentOptions.steer : undefined;
      if (currentOptions.canDispatchDraft?.(next.draft) === false || currentOptions.connected === false || !currentOptions.canDispatch && !steer) { const paused = current.current.map(item => item.id === next.id ? { ...item, state: 'queued' as const } : item); update(paused); void save(paused); return; }
      const turnId = currentOptions.turnId;
      const requestId = steer ? steer(next.draft) : currentOptions.send(next.draft);
      if (!requestId) throw new Error('The message was not sent. It is kept in the conversation. Reconnect before resending.');
      const sent = current.current.map(item => item.id === next.id ? { ...item, requestId, turnId } : item); update(sent); void save(sent);
    }).catch(error => {
      if (epoch !== generation.current) return;
      const message = (error as Error).message;
      const failed = current.current.map(item => item.id === next.id ? { ...item, state: 'failed' as const, error: message } : item);
      update(failed); void save(failed);
    }).finally(() => { if (epoch === generation.current) { draining.current = false; setItems([...current.current]); releaseInBackground.current(); } });
  }, [items, ready, props.canDispatch, props.canDispatchDraft, props.canSteer, props.turnId, props.connected]);
  useEffect(() => {
    const pending = items.find(item => item.state === 'sending');
    if (!pending) return;
    const timer = setTimeout(() => {
      const next = current.current.map(item => item.id === pending.id && item.state === 'sending' ? { ...item, state: 'uncertain' as const, error: 'Confirmation is taking longer than expected. Refresh before retrying; this message will not be sent again automatically.' } : item);
      update(next); void save(next).finally(() => releaseInBackground.current());
    }, Math.max(65_000, chatUploadTimeoutMs(pending.draft.attachments)));
    return () => clearTimeout(timer);
  }, [items.find(item => item.state === 'sending')?.id]);
  useEffect(() => {
    const retryable = items.filter(item => item.state === 'failed' && (item.durable === false && !item.requestId || item.retryAt));
    if (!ready || !owned.current || !retryable.length) return;
    const epoch = generation.current;
    const timer = setTimeout(() => {
      const retryIds = new Set(retryable.filter(item => !item.retryAt || item.retryAt <= Date.now()).map(item => item.id));
      const next = current.current.map(item => retryIds.has(item.id) ? { ...item, state: 'queued' as const, error: undefined, requestId: undefined, turnId: undefined, retryAt: undefined } : item);
      void save(next).catch(() => false).then(saved => {
        if (epoch !== generation.current) return;
        update(current.current.map(item => retryIds.has(item.id) && item.state === 'failed' ? { ...item, ...(saved ? { state: 'queued' as const, error: undefined, requestId: undefined, turnId: undefined, retryAt: undefined, durable: true } : {}) } : item));
      });
    }, Math.max(2_000, Math.min(...retryable.map(item => (item.retryAt ?? Date.now() + 2_000) - Date.now()))));
    return () => clearTimeout(timer);
  }, [items, ready]);
  const remove = async (id: string, restore = false): Promise<boolean> => {
    const item = current.current.find(item => item.id === id);
    if (!owned.current || !item || item.state === 'sending') return false;
    if (restore && !options.current.restore(item.draft)) return false;
    const index = current.current.indexOf(item), epoch = generation.current;
    const next = current.current.filter(item => item.id !== id); update(next);
    const saved = await save(next).catch(() => false);
    if (epoch !== generation.current) return false;
    if (saved) return true;
    if (!current.current.some(item => item.id === id)) {
      const restored = [...current.current];
      restored.splice(Math.min(index,restored.length),0,{...item,state:'failed',error:'The saved message could not be removed. It was kept here; verify it before reopening or resending.'});
      update(restored);
    }
    return false;
  };
  useEffect(() => {
    if (!props.scope) return;
    const scope = props.scope;
    const runtime: QueueRuntime = { items, ready, error, reload: () => setLoadAttempt(value => value + 1), maintain: async clear => {
      if (!owned.current || draining.current) return false;
      const before = current.current, epoch = generation.current;
      const next = clear ? before.filter(item => item.state === 'sending') : before.map(item => item.state === 'failed' && (!item.requestId || isRetryableCliSubmissionFailure(item.error)) ? { ...item, state: 'queued' as const, error: undefined, requestId: undefined, turnId: undefined, retryAt: undefined, durable: false } : item);
      update(next);
      const saved = await save(next).catch(() => false);
      if (epoch !== generation.current) return false;
      if (!saved) { update(before); return false; }
      update(current.current.map(item => item.state === 'queued' ? { ...item, durable: true } : item));
      return true;
    } };
    if (!queueRuntimes.get(scope)?.ready || ready) queueRuntimes.set(scope, runtime);
    return () => { if (queueRuntimes.get(scope) === runtime) queueRuntimes.delete(scope); };
  }, [props.scope, items, ready, error]);
  return { items, ready, error, notice, reason: props.dispatchReason, connected: props.connected !== false, retryLoad: () => setLoadAttempt(value => value + 1),
    steerNow: (id: string) => {
      const item = current.current.find(entry => entry.id === id);
      if (!owned.current || !ready || !item || item.state !== 'queued' || item.steerRequested) return;
      if (options.current.canDispatchDraft?.(item.draft) === false) {
        options.current.feedback('This message changes active task settings. It stays queued until the task finishes.'); return;
      }
      if (options.current.connected === false) {
        options.current.feedback('Reconnecting. Your message stays queued; try Steer after reconnecting.'); return;
      }
      const epoch = generation.current;
      update(current.current.map(entry => entry.id === id ? { ...entry, steerRequested: true, durable: false } : entry));
      void save(current.current).catch(() => false).then(saved => {
        if (epoch !== generation.current) return;
        update(current.current.map(entry => entry.id === id ? { ...entry, durable: saved, ...(!saved ? { state: 'failed' as const, error: 'Steer could not be saved. The message is kept here.' } : {}) } : entry));
      });
    },
    sendNow: (id: string) => {
      const item = current.current.find(item => item.id === id);
      if (!owned.current || !ready || !item || item.state !== 'queued') {
        noticeVersion.current++;
        setNotice('This message is not ready to move. Check its queue status before retrying.'); return;
      }
      if (item.durable === false) return;
      const noticeEpoch = ++noticeVersion.current;
      const next = current.current.filter(item => item.id !== id), epoch = generation.current;
      // Keep any earlier in-flight or unconfirmed send ahead of the waiting messages.
      const index = next.findIndex(item => item.state === 'queued');
      next.splice(index < 0 ? next.length : index, 0, { ...item, durable: false });
      update(next); setNotice('Saving message priority…');
      void save(next).catch(() => false).then(saved => {
        if (epoch !== generation.current || !current.current.some(item => item.id === id && item.state === 'queued')) return;
        const failure = 'Message priority could not be saved. The message was kept and was not sent. Free storage before retrying.';
        update(current.current.map(item => item.id === id ? { ...item, durable: saved, ...(!saved ? { state: 'failed' as const, error: failure } : {}) } : item));
        if (noticeVersion.current === noticeEpoch) setNotice(saved ? options.current.connected === false ? 'Message moved to the top. Waiting for connection.' : 'Message is first in line. It will send when this session can accept it.' : failure);
      });
    },
    enqueue: (draft: CliComposerDraft): string | undefined => {
      const normalized = normalizeCliComposerDraft(draft);
      if (!normalized || !normalized.text.trim() && !normalized.attachments.length) { props.feedback('This message could not be queued. Check its text and attachments.'); return; }
      if (!owned.current || !ready) { props.feedback('The saved message queue is not ready. Your composer draft is kept.'); return; }
      const answers = answeredSessionQuestionIds([{ id: 'answer', role: 'user', text: normalized.text }]);
      if (answers.size) {
        const duplicate = current.current.find(item => [...answeredSessionQuestionIds([queuedMessageView(item)])].some(id => answers.has(id)));
        if (duplicate) { props.feedback('An answer to this question is already in the conversation queue. Review it there before retrying.'); return duplicate.id; }
        const sent = answeredSessionQuestionIds(props.messages);
        if ([...answers].some(id => sent.has(id))) { props.feedback('This question was already answered. Refresh the conversation before replying again.'); return; }
      }
      const duplicate = current.current.find(item => ['queued', 'sending', 'uncertain'].includes(item.state)
        && item.draft.text === normalized.text
        && JSON.stringify(item.draft.attachments) === JSON.stringify(normalized.attachments));
      if (duplicate) {
        props.feedback('This message is already queued or being sent. Review the conversation before retrying.');
        return duplicate.id;
      }
      if (current.current.length >= CLI_MESSAGE_QUEUE_LIMIT || JSON.stringify([...current.current, draft]).length * 2 > MAX_CLI_MESSAGE_QUEUE_BYTES - 8192) { props.feedback('The local message queue is full. Send or remove queued messages before adding another. Your draft is kept.'); return; }
      const item: CliQueuedMessage = { id: crypto.randomUUID(), draft: structuredClone(normalized), state: 'queued', createdAt: Date.now(), seenIds: [], ...(answers.size?{steerRequested:true}:{}) };
      const next = [...current.current, item]; update(next);
      const epoch = generation.current;
      void save(next).then(saved => {
        if (epoch !== generation.current) return;
        const updated = current.current.map(entry => entry.id === item.id ? { ...entry, durable: saved, ...(saved ? {} : { state: 'failed' as const, error: 'Local storage is unavailable. Your message was not sent; copy it from the conversation before closing.' }) } : entry);
        update(updated);
      });
      return item.id;
    },
    resend: (id: string) => {
      const item = current.current.find(item => item.id === id);
      if (!owned.current || !ready || !item || !['failed','uncertain'].includes(item.state)) return;
      const next = current.current.map(entry => entry.id === id ? { ...entry, state: 'queued' as const, requestId: undefined, turnId: undefined, error: undefined, seenIds: [], durable: false } : entry);
      update(next);
      const epoch = generation.current;
      void save(next).then(saved => {
        if (epoch !== generation.current) return;
        const updated = current.current.map(entry => entry.id === id ? { ...entry, durable: saved, ...(saved ? {} : { state: 'failed' as const, error: 'Storage could not save the resend. It was not sent. Free storage and try Resend again.' }) } : entry);
        update(updated);
      });
    },
    remove
  };
}

