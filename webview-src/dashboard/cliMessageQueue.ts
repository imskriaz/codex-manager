import { chatUploadTimeoutMs, chatAttachmentPreviews, MAX_CHAT_WIRE_BYTES } from "../../src/domain/chatAttachments";
import type { DashboardCliSessionMessage } from '../../src/domain/dashboard/types';
import { answeredSessionQuestionIds } from '../../src/domain/sessionQuestions';
import { normalizeCliComposerDraft, type CliComposerDraft, type CliSubmissionResult, isCliSubmissionEcho } from './cliSessionComposerState';
import { useEffect, useRef, useState } from 'preact/hooks';
import { readBrowserCache, writeBrowserCache } from './cliSessionCache';

export type CliQueuedMessage = { id: string; draft: CliComposerDraft; state: 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain'; createdAt: number; requestId?: string; seenIds: string[]; turnId?: string; durable?: boolean; error?: string };
export const CLI_MESSAGE_QUEUE_LIMIT = 20;
export const MAX_CLI_MESSAGE_QUEUE_BYTES = MAX_CHAT_WIRE_BYTES * 2;
export function normalizeCliMessageQueue(value: unknown): CliQueuedMessage[] {
  if (!Array.isArray(value) || value.length > CLI_MESSAGE_QUEUE_LIMIT || JSON.stringify(value).length * 2 > MAX_CLI_MESSAGE_QUEUE_BYTES) throw new Error('The saved message queue could not be read. It was kept for recovery.');
  const ids = new Set<string>();
  return (value as unknown[]).map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Unreadable saved message. It was kept for recovery.');
    const item = raw as Partial<CliQueuedMessage>;
    const draft = normalizeCliComposerDraft(item?.draft);
    if (!draft || !item || typeof item.id !== 'string' || item.id.length > 256 || ids.has(item.id) || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || item.createdAt < 0 || item.createdAt > 8.64e15 || typeof item.state !== 'string' || !['queued','sending','sent','failed','uncertain'].includes(item.state) || !Array.isArray(item.seenIds) || item.seenIds.length > 3000 || item.seenIds.some((id: unknown) => typeof id !== 'string' || id.length > 256) || (!draft.text.trim() && !draft.attachments.length)) throw new Error('The saved message queue contains unreadable content. It was kept for recovery.');
    ids.add(item.id);
    return { id: item.id, draft, state: item.state === 'sending' || item.state === 'sent' ? 'uncertain' : item.state, createdAt: item.createdAt, seenIds: item.seenIds, ...(typeof item.requestId === 'string' ? { requestId: item.requestId } : {}), ...(typeof item.turnId === 'string' ? { turnId: item.turnId } : {}), durable: true, ...(typeof item.error === 'string' ? { error: item.error } : {}) };
  });
}
export function queuedMessageEchoes(items: CliQueuedMessage[], messages: DashboardCliSessionMessage[]) {
  const consumed = new Set<string>(), matched = new Set<string>();
  for (const item of items) {
    if (item.state === 'queued') continue;
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
export function useCliMessageQueue(props: { scope?: string; messages: DashboardCliSessionMessage[]; results: CliSubmissionResult[]; canDispatch: boolean; canSteer?: boolean; dispatchReason?: string; connected?: boolean; turnId?: string; send: (draft: CliComposerDraft) => string | undefined; steer?: (draft: CliComposerDraft) => string | undefined; restore: (draft: CliComposerDraft) => boolean; feedback: (message: string) => void }) {
  const [items, setItems] = useState<CliQueuedMessage[]>([]), [ready, setReady] = useState(false), [error, setError] = useState<string>(), [loadAttempt, setLoadAttempt] = useState(0);
  const [notice, setNotice] = useState<string>();
  const current = useRef(items), options = useRef(props), noticeVersion = useRef(0); options.current = props;
  const owned = useRef(false), draining = useRef(false), writes = useRef(Promise.resolve(true)), generation = useRef(0);
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
    let release = () => {}, disposed = false;
    const scope = props.scope;
    if (!navigator.locks) { loadFailed('This browser cannot safely own a saved message queue. Open this session in a current browser. Your composer draft is kept.'); return; }
    void navigator.locks.request(`codex-message-queue:${scope}`, { ifAvailable: true }, async lock => {
      if (disposed) return;
      if (!lock) { loadFailed('This session queue is open in another tab. Close it and refresh this view before sending here. Your draft is kept.'); return; }
      await new Promise<void>(resolve => {
        release = resolve;
        void readBrowserCache<unknown>(`message-queue:${scope}`, Number.MAX_SAFE_INTEGER).then(saved => {
          if (disposed) return;
          try { update(normalizeCliMessageQueue(saved ?? [])); owned.current = true; setReady(true); }
          catch (error) { loadFailed((error as Error).message); }
        }).catch(error => { if (!disposed) { loadFailed(`Saved queue is unavailable: ${(error as Error).message}`); resolve(); } });
      });
    }).catch(error => { if (!disposed) loadFailed(`Message queue ownership failed: ${(error as Error).message}`); });
    return () => { disposed = true; if (generation.current === epoch) { owned.current = false; generation.current++; } void writes.current.finally(release); };
  }, [props.scope, loadAttempt]);
  useEffect(() => {
    if (!ready || !owned.current) return;
    const reconciled = queuedMessageEchoes(current.current, props.messages);
    if (reconciled.matched.size) {
      update(reconciled.items); void save(reconciled.items);
    }
    const results = new Map(props.results.map(result => [result.requestId, result]));
    let changed = false;
    const next = current.current.map(item => {
      const result = item.requestId && results.get(item.requestId);
      if (!result || !(['sending','uncertain'].includes(item.state) || item.state === 'failed' && result.status === 'completed')) return item;
      changed = true;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'sendCodexCliSessionMessage', ...result, requestId: item.id } }));
      return { ...item, state: result.status === 'completed' ? 'sent' as const : 'failed' as const, error: result.message };
    });
    if (changed) { update(next); void save(next); }
  }, [props.messages, props.results, ready, items]);
  useEffect(() => {
    if (!ready || !owned.current || !props.canDispatch || draining.current) return;
    const next = current.current.find(item => item.state !== 'sent');
    if (!next || next.state !== 'queued' || !next.durable) return;
    draining.current = true;
    const epoch = generation.current;
    const fenced = { ...next, state: 'sending' as const, seenIds: props.messages.map(message => message.id).slice(-3000), turnId: props.turnId };
    const pending = current.current.map(item => item.id === next.id ? fenced : item); update(pending);
    void save(pending).then(saved => {
      if (epoch !== generation.current || !owned.current) return;
      if (!current.current.some(item => item.id === next.id && item.state === 'sending')) return;
      if (!saved) throw new Error('Browser storage could not save the send state. Your message was kept and was not sent. Free storage before retrying.');
      if (!options.current.canDispatch) { const paused = current.current.map(item => item.id === next.id ? { ...item, state: 'queued' as const } : item); update(paused); void save(paused); return; }
      const requestId = options.current.send(next.draft);
      if (!requestId) throw new Error('The message was not sent. It is kept in the conversation. Reconnect before resending.');
      const sent = current.current.map(item => item.id === next.id ? { ...item, requestId } : item); update(sent); void save(sent);
    }).catch(error => {
      if (epoch !== generation.current) return;
      const message = (error as Error).message;
      const failed = current.current.map(item => item.id === next.id ? { ...item, state: 'failed' as const, error: message } : item);
      update(failed); void save(failed);
    }).finally(() => { if (epoch === generation.current) { draining.current = false; setItems([...current.current]); } });
  }, [items, ready, props.canDispatch, props.turnId]);
  useEffect(() => {
    const pending = items.find(item => item.state === 'sending');
    if (!pending) return;
    const timer = setTimeout(() => {
      const next = current.current.map(item => item.id === pending.id && item.state === 'sending' ? { ...item, state: 'uncertain' as const, error: 'Confirmation is taking longer than expected. Refresh before retrying; this message will not be sent again automatically.' } : item);
      update(next); void save(next);
    }, Math.max(65_000, chatUploadTimeoutMs(pending.draft.attachments)));
    return () => clearTimeout(timer);
  }, [items.find(item => item.state === 'sending')?.id]);
  return { items, ready, error, notice, reason: props.dispatchReason, connected: props.connected !== false, retryLoad: () => setLoadAttempt(value => value + 1),
    steerNow: (id: string) => {
      const item = current.current.find(entry => entry.id === id), epoch = generation.current;
      if (!owned.current || !ready || !item || item.state !== 'queued' || item.durable === false) { setNotice('This message is not ready to steer. Check its queue status before retrying.'); return; }
      if (!(options.current.canSteer ?? options.current.canDispatch) || options.current.connected === false) { const message = options.current.dispatchReason ?? 'This session cannot accept a steer yet. The message remains queued.'; setNotice(message); options.current.feedback(message); return; }
      if (draining.current || current.current.some(entry => entry.state === 'sending')) { const message = 'Another queued message is already sending. Wait for confirmation before steering this message.'; setNotice(message); options.current.feedback(message); return; }
      draining.current = true;
      const sending = { ...item, state: 'sending' as const, durable: false, seenIds: options.current.messages.map(message => message.id).slice(-3000), turnId: options.current.turnId };
      update(current.current.map(entry => entry.id === id ? sending : entry)); setNotice('Steering…');
      void save(current.current).then(saved => {
        if (epoch !== generation.current || !owned.current) return;
        if (!current.current.some(entry => entry.id === id && entry.state === 'sending')) return;
        if (!saved) throw new Error('Browser storage could not save the steer state. The message was kept and was not sent.');
        if (!(options.current.canSteer ?? options.current.canDispatch) || options.current.connected === false) throw new Error('The session cannot accept this message yet. It was kept and was not sent.');
        const turnId = options.current.turnId;
        const requestId = options.current.steer ? options.current.steer(item.draft) : options.current.send(item.draft);
        if (!requestId) throw new Error('The steer was not sent. The message is kept in the queue.');
        const sent = current.current.map(entry => entry.id === id ? { ...entry, requestId, durable: true, turnId } : entry);
        update(sent); void save(sent);
      }).catch(error => {
        if (epoch !== generation.current) return;
        const message = error instanceof Error ? error.message : String(error);
        const failed = current.current.map(entry => entry.id === id ? { ...entry, state: 'failed' as const, durable: true, error: message } : entry);
        update(failed); void save(failed); setNotice(message);
      }).finally(() => { if (epoch === generation.current) draining.current = false; });
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
      if (current.current.length >= CLI_MESSAGE_QUEUE_LIMIT || JSON.stringify([...current.current, draft]).length * 2 > MAX_CLI_MESSAGE_QUEUE_BYTES - 8192) { props.feedback('The local message queue is full. Send or remove queued messages before adding another. Your draft is kept.'); return; }
      const item: CliQueuedMessage = { id: crypto.randomUUID(), draft: structuredClone(normalized), state: 'queued', createdAt: Date.now(), seenIds: [] };
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
    remove: (id: string, restore = false) => {
      const item = current.current.find(item => item.id === id);
      if (!owned.current || !item || item.state === 'sending') return;
      if (restore && !props.restore(item.draft)) return;
      const index = current.current.indexOf(item), epoch = generation.current;
      const next = current.current.filter(item => item.id !== id); update(next);
      void save(next).then(saved => {
        if (saved || epoch !== generation.current || current.current.some(item => item.id === id)) return;
        const restored = [...current.current];
        restored.splice(Math.min(index,restored.length),0,{...item,state:'failed',error:'The saved message could not be removed. It was kept here; verify it before reopening or resending.'});
        update(restored);
      });
    }
  };
}

