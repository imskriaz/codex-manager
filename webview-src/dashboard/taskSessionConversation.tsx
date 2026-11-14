import { useTaskViewPosition } from './taskViewPosition';
import { isSessionConnectionFailure, sessionFailureMessage } from '../../src/domain/sessionFailure';
import { isCodexSessionRunning } from '../../src/domain/codexSessionState';
import { useSessionResume } from './sessionResume';
import { isCliLiveStateCurrent, reconcileCliSessionStatus } from './cliSessionLiveState';
import { cliSessionTargetKey } from './cliSessionRoute';
import { useSessionAccess } from './sessionAccess';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardCliComposerConfig, DashboardCliSessionMessage, DashboardCliSessionSummary, DashboardCodexSessionLiveState, DashboardHostMessage, DashboardNotice } from '../../src/domain/dashboard/types';
import { prepareChatInput, validateChatAttachments } from '../../src/domain/chatAttachments';
import { combineCliLiveMessages } from '../../src/domain/codexSessionLive';
import { Composer, LiveTurnDetails, QueuedMessages, SessionTranscript, summarizeChangedFiles, TurnUsageStrip } from './cliSessionsModal';
import { readChatAttachmentFiles } from './attachmentUploads';
import { acknowledgeCliComposerDraft, canRestoreCliComposerDraft, cliComposerDraftKey, resolveCliComposerSettings, restoreFailedCliComposerDraft, type CliComposerDraft, type CliSubmissionResult } from './cliSessionComposerState';
import { readCliComposerDraft, writeCliComposerDraft } from './cliSessionCache';
import { useCliMessageQueue, queuedMessageView } from './cliMessageQueue';
import { useCodexSessionPrompts } from './codexSessionPromptHook';
import { CodexSessionRequest } from './codexSessionRequest';
import { codexPromptKey } from './codexSessionPrompts';
import type { SendAction } from './hookTypes';

export function TaskSessionConversation(props: {
  session: DashboardCliSessionSummary; messages: DashboardCliSessionMessage[]; connected: boolean; deviceId?: string;
  config?: DashboardCliComposerConfig; liveState?: DashboardCodexSessionLiveState; sendAction: SendAction;
  peers?: Array<{ id: string; connected: boolean; local?: boolean }>;
  onRefresh: () => void; onFeedback: (notice: DashboardNotice) => void; onChanges?: () => void; onOpenFile?: (path: string) => void;
}) {
  const draftEdited = useRef(false);
  const scope = cliComposerDraftKey(props.deviceId ?? props.session.deviceId, props.session.id, undefined, window.self !== window.top);
  const [draft, setDraft] = useState<CliComposerDraft>({ text: '', attachments: [] }), [ready, setReady] = useState(false), [reading, setReading] = useState(false);
  const [results, setResults] = useState<CliSubmissionResult[]>([]), [stopping, setStopping] = useState<string>();
  const [height, setHeight] = useState(160), [notice, setNotice] = useState<DashboardNotice>();
  const resizeCleanup = useRef<() => void>();
  const current = useRef(draft); current.current = draft;
  const currentScope = useRef(scope); currentScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => { if (props.connected !== false) setNotice(value => value && /reconnect|offline|connection lost/i.test(value.message) ? undefined : value); }, [props.connected]);
  const report = (input: DashboardNotice) => { const value = { ...input, message: sessionFailureMessage(input.message, 'Task management') }; if (currentScope.current === scope) setNotice(value); props.onFeedback(value); };
  useEffect(() => setNotice(undefined), [scope]);
  useEffect(() => {
    if (notice?.level !== 'info') return;
    const timer = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const settings = resolveCliComposerSettings(draft, props.config, props.session);
  const followUpMode = settings.followUpMode ?? 'steer';
  const access = useSessionAccess({ session: props.session, connected: props.connected,
    send: (sandboxMode, autoApprove) => props.sendAction('setCodexSessionAccess', undefined, { sessionId: props.session.id, sandboxMode, autoApprove, targetDeviceId: props.session.deviceId, projectPath: props.session.projectPath }), feedback: report });
  const messages = combineCliLiveMessages(props.messages, props.liveState);
  const recoveryRead = useRef(props.onRefresh); recoveryRead.current = props.onRefresh;
  const connectionInterrupted = props.liveState?.status === 'disconnected' || isSessionConnectionFailure(messages.at(-1)?.kind === 'error' ? messages.at(-1)!.text : '');
  useEffect(() => {
    if (!connectionInterrupted || !props.connected) return;
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') recoveryRead.current(); }, 15_000);
    return () => clearInterval(timer);
  }, [connectionInterrupted, props.connected, scope]);

  const session = reconcileCliSessionStatus(props.session, props.liveState ? { [cliSessionTargetKey(props.session)]: props.liveState } : {});
  const running = isCodexSessionRunning(session);
  const resume = useSessionResume({ session, connected: props.connected,
    blocked: running || !!stopping || access.pending, send: () => props.sendAction('resumeCodexSessions', undefined, { sessionId: props.session.id, targetDeviceId: props.session.deviceId }), feedback: report });
  const steerTurnId = session.steerTurnId ?? (isCliLiveStateCurrent(session, props.liveState) && ['starting','running'].includes(props.liveState?.status ?? '') ? props.liveState?.turnId : undefined);
  const prompts = useCodexSessionPrompts({ target: props.session, browser: true, connected: props.connected, peers: props.peers, sendAction: props.sendAction, onNotice: report });
  useEffect(() => {
    mounted.current = true;
    void readCliComposerDraft(scope).then(saved => { if (mounted.current) { if (saved && !draftEdited.current) setDraft(saved); setReady(true); } });
    return () => { mounted.current = false; resizeCleanup.current?.(); };
  }, [scope]);
  const [storageError, setStorageError] = useState<{ scope: string; notice: DashboardNotice }>();
  useEffect(() => {
    if (ready) void writeCliComposerDraft(scope, draft).then(saved => {
      if (!mounted.current) return;
      if (saved || !draft.text && !draft.attachments.length) setStorageError(previous => previous?.scope === scope ? undefined : previous);
      else setStorageError({ scope, notice: { level: 'warning', message: 'Browser storage could not save this draft. Copy it before closing.' } });
    });
  }, [draft, ready, scope]);
  const queue = useCliMessageQueue({ scope, messages, results, connected: props.connected,
    canDispatch: props.connected && !access.pending && !resume.pending && !props.session.archived && props.session.status !== 'unknown' && !stopping && (!running || followUpMode === 'steer' && !!steerTurnId),
    canSteer: props.connected && !access.pending && !resume.pending && !props.session.archived && props.session.status !== 'unknown' && !stopping && (!running || !!steerTurnId),
    turnId: running ? steerTurnId : undefined,
    send: value => props.sendAction(followUpMode === 'steer' && running && steerTurnId ? 'steerCodexCliSessionTurn' : 'sendCodexCliSessionMessage', undefined, { ...value, sandboxMode: undefined, sessionId: props.session.id, projectPath: props.session.projectPath, targetDeviceId: props.session.deviceId, ...(followUpMode === 'steer' && running && steerTurnId ? { expectedTurnId: steerTurnId } : {}) }),
    steer: value => steerTurnId && running
      ? props.sendAction('steerCodexCliSessionTurn', undefined, { ...value, sandboxMode: undefined, sessionId: props.session.id, projectPath: props.session.projectPath, targetDeviceId: props.session.deviceId, expectedTurnId: steerTurnId })
      : !running ? props.sendAction('sendCodexCliSessionMessage', undefined, { ...value, sandboxMode: undefined, sessionId: props.session.id, projectPath: props.session.projectPath, targetDeviceId: props.session.deviceId }) : undefined,
    restore: value => { if (!canRestoreCliComposerDraft(current.current, value)) { report({ level: 'warning', message: 'Your newer draft was kept. Clear or send it before moving the failed message from the queue.' }); return false; } current.current = restoreFailedCliComposerDraft(current.current, value); setDraft(current.current); return true; },
    feedback: message => report({ level: 'warning', message })
  });
  useEffect(() => {
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const result = event.data;
      if (result?.type !== 'dashboard:action-result') return;
      if (result.requestId === stopping) { setStopping(undefined); report({ level: result.status === 'completed' ? 'info' : 'error', message: result.status === 'completed' ? 'Turn stopped.' : result.error || 'Stop was not confirmed. Refresh the conversation.' }); }
      if (['sendCodexCliSessionMessage','steerCodexCliSessionTurn'].includes(result.action)) {
        setResults(previous => [...previous, { requestId: result.requestId, status: result.status, message: result.error }].slice(-128));
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [stopping]);
  useEffect(() => {
    if (!stopping) return;
    const timer = setTimeout(() => { setStopping(undefined); report({ level: 'warning', message: 'Stop is awaiting confirmation. Refresh the conversation before retrying.' }); }, 15_000);
    return () => clearTimeout(timer);
  }, [stopping]);
  const submit = () => {
    if (!ready || reading) return;
    const value = { ...current.current, ...settings, sandboxMode: undefined, text: current.current.text, attachments: current.current.attachments };
    try { prepareChatInput(value.text, value.attachments); }
    catch (error) { report({ level: 'error', message: (error as Error).message }); return; }
    if (!value.text.trim() && !value.attachments.length) return;
    const id = queue.enqueue(value);
    if (id) { setNotice(undefined); setDraft(previous => acknowledgeCliComposerDraft(previous, value)); }
    return id;
  };
  const attach = async (files: File[]) => {
    if (reading) return;
    setReading(true);
    try { const added = await readChatAttachmentFiles(files, current.current.attachments.length); setDraft(previous => ({ ...previous, attachments: validateChatAttachments([...previous.attachments, ...added]) })); }
    catch (error) { report({ level: 'error', message: (error as Error).message }); }
    finally { if (mounted.current) setReading(false); }
  };
  const files = summarizeChangedFiles(messages);
  const patch = (value: Partial<CliComposerDraft>) => { draftEdited.current = true; setDraft(previous => ({ ...previous, ...value })); };
  const transcriptPosition = useTaskViewPosition(`task-scroll:${scope}`);
  return <section class="task-session-conversation cli-workspace cli-message-surface" aria-label="Session conversation">
    <div ref={transcriptPosition} class="task-session-transcript cli-session-messages"><SessionTranscript page="Task management" messages={messages} running={running} onActionFeedback={report} onQuestionReply={!props.session.archived ? text => queue.enqueue({ text, attachments: [] }) : undefined} questionDisabled={!queue.ready} questionScope={scope} queuedAnswers={queue.items.map(queuedMessageView)} onDraftMessage={(text, quote) => patch({ text: quote ? '> ' + text.split('\n').join('\n> ') + '\n\n' : text })} onOpenReviews={props.onChanges} onOpenFile={props.onOpenFile} />
       {props.liveState?.plan ? <LiveTurnDetails state={{ ...props.liveState, tokenUsage: undefined, rateLimits: undefined }} /> : null}
    </div>
    <div class="task-session-compose">
      {prompts.active ? <p class="task-attention" role="status">Needs your input</p> : null}
      <QueuedMessages queue={queue} onRefresh={props.onRefresh} />
      {prompts.active ? <CodexSessionRequest entry={prompts.active} inline queuedCount={prompts.entries.length - 1} connected={prompts.connectedTo(prompts.active)} checking={prompts.checking} onCheck={() => prompts.active && prompts.check(codexPromptKey(prompts.active.request))} onAnswer={prompts.answer} onRespond={prompts.respond} /> : null}
      <TurnUsageStrip privacyMode contextLabel={props.session.title.trim() || props.session.projectPath?.split(/[\\/]/).filter(Boolean).pop() || "Task conversation"} changedFiles={files.length} additions={files.reduce((sum, file) => sum + file.additions, 0)} deletions={files.reduce((sum, file) => sum + file.deletions, 0)} onOpenChanges={() => props.onChanges?.()} />
      <Composer onFeedback={report} deviceId={props.deviceId ?? props.session.deviceId} onRetryFeedback={queue.error ? queue.retryLoad : undefined} feedback={notice ?? (queue.error ? {level:"warning",message:queue.error} : undefined) ?? (storageError?.scope === scope ? storageError.notice : undefined)} draft={draft.text} attachments={draft.attachments} attachmentReading={reading} onAttach={files => void attach(files)} onRemoveAttachment={id => patch({ attachments: draft.attachments.filter(file => file.id !== id) })} {...settings} sandboxMode={access.mode} followUpMode={followUpMode} onFollowUpMode={mode => patch({ followUpMode: mode })} permissionProfile={access.profile} accessDisabled={!props.connected || access.pending || props.session.status === "unknown"} accessStatus={access.status} projectLocked projectPath={props.session.projectPath} projects={[]} models={props.config?.models ?? []} reasoningOptions={['low','medium','high','xhigh']} sending={running} onResume={resume.available ? resume.resume : undefined} resuming={resume.pending} resumeDisabled={!props.connected || access.pending || !queue.ready || queue.items.length > 0} stopping={!!stopping} canSteer={followUpMode === 'steer' && !!steerTurnId} submitDisabled={!ready || !queue.ready || !!props.session.archived} stopDisabled={!props.connected || !props.session.canStop && !props.liveState?.turnId} unavailableReason={!props.connected ? 'Reconnecting…' : props.session.archived ? 'Restore this archived session before sending' : undefined} tokenUsage={props.liveState?.tokenUsage ?? props.session.tokenUsage}
        autoApprove={access.autoApprove} onAutoApprove={enabled => access.change(undefined, enabled)}
        onDraft={text => { setNotice(undefined); patch({ text }); }} onModel={model => patch({ model })} onReasoning={reasoningEffort => patch({ reasoningEffort })} onSandbox={access.change} onProject={() => {}} onSubmit={() => { submit(); }} onStop={() => { const id = props.sendAction('cancelCodexCliSessionTurn', undefined, { sessionId: props.session.id, targetDeviceId: props.session.deviceId }); if (id) setStopping(id); else report({ level: 'warning', message: 'Stop was not sent. Reconnect before retrying.' }); }} composerHeight={height} onResize={event => {
          event.preventDefault(); resizeCleanup.current?.();
          const start = event.clientY, initial = height;
          const move = (event: PointerEvent) => setHeight(Math.max(120, Math.min(400, initial + start - event.clientY)));
          const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
          resizeCleanup.current = stop; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
        }} onResizeKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') setHeight(value => Math.max(120, Math.min(400, value + (event.key === 'ArrowUp' ? 20 : -20)))); }} />
    </div>
  </section>;
}

