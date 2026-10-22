import { AttachmentPicker, AttachmentIcon } from './attachmentUploads';
import { validateChatAttachments, type ChatAttachment } from '../../src/domain/chatAttachments';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChildren } from 'preact';
import type { DashboardCliProject, DashboardCliSessionSummary, DashboardHostMessage, DashboardActionName, DashboardActionPayload, DashboardActionResultPayload, DashboardNotice } from '../../src/domain/dashboard/types';
import type { ProjectBoard, ProjectTask, ProjectTaskDetails, ProjectTaskFile, ProjectTaskMutation, TaskStage, ProjectSharePermission, ProjectCommentInput, ProjectAttachment } from '../../src/domain/projectTasks';
import { projectTaskActivity } from '../../src/domain/projectTaskActivity';
import { combineCliLiveMessages } from '../../src/domain/codexSessionLive';
import { listConversationFiles, readConversationAttachment } from '../../src/domain/conversationFiles';
import { projectTaskStages, sessionTaskStage, taskSessionAgents, PROJECT_SHARE_FEATURES, projectAttachmentPath } from '../../src/domain/projectTasks';
import { readBrowserCache, writeBrowserCache, listBrowserOutbox, deleteBrowserCache } from './cliSessionCache';
import { handleTabKeyDown, ModalShell, TaskDetailPanel } from './primitives';
import { ShareAccessReview, ShareLinkField } from './shareControls';
import { AgentWorkspace, SessionMessage, TurnCopyButton } from './cliSessionsModal';
import { cliSessionTargetKey } from './cliSessionRoute';
import type { SendAction } from './hookTypes';
import { renderRefreshIcon, renderSyncIcon } from './icons';
import { loadTaskBoardColumns, saveTaskBoardColumns } from './preferences';

type Outbox = { savedAt: number; project: string; device?: string; lastError?: string; task?: ProjectTaskMutation; comment?: ProjectCommentInput };
type TaskCard = ProjectTask & { session?: DashboardCliSessionSummary };
type DetailTab = NonNullable<DashboardActionPayload['taskView']>;
const stages: TaskStage[] = ['idea', 'planned', 'running', 'completed'];
const tabs: Array<Extract<DetailTab, 'activities' | 'files' | 'changes'>> = ['activities', 'files', 'changes'];
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() || value;
const label = (value: string) => value[0]!.toUpperCase() + value.slice(1);
const boardScope = (device: string | undefined, project: string) => JSON.stringify([device ?? 'local', project]);

export function TaskBoard(props: {
  sessions: DashboardCliSessionSummary[]; projects?: DashboardCliProject[]; connected: boolean; targetDeviceId?: string; active?: boolean;
  shared?: { draftKey: string; board: ProjectBoard; permissions: ProjectSharePermission[]; request: (action: DashboardActionName, payload: DashboardActionPayload) => Promise<DashboardActionResultPayload> };
  selectedSystem?: string;
  onActionFeedback?: (notice: DashboardNotice) => void;
  systemName?: string; sendAction: SendAction; onOpenSession: (session: DashboardCliSessionSummary) => void;
}) {
  const can = (feature: ProjectSharePermission) => !props.shared || props.shared.permissions.includes(feature) || feature === 'activities' && props.shared.permissions.includes('messages');
  const sessionsRef = useRef(props.sessions);
  sessionsRef.current = props.active === false ? [] : props.sessions;
  const sessions = sessionsRef.current;
  const [extraProjects, setExtraProjects] = useState<string[]>([]), [projectInput, setProjectInput] = useState('');
  const projects = useMemo(() => [...new Set([...extraProjects, ...(props.projects ?? []).map(project => project.path), ...sessions.filter(session => session.deviceId === props.targetDeviceId).flatMap(session => session.projectPath ? [session.projectPath] : [])])], [extraProjects, props.projects, sessions, props.targetDeviceId]);
  const [project, setProject] = useState(''), [board, setBoard] = useState<ProjectBoard>();
  const [outbox, setOutbox] = useState<Array<{ key: string; value: Outbox }>>([]);
  const outboxRef = useRef(outbox); outboxRef.current = outbox;
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<TaskCard>();
  const [title, setTitle] = useState(''), [prompt, setPrompt] = useState(''), [parent, setParent] = useState(''), [comment, setComment] = useState('');
  const [taskUploads, setTaskUploads] = useState<ChatAttachment[]>([]), [commentUploads, setCommentUploads] = useState<ChatAttachment[]>([]);
  const [taskReading, setTaskReading] = useState(false), [commentReading, setCommentReading] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<DashboardActionResultPayload['workspaceFile']>();
  const attachmentRequest = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null), searchToggle = useRef<HTMLButtonElement>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; confirm: string; danger?: boolean; run: () => void }>();
  const [search, setSearch] = useState(''), [dropStage, setDropStage] = useState<TaskStage>();
  const [showArchive, setShowArchive] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false), [hiddenSearch, setHiddenSearch] = useState(''), [hiddenLimit, setHiddenLimit] = useState(100);
  const [view, setView] = useState<'board' | 'list' | 'gantt' | 'calendar'>('board');
  const [visibleStages, setVisibleStages] = useState<TaskStage[]>(loadTaskBoardColumns);
  const [stageFilter, setStageFilter] = useState<TaskStage | 'all'>('all');
  const [tab, setTab] = useState<DetailTab | 'agents'>('overview'), [cursor, setCursor] = useState<string>();
  const [details, setDetails] = useState<ProjectTaskDetails>(), [detailLoading, setDetailLoading] = useState(false);
  const readTab: DetailTab = tab === 'agents' ? 'activities' : tab === 'overview' && props.shared ? can('activities') ? 'activities' : can('files') ? 'files' : 'changes' : tab;
  const canReadTab = readTab === 'overview' ? !props.shared : can(readTab);
  const [file, setFile] = useState<DashboardActionResultPayload['workspaceFile']>();
  const [status, setStatusValue] = useState(''), [busy, setBusy] = useState(false);
  const [statusLevel, setStatusLevel] = useState<'info' | 'warning' | 'error'>('warning');
  const setStatus = (message: string, level: 'info' | 'warning' | 'error' = 'warning') => { setStatusValue(message); setStatusLevel(level); if (message && !props.shared && !shareBusy.current) props.onActionFeedback?.({level, message}); };
  const [shareOpen, setShareOpen] = useState(false), [share, setShare] = useState<{ url: string; expiresAt: number; permissions: ProjectSharePermission[] }>();
  const [sharePermissions, setSharePermissions] = useState<ProjectSharePermission[]>(['activities', 'comments', 'submissions']);
  const [shareDays, setShareDays] = useState(7);
  const [shareError, setShareError] = useState(false);
  useEffect(() => {
    if (!status || shareOpen) return;
    const timer = setTimeout(() => setStatusValue(''), statusLevel === 'info' ? 3000 : 10000);
    return () => clearTimeout(timer);
  }, [status, statusLevel, shareOpen]);
  const shareBusy = useRef(false);
  const [attachId, setAttachId] = useState(''), [newSession, setNewSession] = useState(false), [subtaskPrompt, setSubtaskPrompt] = useState('');
  useEffect(() => { setSearch(''); setSearchOpen(false); }, [props.targetDeviceId, project]);
  const ownerDeviceId = props.targetDeviceId ?? props.selectedSystem;
  const scope = boardScope(ownerDeviceId, project), active = useRef(scope); active.current = scope;
  const deviceRef = useRef(props.targetDeviceId); deviceRef.current = props.targetDeviceId;
  const selection = useRef(selected?.id); selection.current = selected?.id;
  const detailView = useRef({ tab: readTab, cursor }); detailView.current = { tab: readTab, cursor };
  const detailGeneration = useRef(0), receivedBoard = useRef(false), syncing = useRef(false);
  const fileRequest = useRef(0);
  const failedChanges = useRef(new Map<string, string>());
  const refreshing = useRef<{ scope: string; work: Promise<void>; queued?: boolean; queuedSavedOnly?: boolean; queuedManual?: boolean }>();
  const currentBoard = useRef(board); currentBoard.current = board;
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const detailRefreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const projectRef = useRef(project); projectRef.current = project;
  const visibleRef = useRef(props.active !== false); visibleRef.current = props.active !== false;
  const requests = useRef(new Map<string, { resolve: (result: DashboardActionResultPayload) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const call = (action: DashboardActionName, payload: DashboardActionPayload = {}) => new Promise<DashboardActionResultPayload>((resolve, reject) => {
    if (!props.connected) { reject(new Error('Reconnect to use this operation. It was not sent or queued.')); return; }
    if (props.shared) { void props.shared.request(action, payload).then(resolve, reject); return; }
    const id = props.sendAction(action, undefined, { projectPath: project, targetDeviceId: props.targetDeviceId, automatic: true, ...payload });
    if (!id) { reject(new Error('The request could not be sent.')); return; }
    const timer = setTimeout(() => { requests.current.delete(id); reject(new Error('Completion was not confirmed. Refresh before retrying. Your local draft was kept.')); }, ['startProjectTask','startProjectSubtask'].includes(action) ? 915000 : 65000);
    requests.current.set(id, { resolve, reject, timer });
  });
  useEffect(() => {
    if (props.shared) return;
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type === 'dashboard:project-changed') {
        if (visibleRef.current && message.projectPath === projectRef.current) { void refreshRef.current(); void detailRefreshRef.current(); }
        return;
      }
      if (visibleRef.current && message?.type === 'dashboard:codex-session-live') {
        const task = currentBoard.current?.tasks.find(task => task.id === selection.current);
        if (task?.sessionId === message.state.sessionId && (message.state.deviceId ?? 'local') === (deviceRef.current ?? 'local') && (!task.sourceKey || task.sourceKey.startsWith(`${currentBoard.current?.homeKey}:`)) && !detailView.current.cursor) {
          setDetails(previous => {
            if (!previous || previous.taskId !== task.id) return previous;
            const messages = combineCliLiveMessages(previous.messages, message.state);
            return { ...previous, messages, ...(detailView.current.tab === 'files' ? { files: listConversationFiles(messages) } : {}) };
          });
          if (!['starting','running'].includes(message.state.status)) void detailRefreshRef.current();
        }
      }
      if (visibleRef.current && message?.type === 'dashboard:action-result' && message.action === 'listCodexCliSessions' && message.status === 'completed') void detailRefreshRef.current();
      if (message?.type !== 'dashboard:action-result') return;
      const pending = requests.current.get(message.requestId); if (!pending) return;
      requests.current.delete(message.requestId); clearTimeout(pending.timer);
      if (message.status === 'completed') pending.resolve(message.payload ?? {});
      else pending.reject(new Error(message.error ?? 'The operation failed or was cancelled.'));
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); for (const pending of requests.current.values()) { clearTimeout(pending.timer); pending.reject(new Error('Task view closed. Saved drafts remain available.')); } requests.current.clear(); };
  }, []);
  useEffect(() => { if (!project && projects[0]) setProject(projects[0]); }, [projects, project]);
  useEffect(() => {
    if (props.shared) return;
    let disposed = false; setExtraProjects([]); setProject('');
    void readBrowserCache<string[]>(`projects:${props.targetDeviceId ?? props.selectedSystem ?? 'local'}`).then(saved => { if (!disposed && Array.isArray(saved)) setExtraProjects(saved.filter(path => typeof path === 'string').slice(0, 50)); });
    return () => { disposed = true; };
  }, [props.targetDeviceId, props.selectedSystem]);
  useEffect(() => {
    let disposed = false; receivedBoard.current = false;
    setBoard(undefined); setSelected(undefined); setTaskUploads([]); setCommentUploads([]); setAttachmentPreview(undefined); attachmentRequest.current++; setShare(undefined); setShareOpen(false); setConfirmation(undefined); setHiddenOpen(false); setHiddenSearch(''); setSearchOpen(false); setStatus('');
    if (props.shared) { setBoard(props.shared.board); return; }
    void readBrowserCache<ProjectBoard>(`board:${scope}`).then(saved => { if (!disposed && !receivedBoard.current && saved) setBoard(saved); });
    void listBrowserOutbox<Outbox>().then(rows => { if (!disposed) setOutbox(rows); });
    return () => { disposed = true; };
  }, [scope]);
  useEffect(() => {
    if (props.active === false) { receivedBoard.current = false; setBoard(undefined); setOutbox([]); return; }
    if (props.shared || receivedBoard.current) return;
    let disposed = false;
    if (!props.shared) void listBrowserOutbox<Outbox>().then(rows => { if (!disposed) setOutbox(rows); });
    void readBrowserCache<ProjectBoard>(`board:${scope}`).then(saved => { if (!disposed && !receivedBoard.current && saved) setBoard(saved); });
    return () => { disposed = true; };
  }, [props.active, scope]);
  const apply = (next: ProjectBoard | undefined, origin = scope) => {
    if (!next) return;
    const previous = origin === active.current ? currentBoard.current : undefined;
    if (previous && (next.revision !== undefined && previous.revision !== undefined ? next.revision < previous.revision : next.updatedAt < previous.updatedAt)) return;
    if (previous && next.revision !== undefined && next.revision === previous.revision && next.homeKey === previous.homeKey && JSON.stringify(next.sessions) === JSON.stringify(previous.sessions)) return;
    if (!props.shared) void writeBrowserCache(`board:${origin}`, next);
    if (origin === active.current) { receivedBoard.current = true; setBoard(next); }
  };
  const refresh = async (savedOnly = false, automatic = true) => {
    if (!project || !props.connected) return;
    if (refreshing.current?.scope === scope) { const current = refreshing.current; current.queuedSavedOnly = current.queued ? current.queuedSavedOnly && savedOnly : savedOnly; current.queued = true; current.queuedManual ||= !automatic; return current.work; }
    const work = (async () => {
      try { apply((await call('getProjectBoard', { taskSavedOnly: savedOnly, automatic })).projectBoard); }
      catch (error) { if (scope === active.current) setStatus((error as Error).message); }
    })().finally(() => {
      if (refreshing.current?.work !== work) return;
      const queued = refreshing.current.queued, queuedSavedOnly = refreshing.current.queuedSavedOnly, queuedManual = refreshing.current.queuedManual;
      refreshing.current = undefined;
      if (queued && scope === active.current && visibleRef.current && !document.hidden) void refresh(queuedSavedOnly, !queuedManual);
    });
    refreshing.current = { scope, work }; await work;
  };
  useEffect(() => { if (props.shared) { apply(props.shared.board); void detailRefreshRef.current(); } }, [props.shared?.board]);
  refreshRef.current = () => refresh(true);
  const sync = async (retry = false) => {
    if (props.shared || !props.connected || syncing.current) return;
    syncing.current = true;
    const failures: Record<string, string> = {}, blocked = new Set<string>();
    try {
      const pending = (await listBrowserOutbox<Outbox>()).sort((a,b) => (a.value?.savedAt ?? 0) - (b.value?.savedAt ?? 0) || Number(!!b.value?.task) - Number(!!a.value?.task));
      for (const row of pending) {
        const value = row.value;
        if (!value || typeof value.project !== 'string' || (!value.task && !value.comment) || (value.task && value.comment)) { failures[row.key] = 'Unreadable local change. Copy its contents before removing it.'; continue; }
        if (!value.device || value.device === 'local') { failures[row.key] = 'This saved change has no verified system. Assign its owner before syncing.'; continue; }
        const key = JSON.stringify([value.device, value.project, value.task?.id ?? value.comment?.taskId]);
        if (blocked.has(key)) continue;
        const previousError = failedChanges.current.get(row.key) ?? value.lastError;
        if (previousError && !(retry && value.project === project && value.device === ownerDeviceId)) { failures[row.key] = previousError; blocked.add(key); continue; }
        try {
          const result = await call(value.task ? 'saveProjectTask' : 'addProjectComment', { projectPath: value.project, targetDeviceId: value.device, task: value.task, comment: value.comment });
          if (!await deleteBrowserCache(row.key)) throw new Error('Saved on host; browser cleanup is unconfirmed. Retrying this request is safe.');
          failedChanges.current.delete(row.key);
          apply(result.projectBoard, boardScope(value.device, value.project));
          if (boardScope(value.device, value.project) === active.current && visibleRef.current) setStatus('Changes synced.', 'info');
        } catch (error) {
          const message = (error as Error).message;
          failures[row.key] = message; blocked.add(key); failedChanges.current.set(row.key, message);
          await writeBrowserCache(row.key, { ...value, lastError: message });
        }
      }
      if (visibleRef.current) { setSyncErrors(failures); setOutbox(await listBrowserOutbox<Outbox>()); }
      if (Object.keys(failures).length) setStatus('Some changes need review. Local drafts were kept; independent changes were synced.');
    } finally { syncing.current = false; }
  };
  useEffect(() => {
    if (props.shared || props.active === false) return;
    let disposed = false;
    const revalidate = async () => {
      if (!document.hidden && !disposed) { await refresh(); if (outboxRef.current.length) await sync(); }
    };
    const changed = () => { void revalidate(); };
    changed();
    window.addEventListener('online', changed); window.addEventListener('focus', changed); document.addEventListener('visibilitychange', changed);
    return () => { disposed = true; window.removeEventListener('online', changed); window.removeEventListener('focus', changed); document.removeEventListener('visibilitychange', changed); };
  }, [scope, props.connected, props.active]);
  const rows = props.shared ? [] : outbox.filter(row => row.value?.project === project && row.value.device === ownerDeviceId);
  const legacyRows = props.shared ? [] : outbox.filter(row => row.value && (!row.value.device || row.value.device === 'local'));
  const pendingIds = new Set(rows.flatMap(row => row.value.task ? [row.value.task.id] : []));
  const cards = useMemo(() => {
    const tasks: TaskCard[] = (board?.tasks ?? []).map(task => ({ ...task }));
    for (const row of rows) if (row.value.task) {
      const { uploads, ...draft } = row.value.task, index = tasks.findIndex(task => task.id === draft.id), current = tasks[index];
      const next = { ...current, ...draft, attachments: uploads?.map(({data: _data, ...file}) => ({...file, hash:''})) ?? current?.attachments, manualStage: current?.sourceKey ? current.manualStage : draft.stage, parentTaskId: draft.parentTaskId === null ? undefined : draft.parentTaskId ?? current?.parentTaskId, revision: draft.expectedRevision, createdAt: current?.createdAt ?? 0, updatedAt: row.value.savedAt };
      if (index < 0) tasks.push(next); else tasks[index] = next;
    }
    const sessions = new Map(board?.sessions.map(session => [session.id, session]));
    for (const session of sessionsRef.current) if (session.deviceId === props.targetDeviceId) sessions.set(session.id, session);
    for (const task of tasks) if (task.sessionId && (!task.sourceKey || task.sourceKey.startsWith(`${board?.homeKey}:`))) {
      task.session = sessions.get(task.sessionId);
      if (task.session && !pendingIds.has(task.id)) { task.title = task.session.title; task.sessionStatus = task.session.status; task.sessionArchived = task.session.archived === true; if (task.session.status !== 'unknown') task.stage = task.manualStage ?? sessionTaskStage(task.session); }
    }
    return tasks.sort((a,b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }, [board, outbox, sessions, scope]);
  const currentSelection = selected ? cards.find(task => task.id === selected.id) : undefined;
  const selectedSession = currentSelection?.session ?? selected?.session;
  const selectedTitle = currentSelection?.title ?? selected?.title;
  const selectedStage = currentSelection?.stage ?? selected?.stage;
  const effectiveStages = useMemo(() => projectTaskStages(cards.filter(task => !task.hidden)), [cards]);
  const agentCounts = useMemo(() => { const counts = new Map<string, number>(); for (const session of sessions) if (session.parentSessionId) { const key = `${session.deviceId ?? 'local'}:${session.parentSessionId}`; counts.set(key, (counts.get(key) ?? 0) + 1); } return counts; }, [sessions]);
  const visibleCards = useMemo(() => {
    const query = search.trim().toLowerCase();
    return cards.filter(task => !task.hidden && (!query || `${task.title}\n${task.prompt}`.toLowerCase().includes(query)) && (stageFilter === 'all' || effectiveStages.get(task.id) === stageFilter));
  }, [cards, search, stageFilter, effectiveStages]);
  const children = useMemo(() => {
    const map = new Map<string, TaskCard[]>();
    for (const task of cards) if (task.parentTaskId && !task.hidden && !task.sessionArchived) map.set(task.parentTaskId, [...(map.get(task.parentTaskId) ?? []), task]);
    return map;
  }, [cards]);
  const archived = (task: TaskCard) => task.archived === true || task.session?.archived === true || task.sessionArchived === true;
  const roots = useMemo(() => { const ids = new Set(cards.map(task => task.id)); return visibleCards.filter(task => showArchive ? archived(task) : (!!search.trim() || !task.parentTaskId || !ids.has(task.parentTaskId) || archived(task))); }, [cards, visibleCards, showArchive, effectiveStages, search]);
  const moveDropped = async (stage: TaskStage, event: DragEvent): Promise<void> => {
    event.preventDefault(); event.stopPropagation(); setDropStage(undefined);
    const taskId = event.dataTransfer?.getData('application/x-codex-task');
    const rawSession = event.dataTransfer?.getData('application/x-codex-session');
    let sourceId = taskId;
    if (!sourceId && rawSession) { try { const source = JSON.parse(rawSession) as { id?: string; deviceId?: string }; if ((source.deviceId ?? 'local') !== (props.targetDeviceId ?? 'local')) { setStatus('Choose the same system before moving this session.'); return; } sourceId = source.id; } catch { /* malformed drag data */ } }
    const task = sourceId ? cards.find(item => item.id === sourceId || item.sessionId === sourceId) : undefined;
    if (!task || !task.revision) { setStatus('Refresh the board before moving this session.'); return; }
    if (busy) { setStatus('Wait for the current task operation to finish.'); return; }
    if (pendingIds.has(task.id)) { setStatus('Sync this task before moving it.'); return; }
    if (task.launchPending) { setStatus('This task cannot move until its current operation is confirmed.'); return; }
    if ((effectiveStages.get(task.id) ?? task.stage) === stage && !task.parentTaskId) return;
    await action('moveProjectTask', { taskId: task.id, taskRevision: task.revision, taskStage: stage, taskToBoard: true });
  };
  const groupDropped = async (parentId: string, event: DragEvent): Promise<void> => {
    event.preventDefault(); event.stopPropagation(); setDropStage(undefined);
    const parentTask = cards.find(task => task.id === parentId);
    if (!parentTask || parentTask.sourceKey || parentTask.sessionId) { setStatus('Drop onto a custom task. Sessions cannot contain task subtasks.'); return; }
    let sourceId = event.dataTransfer?.getData('application/x-codex-task');
    const raw = event.dataTransfer?.getData('application/x-codex-session');
    if (!sourceId && raw) {
      try { const source = JSON.parse(raw) as { id?: string; deviceId?: string }; if ((source.deviceId ?? 'local') !== (props.targetDeviceId ?? 'local')) throw new Error(); sourceId = source.id; }
      catch { setStatus('Choose the same system before grouping this session.'); return; }
    }
    const task = cards.find(item => item.id === sourceId || item.sessionId === sourceId);
    if (!task?.revision) { setStatus('Refresh the board before grouping this session.'); return; }
    if (!task.sourceKey && !task.sessionId) { setStatus('Only session tasks can be subtasks. Custom tasks stay on the top-level board.'); return; }
    if (busy) { setStatus('Wait for the current task operation to finish.'); return; }
    let ancestor: string | undefined = parentId;
    const seen = new Set([task.id]);
    while (ancestor) {
      if (seen.has(ancestor)) { setStatus('Choose a parent outside this task and its descendants.'); return; }
      seen.add(ancestor); ancestor = cards.find(item => item.id === ancestor)?.parentTaskId;
    }
    if (task.parentTaskId === parentId) return;
    if (pendingIds.has(task.id)) { setStatus('Sync this task before moving it.'); return; }
    await action('saveProjectTask', { task: { id: task.id, title: task.title, prompt: task.prompt, stage: task.stage, expectedRevision: task.revision, parentTaskId: parentId } });
  };
  const open = (task: TaskCard) => {
    setTaskUploads([]); setCommentUploads([]); setAttachmentPreview(undefined); attachmentRequest.current++;
    detailGeneration.current++; selection.current = task.id;
    if (props.shared && !task.id) {
      try {
        const raw = localStorage.getItem(props.shared.draftKey) || '{}';
        if (raw.length > 2 * 1024 * 1024) throw new Error('Draft is too large.');
        const draft = JSON.parse(raw) as { title?: unknown; prompt?: unknown; uploads?: unknown; attempt?: { fingerprint?: unknown; task?: { id?: unknown } } };
        const title = typeof draft.title === 'string' ? draft.title.slice(0,240) : task.title;
        const prompt = typeof draft.prompt === 'string' ? draft.prompt.slice(0,32000) : task.prompt;
        task = { ...task, title, prompt };
        const id = draft.attempt?.task?.id;
        const uploads = validateChatAttachments(draft.uploads); setTaskUploads(uploads);
        const fingerprint = JSON.stringify(['task', title, prompt, uploads.map(file => [file.id,file.name,file.size])]);
        sharedWrite.current = typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(id) && draft.attempt?.fingerprint === fingerprint ? { fingerprint, task: { id, title, prompt, stage:'idea', expectedRevision:0, ...(uploads.length ? { uploads } : {}) } } : undefined;
      } catch { /* Optional draft storage. */ }
    }
    setAttachId(''); setNewSession(false); setSubtaskPrompt(''); setSelected(task); setTitle(task.title); setPrompt(task.prompt); setParent(task.parentTaskId ?? ''); setComment(''); setTab('overview'); setCursor(undefined); setDetails(undefined); setFile(undefined);
  };
  useEffect(() => {
    const generation = ++detailGeneration.current;
    setDetails(undefined); setFile(undefined); setDetailLoading(false);
    if (!selected?.id || !selected.revision || props.active === false || !canReadTab || tab === 'agents' && !props.shared) return;
    const taskId = selected.id, origin = scope;
    let disposed = false, loading = false, refreshQueued = false, received = false, signature: string | undefined;
    const current = () => !disposed && generation === detailGeneration.current && origin === active.current && taskId === selection.current;
    const key = `task:${JSON.stringify([ownerDeviceId ?? 'local', project, taskId, readTab, cursor ?? 'latest'])}`;
    if (!props.shared) void readBrowserCache<ProjectTaskDetails>(key).then(saved => { if (current() && !received && saved) setDetails(saved); });
    const poll = async () => {
      if (!current() || !props.connected || document.hidden) return;
      if (loading) { refreshQueued = true; return; }
      loading = true;
      if (!received) setDetailLoading(true);
      try {
        const next = (await call('getProjectTaskDetails', { taskId, taskView: readTab, taskBefore: cursor, automatic: true })).projectTaskDetails;
        if (next && current()) {
          received = true;
          const value = JSON.stringify(next);
          if (signature === value) return;
          signature = value;
          if (next.warnings.length) setDetails(previous => previous && !next.messages.length && !next.files.length && !next.environment ? { ...previous, warnings: next.warnings } : next);
          else { setDetails(next); if (!props.shared) void writeBrowserCache(key, next); }
        }
      } catch (error) { if (current()) setStatus((error as Error).message); }
      finally {
        loading = false; if (current()) setDetailLoading(false);
        if (refreshQueued) { refreshQueued = false; if (current()) void poll(); }
      }
    };
    detailRefreshRef.current = !cursor ? poll : () => Promise.resolve();
    const changed = () => { void poll(); };
    window.addEventListener('focus', changed); document.addEventListener('visibilitychange', changed);
    void poll(); return () => { disposed = true; if (detailRefreshRef.current === poll) detailRefreshRef.current = () => Promise.resolve(); window.removeEventListener('focus', changed); document.removeEventListener('visibilitychange', changed); };
  }, [scope, selected?.id, readTab, tab === 'agents', cursor, props.connected, props.active, props.shared?.permissions.join(',')]);
  const sharedSending = useRef(false);
  const sharedWrite = useRef<{ fingerprint: string; task?: ProjectTaskMutation; comment?: ProjectCommentInput }>();
  useEffect(() => { if (props.shared && selected?.id === '') { try { localStorage.setItem(props.shared.draftKey, JSON.stringify({ title, prompt, uploads: taskUploads, attempt: sharedWrite.current ? { fingerprint: sharedWrite.current.fingerprint, task: { id: sharedWrite.current.task?.id } } : undefined })); } catch { setStatus('Draft is kept in this tab only. Copy it before closing.'); } } }, [title, prompt, taskUploads, selected?.id, props.shared?.draftKey]);
  useEffect(() => { if (props.shared && selected) { setDetails(undefined); setFile(undefined); if (tab !== 'overview' && !can(tab === 'agents' ? 'activities' : tab)) setTab('overview'); } }, [props.shared?.permissions.join(',')]);
  const enqueue = async (value: Omit<Outbox, 'savedAt'>, operationId: string): Promise<boolean> => {
    if (props.shared) {
      if (sharedSending.current) return false;
      sharedSending.current = true;
      const fingerprint = JSON.stringify(value.task ? ['task', value.task.title, value.task.prompt, (value.task.uploads ?? []).map(file => [file.id,file.name,file.size])] : ['comment', value.comment?.taskId, value.comment?.text, (value.comment?.uploads ?? []).map(file => [file.id,file.name,file.size])]);
      if (sharedWrite.current?.fingerprint !== fingerprint) sharedWrite.current = { fingerprint, task: value.task, comment: value.comment };
      if (value.task) { try { localStorage.setItem(props.shared.draftKey, JSON.stringify({ title: value.task.title, prompt: value.task.prompt, uploads: value.task.uploads, attempt: { fingerprint, task: { id: sharedWrite.current.task?.id } } })); } catch { /* The open editor retains the draft. */ } }
      try { const result = await call(value.task ? 'saveProjectTask' : 'addProjectComment', { task: sharedWrite.current.task, comment: sharedWrite.current.comment }); apply(result.projectBoard); sharedWrite.current = undefined; if (value.task) { try { localStorage.removeItem(props.shared.draftKey); } catch { /* Optional draft storage. */ } } setStatus(value.task ? 'Idea submitted for the project owner to review.' : 'Comment added.', 'info'); return true; }
      catch (error) { setStatus('Submission not confirmed: ' + (error as Error).message + ' Your draft was kept. Retry sends the same request safely.'); return false; }
      finally { sharedSending.current = false; }
    }
    if (!ownerDeviceId || ownerDeviceId === 'local') { setStatus('The system identity is not verified. Your open draft was kept; reconnect before saving.'); return false; }
    value = { ...value, device: ownerDeviceId };
    const key = `outbox:${JSON.stringify([ownerDeviceId, value.project, operationId])}`;
    if (!await writeBrowserCache(key, { ...value, savedAt: Date.now() })) { setStatus('Browser storage is full or unavailable. Your open draft was kept; reconnect before closing this view.'); return false; }
    setOutbox(await listBrowserOutbox<Outbox>()); setStatus(props.connected ? 'Saved locally.' : 'Saved offline.', 'info');
    void sync(); return true;
  };
  const save = async (groupOnly = false) => {
    if (!selected || !title.trim() || busy || taskReading) return;
    let ancestor = parent;
    const seen = new Set([selected.id]);
    while (ancestor) {
      if (seen.has(ancestor)) { setStatus('Choose a parent outside this task and its descendants.'); return; }
      seen.add(ancestor); ancestor = cards.find(task => task.id === ancestor)?.parentTaskId ?? '';
    }
    if (pendingIds.has(selected.id)) { setStatus('A saved edit is pending. Review or sync it before editing again.'); return; }
    const savingGeneration = detailGeneration.current;
    setBusy(true);
    try {
      const task: ProjectTaskMutation = { id: selected.id || crypto.randomUUID(), title: groupOnly ? selected.title : title.trim(), prompt: groupOnly ? selected.prompt : prompt,
        stage: selected.stage, expectedRevision: selected.revision, ...(!groupOnly && taskUploads.length ? { uploads: taskUploads } : {}), parentTaskId: selected.sessionId || selected.sourceKey ? parent || null : null };
      if (await enqueue({ project, device: props.targetDeviceId, task }, `${task.id}:${task.expectedRevision}`) && savingGeneration === detailGeneration.current) { setSelected(undefined); setTaskUploads([]); }
    } finally { setBusy(false); }
  };
  const submitComment = async () => {
    if (!selected?.id || !comment.trim() && !commentUploads.length || busy || commentReading) return;
    const taskId = selected.id;
    setBusy(true);
    try { const id = crypto.randomUUID(); if (await enqueue({ project, device: props.targetDeviceId, comment: { id, taskId: selected.id, text: comment.trim(), ...(commentUploads.length ? { uploads: commentUploads } : {}) } }, id) && selection.current === taskId) { setComment(''); setCommentUploads([]); } }
    finally { setBusy(false); }
  };
  const action = async (operation: DashboardActionName, payload: DashboardActionPayload = {}) => {
    const origin = scope; setBusy(true);
    try {
      const result = await call(operation, payload); apply(result.projectBoard, origin);
      if (origin !== active.current) return;
      if (operation === 'shareProjectBoard' && (!result.projectShare || !/^[a-f0-9]{64}$/.test(result.projectShare.token) || !Number.isFinite(result.projectShare.expiresAt) || !Array.isArray(result.projectShare.permissions))) throw new Error('Link creation was not confirmed. Refresh before creating another link.');
      if (result.projectBoard && selected?.id && selection.current === selected.id) { const latest = result.projectBoard.tasks.find(task => task.id === selected.id); if (latest) setSelected({ ...latest, session: selected.session }); }
      if (result.projectShare) setShare({ url: new URL(`/projects/share/${result.projectShare.token}`, location.origin).href, expiresAt: result.projectShare.expiresAt, permissions: result.projectShare.permissions });
      setStatus(result.notice?.message ?? (operation === 'moveProjectTask' && payload.taskStage ? `Moved to ${label(payload.taskStage)}.` : 'Done.'), result.notice?.level ?? 'info'); return true;
    } catch (error) {
      if (origin === active.current) {
        setStatus((error as Error).message);
        if (['startProjectTask','startProjectSubtask','moveProjectTask'].includes(operation)) void call('getProjectBoard', { automatic: true, taskSavedOnly: true }).then(result => apply(result.projectBoard, origin)).catch(() => undefined);
      }
      return false;
    }
    finally { setBusy(false); }
  };
  const shareAction = async (revoke: boolean) => {
    if (shareBusy.current) return false;
    shareBusy.current = true; setStatus(''); setShareError(false);
    const origin = scope;
    try {
      const success = await action(revoke ? 'revokeProjectShares' : 'shareProjectBoard', revoke ? {} : { sharePermissions, shareDays });
      if (origin === active.current && success === false) setShareError(true);
      if (success && origin === active.current) {
        if (revoke) setShare(undefined);
        setStatus(revoke ? 'All project links revoked. They can no longer be opened.' : 'Public link created. Its permissions stay fixed for this link.');
      }
      return success;
    } finally { shareBusy.current = false; }
  };
  const sessionAction = (task: TaskCard, operation: 'open' | 'start' | 'stop' | 'archive' | 'hide' | 'restore') => {
    if (operation === 'hide' || operation === 'restore') { void action('saveProjectTask', { task: { id: task.id, title: task.title, prompt: task.prompt, stage: task.stage, expectedRevision: task.revision, hidden: operation === 'hide' } }); return; }
    if (operation === 'open') { if (task.session) props.onOpenSession(task.session); else open(task); return; }
    if (operation === 'start' || operation === 'stop') { void action(task.sessionId ? operation === 'stop' ? 'cancelCodexCliSessionTurn' : 'resumeCodexSessions' : 'startProjectTask', task.sessionId ? { sessionId: task.sessionId } : { taskId: task.id, taskRevision: task.revision }).then(() => refresh()); return; }
    if (!task.sessionId) { void action('saveProjectTask', { task: { id: task.id, title: task.title, prompt: task.prompt, stage: task.stage, expectedRevision: task.revision, archived: !task.archived } }); return; }
    if (task.sessionId) void action(task.sessionArchived ? 'unarchiveCodexCliSession' : 'archiveCodexCliSession', { sessionId: task.sessionId }).then(() => refresh());
  };
  const openFile = async (entry: ProjectTaskFile) => {
    const request = ++fileRequest.current;
    if (entry.attachment && !props.shared) {
      const preview = readConversationAttachment(details?.messages ?? [], entry.path);
      if (preview) { setFile(preview); setStatus(''); } else setStatus('This attachment is unavailable. Open its history page when connected.');
      return;
    }
    const filePath = entry.path;
    const generation = detailGeneration.current, key = `file:${JSON.stringify([ownerDeviceId ?? 'local', project, filePath])}`;
    try {
      const cached = props.shared ? undefined : await readBrowserCache<NonNullable<DashboardActionResultPayload['workspaceFile']>>(key);
      if (request === fileRequest.current && generation === detailGeneration.current && cached) setFile(cached);
      if (!props.connected) { if (!cached && request === fileRequest.current && generation === detailGeneration.current) setStatus('This file has no offline copy. Open it when connected.'); return; }
      const next = (await call('readWorkspaceFile', { filePath, taskId: selected?.id, taskBefore: cursor })).workspaceFile;
      if (next && request === fileRequest.current && generation === detailGeneration.current) { setFile(next); setStatus(''); if (!props.shared) void writeBrowserCache(key, next); }
    } catch (error) { if (request === fileRequest.current && generation === detailGeneration.current) setStatus((error as Error).message); }
  };
  const closeTask = () => { detailGeneration.current++; selection.current = undefined; setSelected(undefined); setTaskUploads([]); setCommentUploads([]); setAttachmentPreview(undefined); attachmentRequest.current++; };
  const openAttachment = async (owner: 'task' | 'comment', ownerId: string, upload: ProjectAttachment) => {
    const origin = scope, taskId = selected?.id, request = ++attachmentRequest.current;
    if (!taskId || !can('files') || !upload.hash) return;
    const filePath = projectAttachmentPath(owner, ownerId, upload), key = `upload:${JSON.stringify([ownerDeviceId,project,taskId,filePath,upload.hash])}`;
    let received = false;
    const current = () => request === attachmentRequest.current && origin === active.current && taskId === selection.current;
    const cache = props.shared ? Promise.resolve(undefined) : readBrowserCache<NonNullable<DashboardActionResultPayload['workspaceFile']>>(key);
    void cache.then(saved => { if (current() && !received && saved) setAttachmentPreview(saved); });
    try {
      if (!props.connected) { if (!await cache) setStatus('This attachment has no offline copy. Reconnect to open it.'); return; }
      setStatus('Opening attachment…', 'info');
      const next = (await call('readWorkspaceFile', { taskId, filePath })).workspaceFile;
      if (!next) throw new Error('The attachment was not returned. Retry shortly.');
      received = true; if (!current()) return;
      setAttachmentPreview(next); setStatus(''); if (!props.shared) void writeBrowserCache(key, next);
    } catch (error) { received = true; if (current()) setStatus((error as Error).message, 'error'); }
  };
  if (props.active === false) return null;
  const selectedAgents = taskSessionAgents(sessions, selected?.sessionId, props.targetDeviceId);
  const selectedLatest = cards.find(task => task.id === selected?.id), launchUnconfirmed = selectedLatest?.launchPending || selected?.launchPending;
  const detailTiming = selectedLatest?.timing ?? selected?.timing, detailChildCount = selected ? children.get(selected.id)?.length ?? 0 : 0;
  const comments = [...(board?.comments ?? []), ...rows.flatMap(row => row.value.comment && !(board?.comments.some(item => item.id === row.value.comment!.id)) ? [{ ...row.value.comment, author: 'You · pending', createdAt: 0, attachments: row.value.comment.uploads?.map(({data: _data, ...file}) => ({...file, hash:''})) }] : [])].filter(item => item.taskId === selected?.id);
  return <section class={`task-board-section ${selected?.id ? 'has-detail-panel' : ''}`} aria-labelledby="task-board-title">
    <header class="task-board-header"><h2 id="task-board-title" class="sr-only">Task workspace</h2><div class="task-board-heading"><span id="task-sidebar-toggle-slot" class="content-sidebar-slot" /><div class="task-context-tabs" aria-label="Workspace context">
      <label class="task-context-select task-project-select"><span class="task-context-icon"><FolderIcon /></span><span><strong>{project ? basename(project) : 'Choose project'}</strong></span><span class="task-context-chevron"><ChevronDownIcon /></span><select aria-label="Task project" title={`${project || 'Choose project'} · ${cards.length} tasks · ${cards.filter(task => task.session?.status === 'running').length} running`} value={project} disabled={busy || !!props.shared} onChange={event => setProject(event.currentTarget.value)}><option value="">Choose a project</option>{projects.map(value => <option key={value} value={value}>{props.shared ? props.systemName : basename(value)}</option>)}</select></label>
    </div></div><div class="task-view-tabs" role="tablist" onKeyDown={handleTabKeyDown} aria-label="Task views">{(['board','list','gantt','calendar'] as const).map(value => <button key={value} type="button" role="tab" aria-label={value === 'gantt' ? 'Gantt' : label(value)} aria-selected={view === value} title={label(value)} onClick={() => setView(value)}><ViewIcon view={value} /><span>{value === 'gantt' ? 'Gantt' : label(value)}</span></button>)}</div><div class="task-board-toolbar">
      <button type="button" ref={searchToggle} class={`task-search-toggle ${search.trim() ? 'has-query' : ''}`} aria-label="Search tasks" title={search.trim() ? `Filter: ${search.trim()}` : 'Search tasks'} aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); if (!searchOpen) requestAnimationFrame(() => searchInput.current?.focus()); }}><SearchIcon /></button><label class={`task-board-search ${searchOpen ? 'is-open' : ''}`}><SearchIcon /><input ref={searchInput} type="search" aria-label="Search tasks" placeholder="Search tasks…" value={search} onKeyDown={event => { if (event.key === 'Escape') { setSearch(''); setSearchOpen(false); searchToggle.current?.focus(); } }} onInput={event => setSearch(event.currentTarget.value)} /><button type="button" class="task-search-close" aria-label="Close task search" onClick={() => { setSearchOpen(false); searchToggle.current?.focus(); }}>×</button></label>

<div class="task-board-view-actions">{can('submissions') ? <button type="button" class="task-add-button" aria-label="＋ Task" title="Add task" disabled={!project || busy} onClick={() => open({ id: '', title: '', prompt: '', stage: props.shared ? 'idea' : visibleStages[0] ?? 'planned', revision: 0, createdAt: 0, updatedAt: 0 })}><PlusIcon/><span>Add task</span></button> : null}</div>
      <TaskMenu label="Board actions">
        <strong class="task-menu-label">Show columns</strong>{stages.map(stage => <button type="button" role="menuitemcheckbox" aria-checked={visibleStages.includes(stage)} disabled={visibleStages.length === 1 && visibleStages.includes(stage)} onClick={() => {
          const next = stages.filter(value => value === stage ? !visibleStages.includes(stage) : visibleStages.includes(value));
          setVisibleStages(next); if (!saveTaskBoardColumns(next)) setStatus('Column choices are kept in this tab only. Browser storage is unavailable.');
        }}>{visibleStages.includes(stage) ? '✓ ' : ''}{label(stage)}</button>)}
        <details class="task-status-options"><summary>Status filter</summary>{(['all',...stages] as const).map(value => <button type="button" role="menuitemradio" aria-checked={stageFilter === value} onClick={() => setStageFilter(value)}>{stageFilter === value ? '✓ ' : ''}{label(value)}</button>)}</details>

      {!props.shared ? <details class="task-project-picker"><summary>Add project</summary><label>Project folder<input aria-label="Project folder path" placeholder="Absolute folder path" value={projectInput} onInput={event => setProjectInput(event.currentTarget.value)} /></label><button type="button" disabled={!props.connected || busy || !projectInput.trim()} onClick={() => {
        const device = props.targetDeviceId, owner = ownerDeviceId, origin = scope; setBusy(true);
        void call('getProjectBoard', { projectPath: projectInput.trim() }).then(result => {
          if (device !== deviceRef.current || origin !== active.current || !result.projectBoard) return;
          const path = result.projectBoard.projectPath, next = [path, ...extraProjects.filter(value => value !== path)].slice(0,50);
          setExtraProjects(next); setProject(path); setProjectInput(''); void writeBrowserCache(`projects:${owner ?? 'local'}`, next);
          void writeBrowserCache(`board:${boardScope(owner, path)}`, result.projectBoard);
        }).catch(error => setStatus((error as Error).message)).finally(() => setBusy(false));
      }}>Use project</button></details> : null}
        <button type="button" role="menuitem" class="task-view-filter" aria-pressed={showArchive} onClick={() => setShowArchive(!showArchive)}>{showArchive ? 'Back to board' : `Archive · ${cards.filter(archived).length}`}</button>
        {!props.shared ? <button type="button" role="menuitem" onClick={() => { setHiddenSearch(''); setHiddenLimit(100); setHiddenOpen(true); }}>Hidden sessions <span>{cards.filter(task => task.hidden).length}</span></button> : null}
        <button type="button" role="menuitem" disabled={!project || !props.connected || busy} onClick={() => { void refresh(false, false); }}>{renderRefreshIcon()} Refresh board</button>
        {!props.shared ? <button type="button" role="menuitem" disabled={!project || !props.connected || busy} onClick={() => { void sync(true); }}>{renderSyncIcon()} Sync drafts{rows.length ? ` · ${rows.length}` : ''}</button> : null}
        {!props.shared ? <button type="button" role="menuitem" disabled={!project || !props.connected || busy} onClick={() => { setStatus(''); setShareOpen(true); }}><ShareIcon /> Share project</button> : null}
      </TaskMenu>
    </div></header>
    {status && !shareOpen && !props.onActionFeedback ? createPortal(<div class="dashboard-notice-stack task-feedback" aria-live="polite"><div class={`dashboard-notice is-${statusLevel}`} role={statusLevel === 'error' ? 'alert' : 'status'}><span>{status}</span><button type="button" aria-label="Dismiss task notification" onClick={() => setStatus('')}>×</button></div></div>, document.body) : null}
    {showArchive && view === 'board' ? <div class="task-archive-list" aria-label="Archived tasks">{roots.map(task => <TaskTree readOnly={!!props.shared} key={task.id} task={task} children={new Map()} pendingIds={pendingIds} onOpen={open} systemName={props.systemName} agentCounts={agentCounts} connected={props.connected} busy={busy} onSessionAction={sessionAction} onMove={(task, stage) => { void action('moveProjectTask', { taskId: task.id, taskRevision: task.revision, taskStage: stage }); }} />)}{!roots.length ? <p class="task-board-empty">No archived conversations.</p> : null}</div> : view !== 'board' ? <TaskAlternateView view={view} tasks={visibleCards.filter(task => !showArchive || archived(task))} stages={effectiveStages} onOpen={open} /> : <div class="task-board-columns" style={{gridTemplateColumns:`repeat(${visibleStages.length},minmax(240px,1fr))`}}>{visibleStages.map(stage => <TaskColumn readOnly={!!props.shared} key={`${scope}:${stage}`} stage={stage} tasks={roots.filter(task => effectiveStages.get(task.id) === stage)} children={search.trim() ? new Map() : children} pendingIds={pendingIds} onOpen={open} systemName={props.systemName} agentCounts={agentCounts} connected={props.connected} busy={busy} onSessionAction={sessionAction} onMove={(task, stage) => { void action('moveProjectTask', { taskId: task.id, taskRevision: task.revision, taskStage: stage }); }} onAdd={can('submissions') && (!props.shared || stage === 'idea') ? () => open({ id: '', title: '', prompt: '', stage: props.shared ? 'idea' : stage, revision: 0, createdAt: 0, updatedAt: 0 }) : undefined} onGroup={(parentId, event) => { void groupDropped(parentId, event); }} onDrop={(stage, event) => { void moveDropped(stage, event); }} isDropTarget={dropStage === stage} onDragOver={() => setDropStage(stage)} onDragLeave={() => setDropStage(undefined)} />)}</div>}
    {legacyRows.length ? <details class="task-sync-conflicts"><summary>Saved changes need a system ({legacyRows.length})</summary>{legacyRows.map(row => <article key={row.key}><p>{row.value.project} · Original system unavailable</p><pre>{JSON.stringify(row.value.task ?? row.value.comment, (key: string, value: unknown) => key === 'data' ? undefined : value, 2)}</pre><button type="button" disabled={!ownerDeviceId || ownerDeviceId === 'local' || busy} onClick={() => setConfirmation({ title: 'Assign saved change?', danger: false, description: `Assign this change to ${props.systemName || 'this system'}? It will sync there when connected. The original system could not be verified.`, confirm: 'Assign to this system', run: () => { void writeBrowserCache(row.key, { ...row.value, device: ownerDeviceId, lastError: undefined }).then(async saved => { if (!saved) { setStatus('Browser storage did not confirm the assignment. The saved change was kept.'); return; } setOutbox(await listBrowserOutbox<Outbox>()); setStatus('System assigned.', 'info'); void sync(); }); } })}>Assign to this system</button></article>)}</details> : null}
    {rows.some(row => syncErrors[row.key]) ? <details class="task-sync-conflicts"><summary>Review unsynced changes</summary>{rows.filter(row => syncErrors[row.key]).map(row => <article key={row.key}><p>{syncErrors[row.key]}</p><pre>{JSON.stringify(row.value.task ?? row.value.comment, (key: string, value: unknown) => key === 'data' ? undefined : value, 2)}</pre><button type="button" onClick={() => { setConfirmation({ title: 'Discard local change?', description: 'The host version will be kept. This removes only the unsynced change on this browser.', confirm: 'Discard change', run: () => { void deleteBrowserCache(row.key).then(async removed => { if (removed) { setOutbox(await listBrowserOutbox<Outbox>()); setStatus('Local change discarded. Host version kept.'); } else setStatus('Browser storage did not confirm removal. Local change kept.'); }).catch(error => setStatus(String(error))); } }); }}>Discard local change</button></article>)}</details> : null}
    <ModalShell open={!!selected && !selected.id} title="New task" closeLabel="Close new task" className="task-create-modal dashboard-modal-compact" closeDisabled={busy || taskReading} closeOnBackdrop={false} onClose={closeTask}>
      {selected && !selected.id ? <form class="task-edit task-create-form" onSubmit={event => { event.preventDefault(); if (!busy && !taskReading && title.trim()) void save(); }}>
        <label>Title<input autoFocus required readOnly={busy} value={title} maxLength={240} placeholder="What needs to be done?" onInput={event => setTitle(event.currentTarget.value)} /></label>
        <label>Prompt / idea<textarea readOnly={busy} value={prompt} maxLength={32000} rows={4} placeholder="Describe the task…" onInput={event => setPrompt(event.currentTarget.value)} /></label>
        <AttachmentPicker key={`task:${scope}`} files={taskUploads} onChange={setTaskUploads} disabled={busy} label="Attach files to task" onReading={setTaskReading} onFeedback={(message, error) => setStatus(message, error ? 'error' : 'info')} />
        <div class="task-create-footer">{!props.shared ? <label>Stage<select value={selected.stage} disabled={busy} onChange={event => setSelected({ ...selected, stage: event.currentTarget.value as TaskStage })}>{stages.map(stage => <option key={stage} value={stage}>{label(stage)}</option>)}</select></label> : null}<div class="dialog-actions"><button type="button" class="modal-secondary-btn" disabled={busy || taskReading} onClick={closeTask}>Cancel</button><button type="submit" class="modal-primary-btn" disabled={busy || taskReading || !title.trim() || !!props.shared && !props.connected}>{busy ? 'Saving…' : 'Save task'}</button></div></div>
      </form> : null}
    </ModalShell>
    <TaskDetailPanel open={Boolean(selected?.id)} title={selectedTitle || 'New task'} onClose={closeTask}>
      {selected ? <><div class="task-detail-hero"><div class="task-detail-meta">{basename(project)}{!props.connected ? ' · Offline' : ''}</div><div class="task-detail-context-actions"><span class={`task-stage-pill is-${selectedStage}`}>{label(selectedStage!)}</span>{selectedSession ? <button type="button" class="task-open-conversation" title="Open conversation" onClick={() => props.onOpenSession(selectedSession)}>Open conversation ↗</button> : null}</div></div>
        <div class="task-detail-tabs" role="tablist" onKeyDown={handleTabKeyDown} aria-label="Task details"><button type="button" role="tab" aria-selected={tab === 'overview'} onClick={() => { setTab('overview'); setCursor(undefined); }}>Overview</button>{selected.id && can('activities') ? <button type="button" role="tab" aria-selected={tab === 'agents'} onClick={() => { setTab('agents'); setCursor(undefined); }}>Agents <small>{selectedAgents.length + (selected.sessionId ? 1 : 0)}</small></button> : null}{selected.id ? tabs.filter(value => can(value)).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => { if (value !== readTab || cursor) detailGeneration.current++; setTab(value); setCursor(undefined); }}>{label(value)}</button>) : null}</div>
        {details?.warnings.map(warning => <p key={warning} class="settings-note" role="status">{warning}</p>)}
        {tab === 'overview' ? <div class="task-overview">
        <dl class="task-environment-grid">{[['System', props.systemName || 'This PC'], ['Project', project], ['Model', selectedSession?.model || 'Not recorded'], ['Reasoning', selectedSession?.reasoningEffort || 'Default'], ['Status', selectedSession?.status || selectedStage], ['Goal', selectedSession?.goal?.status || 'None'], ['Branch', details?.environment?.branch || 'Not available'], ['Changes', details?.environment ? `${details.environment.changes} files · +${details.environment.additions} / −${details.environment.deletions}` : 'Not loaded'], ['Remote', details?.environment?.hasRemote ? details.environment.upstream || 'Configured' : 'Not configured'], ['Agents', String(selectedAgents.length + (selected.sessionId ? 1 : 0))], ['Files', String(details?.files.length ?? 0)], ['Updated', selectedSession?.updatedAt ? new Date(selectedSession.updatedAt).toLocaleString() : 'Not recorded']].map(([name, value]) => <div key={name}><dt>{name}</dt><dd title={value}>{value}</dd></div>)}</dl>
        {detailTiming || detailChildCount ? <div class="task-detail-summary">{detailTiming ? <span><strong>{recordedTime(selectedLatest ?? selected)}</strong><small>Recorded time</small></span> : null}{detailChildCount ? <span><strong>{detailChildCount}</strong><small>Subtasks</small></span> : null}{detailTiming?.runCount ? <span><strong>{detailTiming.runCount}</strong><small>Session runs</small></span> : null}</div> : null}
        {can('files') ? <TaskAttachmentLinks files={selectedLatest?.attachments ?? selected.attachments} onOpen={file => { void openAttachment('task', selected.id, file); }} /> : null}
        {selected.sessionId || props.shared ? <section class="task-description"><strong>Description</strong><p>{details?.initialPrompt ?? (selected.prompt || (detailLoading ? 'Loading description…' : 'Description unavailable.'))}</p></section> : null}
        {(!props.shared || !selected.id && can('submissions')) && !selected.sourceKey && !selected.sessionId ? <div class="task-edit"><label>Title<input readOnly={busy} value={title} maxLength={240} onInput={event => setTitle(event.currentTarget.value)} /></label><label>Prompt / idea<textarea readOnly={busy} value={prompt} maxLength={32000} rows={3} onInput={event => setPrompt(event.currentTarget.value)} /></label>{!props.shared ? <label>Stage<select value={selected.stage} disabled={Boolean(launchUnconfirmed)} onChange={event => setSelected({ ...selected, stage: event.currentTarget.value as TaskStage })}>{stages.map(stage => <option key={stage} value={stage}>{label(stage)}</option>)}</select></label> : null}<div class="settings-actions"><button type="button" disabled={busy || !title.trim() || Boolean(launchUnconfirmed) || !!props.shared && !props.connected} onClick={() => { void save(); }}>Save task</button>{selected.id ? <button type="button" disabled={!props.connected || busy || Boolean(launchUnconfirmed || selected.sessionId) || !selected.revision || selected.archived || pendingIds.has(selected.id) || prompt !== selected.prompt || title !== selected.title} onClick={() => { void action('startProjectTask', { taskId: selected.id, taskRevision: selected.revision }); }}>Start in Codex</button> : null}</div></div> : null}
        {props.shared ? null : selected.sessionId || selected.sourceKey ? <div class="task-grouping"><label>Parent task<select aria-label="Parent task" value={parent} disabled={busy || !!launchUnconfirmed} onChange={event => setParent(event.currentTarget.value)}><option value="">Top-level board</option>{cards.filter(task => task.id !== selected.id && !task.sourceKey && !task.sessionId).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><button type="button" disabled={busy || !!launchUnconfirmed || parent === (selected.parentTaskId ?? '') || pendingIds.has(selected.id)} onClick={() => { void save(true); }}>Move {parent ? 'under task' : 'to board'}</button></div> : selected.id ? <div class="task-subtask-controls"><div class="task-grouping"><label>Attach session<select aria-label="Session to attach" value={attachId} disabled={busy} onChange={event => setAttachId(event.currentTarget.value)}><option value="">Choose a session</option>{cards.filter(task => !task.hidden && !!task.sessionId && task.parentTaskId !== selected.id && !task.sessionArchived && !pendingIds.has(task.id)).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><button type="button" disabled={busy || !attachId || !!launchUnconfirmed} onClick={() => { const task = cards.find(task => task.id === attachId); if (task) void action('saveProjectTask', { task: { id: task.id, title: task.title, prompt: task.prompt, stage: task.stage, expectedRevision: task.revision, parentTaskId: selected.id } }).then(success => { if (success) setAttachId(''); }); }}>Attach session</button><button type="button" disabled={!props.connected || busy || !!launchUnconfirmed || !!selected.archived || pendingIds.has(selected.id)} onClick={() => setNewSession(!newSession)}>＋ New subtask</button></div>{newSession ? <form class="task-new-session" onSubmit={event => { event.preventDefault(); if (!subtaskPrompt.trim() || busy) return; const taskId = selected.id; void action('startProjectSubtask', { taskId: selected.id, taskRevision: selected.revision, text: subtaskPrompt }).then(success => { if (success && selection.current === taskId) { setNewSession(false); setSubtaskPrompt(''); void refresh(); } }); }}><label>Initial prompt<textarea aria-label="Subtask initial prompt" value={subtaskPrompt} maxLength={32000} rows={3} onInput={event => setSubtaskPrompt(event.currentTarget.value)} placeholder="Describe the work for this Codex session…" /></label><button type="submit" disabled={!props.connected || busy || !subtaskPrompt.trim()}>Create and start session</button></form> : null}</div> : null}
        {launchUnconfirmed ? <div class="task-start-review"><p>Startup was not confirmed. Review the session list before allowing another start.</p><button type="button" disabled={!props.connected || busy} onClick={() => { setConfirmation({ title: 'Allow another start?', description: 'Continue only after verifying that the previous start was not accepted. An accepted start could otherwise create duplicate work.', confirm: 'Allow retry', run: () => { void action('resetProjectTaskStart', { taskId: selected.id, taskRevision: selectedLatest?.revision ?? selected.revision, confirmed: true }); } }); }}>Allow retry after review</button></div> : null}
        {children.get(selected.id)?.length ? <div class="task-subtasks"><strong>Subtasks</strong>{children.get(selected.id)!.map(task => <button key={task.id} type="button" onClick={() => open(task)}>{task.title}<small>{label(effectiveStages.get(task.id) ?? task.stage)}</small></button>)}</div> : null}
        {can('comments') ? <div class="task-comments"><strong>Comments</strong>{comments.map(item => <article class="task-activity" key={item.id}><small>{item.author}</small><p>{item.text}</p>{can('files') ? <TaskAttachmentLinks files={item.attachments} onOpen={file => { void openAttachment('comment', item.id, file); }} /> : null}</article>)}<div class="task-comment-composer"><textarea rows={2} aria-label="Add a comment" readOnly={busy} value={comment} maxLength={8000} placeholder="Leave a comment…" onInput={event => setComment(event.currentTarget.value)} /><AttachmentPicker key={`comment:${scope}:${selected.id}`} files={commentUploads} onChange={setCommentUploads} disabled={busy} label="Attach files to comment" onReading={setCommentReading} onFeedback={(message, error) => setStatus(message, error ? 'error' : 'info')} /><button type="button" disabled={busy || commentReading || !selected.id || !comment.trim() && !commentUploads.length || !!props.shared && !props.connected} onClick={() => { void submitComment(); }}>Add comment</button></div></div> : null}
        </div> : <>
        <div class="task-detail-scroll cli-workspace cli-message-surface" role="tabpanel">
          {tab !== 'agents' && cursor ? <button type="button" disabled={detailLoading} onClick={() => setCursor(undefined)}>Latest activity</button> : null}{tab !== 'agents' && details?.olderThan ? <button type="button" disabled={detailLoading} onClick={() => setCursor(details.olderThan)}>Older history</button> : null}
          {tab === 'agents' ? <TaskAgents key={`${scope}:${selected.id}`} sessions={[...(selected.sessionId ? [{ ...(selectedSession ?? { id: selected.sessionId, title: selected.title, status: selected.sessionStatus ?? 'unknown', deviceId: props.targetDeviceId }), agentName: selectedSession?.model || 'Main agent' }] : []), ...selectedAgents]} shared={!!props.shared} connected={props.connected} messages={details?.messages ?? []} call={call} onFeedback={notice => setStatus(notice.message, notice.level)} /> : null}
          {tab === 'activities' && details ? <TaskActivityTimeline messages={details.messages} comments={can('comments') && !cursor ? comments : []} loading={detailLoading} onAttachment={can('files') ? (ownerId, upload) => { void openAttachment('comment', ownerId, upload); } : undefined} onFeedback={notice => setStatus(notice.message, notice.level)} /> : null}
          {tab === 'files' ? <><p class="settings-note">Files shared or changed in this conversation · read-only</p>{details?.files.map(entry => <button type="button" class="task-file-row" key={entry.path} disabled={entry.type !== 'file'} onClick={() => { void openFile(entry); }}><span>{entry.attachment ? entry.name : entry.path}</span><small>{entry.attachment ? 'Attachment' : 'Changed file'}</small></button>)}{details && !details.files.length ? <p class="task-board-empty">No files were shared or changed in this conversation.</p> : null}{file ? <article class="task-activity"><strong>{file.path}</strong>{file.kind === 'image' && file.dataUrl ? <SessionMessage key={file.revision} message={{ id: file.revision, kind: 'message', role: 'user', text: '', images: [{ src: file.dataUrl, alt: file.path }] }} /> : <pre>{file.content}</pre>}</article> : null}</> : null}
          {tab === 'changes' ? <><p>Current project: {details?.environment?.changes ?? 0} changed files · +{details?.environment?.additions ?? 0} / −{details?.environment?.deletions ?? 0}</p>{details?.environment?.branchDiff ? <details><summary>Current branch differences</summary><pre>{details.environment.branchDiff}</pre></details> : null}{details?.messages.filter(item => item.changes?.length).map(item => <SessionMessage key={item.id} message={item} />)}</> : null}
          {tab !== 'agents' ? detailLoading ? <p role="status" class="settings-note">Refreshing {label(tab).toLowerCase()}…</p> : !details ? <p class="task-board-empty">{selected.id ? 'No cached details yet. Reconnect to load this view.' : 'Save this task to add comments and start Codex.'}</p> : null : null}
        </div>
        </>}
      </> : null}
    </TaskDetailPanel>
    <ModalShell open={!!attachmentPreview} title={attachmentPreview?.path || 'Attachment'} closeLabel="Close attachment" className="task-attachment-modal dashboard-modal-compact" onClose={() => { attachmentRequest.current++; setAttachmentPreview(undefined); }}>
      {attachmentPreview ? <><div class="task-attachment-actions"><span>{Math.ceil(attachmentPreview.size / 1024)} KB</span>{attachmentPreview.kind === 'text' ? <TurnCopyButton text={attachmentPreview.content} label="Copy attachment" onActionFeedback={notice => setStatus(notice.message, notice.level)} /> : null}<a class="modal-secondary-btn" download={attachmentPreview.path} href={attachmentPreview.dataUrl ?? `data:text/plain;charset=utf-8,${encodeURIComponent(attachmentPreview.content)}`} onClick={() => setStatus('Download started.', 'info')}>Download</a></div>{attachmentPreview.kind === 'image' && attachmentPreview.dataUrl ? <div class="cli-workspace cli-message-surface"><SessionMessage message={{id:attachmentPreview.revision,role:'user',kind:'message',text:'',images:[{src:attachmentPreview.dataUrl,alt:attachmentPreview.path}]}} /></div> : <pre class="task-attachment-text">{attachmentPreview.content}</pre>}</> : null}
    </ModalShell>
    <ModalShell open={hiddenOpen} title="Hidden sessions" closeLabel="Close hidden sessions" className="dashboard-modal-compact task-hidden-modal" onClose={() => setHiddenOpen(false)}>
      <label class="task-hidden-search"><SearchIcon /><input type="search" aria-label="Search hidden sessions" placeholder="Search hidden sessions…" value={hiddenSearch} onInput={event => { setHiddenSearch(event.currentTarget.value); setHiddenLimit(100); }} /></label>
      <div class="task-hidden-list">{cards.filter(task => task.hidden && task.title.toLowerCase().includes(hiddenSearch.trim().toLowerCase())).slice(0, hiddenLimit).map(task => <article class="task-hidden-row" key={task.id}><span><strong title={task.title}>{task.title}</strong><small>{label(effectiveStages.get(task.id) ?? task.stage)} · {task.session?.deviceName || props.systemName || 'Local'}</small></span><button type="button" class="modal-secondary-btn" disabled={!props.connected || busy || pendingIds.has(task.id) || !!task.launchPending} aria-label={`Restore ${task.title} to boards`} onClick={() => sessionAction(task, 'restore')}>Restore</button></article>)}</div>
      {cards.filter(task => task.hidden && task.title.toLowerCase().includes(hiddenSearch.trim().toLowerCase())).length > hiddenLimit ? <button type="button" onClick={() => setHiddenLimit(hiddenLimit + 100)}>Show more</button> : null}
      {!cards.some(task => task.hidden) ? <p class="settings-note">No hidden sessions.</p> : !cards.some(task => task.hidden && task.title.toLowerCase().includes(hiddenSearch.trim().toLowerCase())) ? <p class="settings-note">No matching sessions.</p> : null}
      {!props.connected ? <p class="settings-note" role="status">Reconnect to restore sessions.</p> : null}
    </ModalShell>
    <ModalShell open={!!confirmation} title={confirmation?.title || 'Confirm action'} closeLabel="Cancel confirmation" className="dashboard-modal-compact dashboard-confirm-modal" onClose={() => setConfirmation(undefined)}><p class="dialog-description">{confirmation?.description}</p><div class="dialog-actions"><button type="button" class="modal-secondary-btn" onClick={() => setConfirmation(undefined)}>Cancel</button><button type="button" class={`modal-primary-btn ${confirmation?.danger === false ? '' : 'danger'}`} onClick={() => { const run = confirmation?.run; setConfirmation(undefined); run?.(); }}>{confirmation?.confirm}</button></div></ModalShell>
    <ModalShell open={shareOpen} title="Share project" closeLabel="Close" closeDisabled={busy} onClose={() => { setShareOpen(false); setStatus(''); }} className="project-share-modal share-dialog">
      <div class="share-context"><span class="share-context-icon"><ShareIcon /></span><div><strong>{basename(project)}</strong><small>Public board link</small></div><span class="share-access-badge">Anyone with the link</span></div>
      <p class="dialog-description">Task titles, descriptions and subtasks are visible. Choose what else visitors can see or do.</p>
      <div class="share-section-heading"><strong>Visitor permissions <small>{sharePermissions.length} selected</small></strong><label><input type="checkbox" checked={sharePermissions.length === PROJECT_SHARE_FEATURES.length} disabled={busy} ref={element => { if (element) element.indeterminate = sharePermissions.length > 0 && sharePermissions.length < PROJECT_SHARE_FEATURES.length; }} onChange={event => setSharePermissions(event.currentTarget.checked ? PROJECT_SHARE_FEATURES.map(feature => feature.key) : [])}/>Check all</label></div>
      <fieldset class="project-share-permissions" disabled={busy}><legend class="sr-only">Visitor permissions</legend>{PROJECT_SHARE_FEATURES.map(feature => <label key={feature.key}><input type="checkbox" checked={sharePermissions.includes(feature.key)} onChange={event => setSharePermissions(current => event.currentTarget.checked ? [...current, feature.key] : current.filter(value => value !== feature.key))} /><span><strong>{feature.label}</strong><small>{feature.description}</small></span></label>)}</fieldset>
      <div class="share-create-row"><label>Link expires<select value={shareDays} disabled={busy} onChange={event => setShareDays(Number(event.currentTarget.value))}>{[1,7,30].map(days => <option key={days} value={days}>{days} day{days > 1 ? 's' : ''}</option>)}</select></label><button type="button" disabled={!props.connected || busy || !location.protocol.startsWith('http')} onClick={() => void shareAction(false)} class="modal-primary-btn">{busy && shareBusy.current ? 'Please wait…' : 'Create link'}</button></div>
      {!props.connected ? <p class="share-outcome" role="status">Reconnect to create or revoke links. Your permission choices are kept.</p> : !location.protocol.startsWith('http') ? <p class="share-outcome">Open the browser dashboard to create a reachable public link.</p> : null}
      {share ? <div class="task-share-result"><ShareLinkField url={share.url} label="Public link" disabled={busy} onFeedback={notice => { setStatus(notice.message); setShareError(notice.level === 'error'); }} /><div class="share-link-meta"><small>Expires {new Date(share.expiresAt).toLocaleString()}</small><a href={share.url} target="_blank" rel="noopener noreferrer">Open board ↗</a></div>{share.permissions.includes('embed') ? <details class="share-embed" open><summary>Embed code</summary><textarea aria-label="Embed code" readOnly rows={3} value={`<iframe src="${share.url}" title="Project tasks" width="100%" height="720" loading="lazy" referrerpolicy="no-referrer"></iframe>`} onFocus={event => event.currentTarget.select()} /></details> : null}</div> : null}
      {status ? <p class={`share-outcome ${shareError ? 'is-error' : ''}`} role={shareError ? 'alert' : 'status'}>{status}</p> : null}
      <ShareAccessReview description="Revoking affects every public link for this project." label="Revoke all project links" busy={busy} disabled={!props.connected} onConfirm={() => shareAction(true)} />
    </ModalShell>
  </section>;
}

function TaskAgents({ sessions, shared, connected, messages, call, onFeedback }: { sessions: DashboardCliSessionSummary[]; shared: boolean; connected: boolean; messages: ProjectTaskDetails['messages']; call: (action: DashboardActionName, payload: DashboardActionPayload) => Promise<DashboardActionResultPayload>; onFeedback: (notice: DashboardNotice) => void }) {
  const [data, setData] = useState<Record<string, { messages?: ProjectTaskDetails['messages']; error?: string; loading?: boolean }>>({});
  const pending = useRef(new Set<string>()), mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const refresh = async (agent: DashboardCliSessionSummary, automatic?: boolean) => {
    const key = cliSessionTargetKey(agent);
    if (pending.current.has(key)) return;
    if (!connected) { setData(previous => ({ ...previous, [key]: { ...previous[key], error: 'Reconnect to refresh this agent. Saved messages were kept.' } })); return; }
    pending.current.add(key); setData(previous => ({ ...previous, [key]: { ...previous[key], loading: true, error: undefined } }));
    try {
      const result = await call(agent.subAgent || agent.parentSessionId ? 'getCodexSubAgentMessages' : 'getCodexCliSessionMessages', { sessionId: agent.id, projectPath: agent.projectPath, automatic: true });
      const next = result.cliSubAgentMessages ?? result.cliSessionMessages;
      if (!next) throw new Error('Agent messages were not returned. Retry refresh.');
      if (mounted.current) { setData(previous => ({ ...previous, [key]: { messages: next } })); if (!automatic) onFeedback({ level: 'info', message: 'Agent messages updated.' }); }
    } catch (error) { if (mounted.current) setData(previous => ({ ...previous, [key]: { ...previous[key], loading: false, error: (error as Error).message } })); }
    finally { pending.current.delete(key); }
  };
  const sharedData = sessions[0] ? { [cliSessionTargetKey(sessions[0])]: { messages }, ...data } : data;
  return <AgentWorkspace connected={connected} sessions={sessions} data={sharedData} onRefresh={shared ? undefined : (agent, automatic) => { void refresh(agent, automatic); }} onFeedback={onFeedback} />;
}

function TaskAttachmentLinks({ files, onOpen }: { files?: ProjectAttachment[]; onOpen: (file: ProjectAttachment) => void }) {
  if (!files?.length) return null;
  return <div class="task-upload-links">{files.map(file => <button key={file.id} type="button" disabled={!file.hash} title={`${file.name} · ${file.size} bytes`} onClick={() => onOpen(file)}><AttachmentIcon /><span>{file.name}</span></button>)}</div>;
}
function TaskActivityTimeline({ messages, comments, loading, onFeedback, onAttachment }: { messages: ProjectTaskDetails['messages']; comments: ProjectBoard['comments']; loading: boolean; onAttachment?: (ownerId: string, upload: ProjectAttachment) => void; onFeedback: (notice: DashboardNotice) => void }) {
  const activity = projectTaskActivity(messages, comments);
  return <section class="task-timeline" aria-label="Activity timeline">
    <header class="task-timeline-heading"><strong>Activity</strong><small>{activity.length} {activity.length === 1 ? 'event' : 'events'}</small></header>
    <ol>{activity.map(item => <li key={item.id} class={`task-timeline-event is-${item.comment ? 'comment' : item.message.kind ?? 'message'}`}>
      <span class="task-timeline-marker" aria-hidden="true" />
      <div class="task-timeline-content"><div class="task-timeline-meta"><strong>{item.label}</strong>{item.comment ? <small>Comment</small> : item.message.status === 'inProgress' ? <small>In progress</small> : null}{item.timestamp ? <time dateTime={item.timestamp} title={new Date(item.timestamp).toLocaleString()}>{new Date(item.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> : null}</div>
        {item.comment ? <><p class="task-timeline-comment">{item.comment.text}</p>{onAttachment ? <TaskAttachmentLinks files={item.comment.attachments} onOpen={file => onAttachment(item.comment!.id, file)} /> : null}</> : <SessionMessage message={item.message} onActionFeedback={onFeedback} />}
      </div>
    </li>)}</ol>
    {!activity.length && !loading ? <p class="task-board-empty">No relevant activity on this history page.</p> : null}
  </section>;
}

type TaskTreeProps = { readOnly?: boolean; task: TaskCard; children: Map<string, TaskCard[]>; pendingIds: Set<string>; onOpen: (task: TaskCard) => void; onGroup?: (parentId: string, event: DragEvent) => void; systemName?: string; agentCounts: Map<string, number>; connected: boolean; busy: boolean; onSessionAction: (task: TaskCard, operation: 'open' | 'start' | 'stop' | 'archive' | 'hide' | 'restore') => void; onMove: (task: TaskCard, stage: TaskStage) => void };
function TaskTree(props: TaskTreeProps) {
  const [expanded, setExpanded] = useState(false);
  const { task } = props, children = props.children.get(task.id) ?? [];
  const canGroup = !!props.onGroup && !task.sessionId && !task.sourceKey;
  const running = task.session?.status === 'running' || task.sessionStatus === 'running' || children.some(child => child.session?.status === 'running' || child.sessionStatus === 'running');
  const status = task.launchPending ? 'Unconfirmed' : props.pendingIds.has(task.id) ? 'Pending sync' : task.archived || task.sessionArchived ? 'Archived' : running ? 'Running' : task.session?.interrupted ? 'Interrupted' : task.sessionStatus === 'unknown' ? 'Unverified' : label(task.stage);
  const agents = task.sessionId ? props.agentCounts.get(`${task.session?.deviceId ?? 'local'}:${task.sessionId}`) ?? 0 : 0;
  const updated = task.session?.updatedAt ?? (task.updatedAt ? new Date(task.updatedAt).toISOString() : undefined);
  return <article class="task-tree-item"><div class="task-card-row">
    <button type="button" draggable={!props.readOnly} class="task-board-card" onDragOver={canGroup ? event => { event.preventDefault(); event.stopPropagation(); } : undefined} onDrop={canGroup ? event => props.onGroup!(task.id, event) : undefined} onDragStart={event => { event.dataTransfer?.setData('application/x-codex-task', task.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; event.currentTarget.closest('.task-card-row')?.classList.add('is-dragging'); }} onDragEnd={event => event.currentTarget.closest('.task-card-row')?.classList.remove('is-dragging')} onClick={() => props.onOpen(task)}>
      <strong title={task.title}>{task.title}</strong><small class="task-card-meta" title={[updated, !props.readOnly && task.session?.model, !props.readOnly && task.session?.reasoningEffort, task.timing ? `${recordedTime(task)} recorded · ${task.timing.runCount} runs` : undefined].filter(Boolean).join(' · ')}><span>{relativeTaskTime(updated)}</span>{!props.readOnly && task.session?.model ? <span>{task.session.model}</span> : !task.sessionId ? <span>Task</span> : null}{task.timing ? <span>{recordedTime(task)} run</span> : null}{task.attachments?.length ? <span>{task.attachments.length} {task.attachments.length === 1 ? 'file' : 'files'}</span> : null}</small>
    </button>
    <div class="task-card-side"><TaskMenu label={`Actions for ${task.title}`}><button type="button" role="menuitem" onClick={() => props.onOpen(task)}>Task details</button>{(props.readOnly ? [] : stages.filter(stage => stage !== task.stage)).map(stage => <button key={stage} type="button" role="menuitem" disabled={!props.connected || props.busy || props.pendingIds.has(task.id) || !!task.launchPending} onClick={() => props.onMove(task, stage)}>Move to {label(stage)}</button>)}{!props.readOnly && task.sessionId ? <button type="button" role="menuitem" onClick={() => props.onSessionAction(task, 'open')}>Open conversation</button> : null}{!props.readOnly && task.sessionId ? <button type="button" role="menuitem" disabled={!props.connected || props.busy || props.pendingIds.has(task.id) || !!task.launchPending} onClick={() => props.onSessionAction(task, 'hide')}>Hide from boards</button> : null}{!props.readOnly ? <button type="button" role="menuitem" disabled={!props.connected || props.busy || props.pendingIds.has(task.id) || !!task.launchPending || !task.sessionId && !!task.archived} onClick={() => props.onSessionAction(task, task.sessionId && running ? 'stop' : 'start')}>{task.sessionId ? running ? 'Stop work' : 'Resume work' : 'Start in Codex'}</button> : null}{!props.readOnly ? <button type="button" role="menuitem" disabled={!props.connected || props.busy || !!task.launchPending || !!task.sessionId && running} onClick={() => props.onSessionAction(task, 'archive')}>{task.sessionId ? task.sessionArchived ? 'Restore conversation' : 'Archive conversation' : task.archived ? 'Restore task' : 'Archive task'}</button> : null}</TaskMenu></div>
    <div class="task-card-counts"><span class={`task-card-state ${running ? 'is-running' : ''}`} title={status}>{running ? <span class="cli-session-spinner" aria-hidden="true" /> : null}<span>{status}</span></span>{agents ? <span title={`${agents} subagents`}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 5a5 5 0 0 1 3 4v2"/></svg>{agents}</span> : null}{children.length ? <button type="button" class="task-tree-expand" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${children.length} subtasks`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '▾' : '▸'} {children.length} {children.length === 1 ? 'sub' : 'subs'}</button> : null}</div>
  </div>{expanded ? <div class="task-tree-children">{children.map(task => <TaskTree key={task.id} {...props} task={task} />)}</div> : null}</article>;
}
function TaskColumn(props: Omit<TaskTreeProps, 'task'> & { stage: TaskStage; tasks: TaskCard[]; onAdd?: () => void; onGroup: (parentId: string, event: DragEvent) => void; onDrop: (stage: TaskStage, event: DragEvent) => void; isDropTarget: boolean; onDragOver: () => void; onDragLeave: () => void }) {
  const [visible, setVisible] = useState(50);
  return <section class={`task-board-column is-${props.stage} ${props.isDropTarget ? 'is-drop-target' : ''}`} aria-label={label(props.stage)} onDragOver={props.readOnly ? undefined : event => { event.preventDefault(); props.onDragOver(); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) props.onDragLeave(); }} onDrop={props.readOnly ? undefined : event => props.onDrop(props.stage, event)}><header class="task-board-column-heading"><strong>{label(props.stage)}<span class="task-column-count">{props.tasks.length}</span></strong>{props.onAdd ? <button type="button" class="task-column-add" aria-label={`Add ${label(props.stage)} task`} title={`Add ${label(props.stage)} task`} onClick={props.onAdd}><PlusIcon/></button> : null}</header><div class="task-board-card-list">{props.tasks.slice(0, visible).map(task => <div key={task.id} class="task-drop-group" onDragOver={event => { event.preventDefault(); event.stopPropagation(); }} onDrop={props.readOnly ? undefined : event => task.sessionId || task.sourceKey ? props.onDrop(props.stage, event) : props.onGroup(task.id, event)}><TaskTree {...props} onGroup={props.readOnly || task.sessionId || task.sourceKey ? undefined : props.onGroup} task={task} /></div>)}{props.tasks.length > visible ? <button type="button" onClick={() => setVisible(visible + 50)}>Show more ({props.tasks.length - visible})</button> : !props.tasks.length ? <div class="task-board-empty"><BoardIcon /><span>No tasks here</span>{props.onAdd ? <button type="button" onClick={props.onAdd}>Create task</button> : null}</div> : null}</div></section>;
}
function relativeTaskTime(value?: string) {
  const at = Date.parse(value ?? ''); if (!Number.isFinite(at)) return 'No activity';
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000));
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
function PlusIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>; }
function BoardIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M6 7v4m6-4v7m6-7v3"/></svg>; }
function SearchIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg>; }
function ShareIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="5" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8 11 7-4M8 13l7 4"/></svg>; }
function ViewIcon({ view }: { view: string }) { return view === 'board' ? <BoardIcon /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">{view === 'calendar' ? <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 2v6m8-6v6M7 14h3m4 0h3M7 18h3"/></> : view === 'gantt' ? <path d="M3 4h8M8 10h10M13 16h8M3 22h18"/> : <path d="M8 5h13M8 12h13M8 19h13M3 5h1m-1 7h1m-1 7h1"/>}</svg>; }
function TaskMenu(props: { label: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => { const rect = trigger.current?.getBoundingClientRect(), menu = panel.current?.getBoundingClientRect(); if (!rect || !menu) return; setPosition({ left: Math.max(8, Math.min(rect.right - menu.width, innerWidth - menu.width - 8)), top: Math.max(8, Math.min(rect.bottom + 4, innerHeight - menu.height - 8)) }); };
    place(); (panel.current?.querySelector<HTMLElement>('button:not(:disabled), summary') ?? panel.current)?.focus({ preventScroll: true });
    const outside = (event: Event) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus({ preventScroll: true }); }
      if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && !(event.target instanceof HTMLInputElement)) {
        const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),summary') ?? [])].filter(item => item.getClientRects().length);
        if (!items.length) return; event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLElement); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', key, true); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  return <><button ref={trigger} type="button" class="task-more-button" aria-label={props.label} title={props.label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button>{open ? createPortal(<div ref={panel} tabIndex={-1} role="menu" aria-label={props.label} class="task-floating-menu" style={{ top: position.top, left: position.left }} onClick={event => { if ((event.target as Element).closest('[role="menuitem"],[role="menuitemradio"]')) { setOpen(false); trigger.current?.focus({ preventScroll: true }); } }}>{props.children}</div>, document.body) : null}</>;
}

function recordedTime(task: TaskCard): string {
  if (!task.timing) return 'No recorded time';
  const minutes = Math.floor(task.timing.durationMs / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes ? `${minutes}m` : '<1m';
}
function taskDate(task: TaskCard): number { return task.timing?.firstStartedAt ?? (task.session?.updatedAt ? Date.parse(task.session.updatedAt) : task.createdAt); }
export function TaskAlternateView(props: { view: 'list' | 'gantt' | 'calendar'; tasks: TaskCard[]; stages: Map<string, TaskStage>; onOpen: (task: TaskCard) => void }) {
  const [month, setMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const [sort, setSort] = useState<'title' | 'stage' | 'date' | 'duration'>('date');
  const [descending, setDescending] = useState(true), [visible, setVisible] = useState(50);
  const [dayLimits, setDayLimits] = useState<Record<string, number>>({});
  useEffect(() => { setVisible(50); setDayLimits({}); }, [props.view, month, sort, descending]);
  const ordered = useMemo(() => [...props.tasks].sort((a,b) => {
    const value = sort === 'title' ? a.title.localeCompare(b.title) : sort === 'stage' ? (props.stages.get(a.id) ?? a.stage).localeCompare(props.stages.get(b.id) ?? b.stage) : sort === 'duration' ? (a.timing?.durationMs ?? -1) - (b.timing?.durationMs ?? -1) : taskDate(a) - taskDate(b);
    return (descending ? -value : value) || a.id.localeCompare(b.id);
  }), [props.tasks, props.stages, sort, descending]);
  const changeSort = (next: typeof sort) => { if (next === sort) setDescending(!descending); else { setSort(next); setDescending(next !== 'title'); } };
  const monthText = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const changeMonth = (delta: number) => setMonth(current => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  const tools = <div class="task-time-toolbar"><strong>{monthText}</strong><div><button type="button" aria-label="Previous month" onClick={() => changeMonth(-1)}>‹</button><button type="button" onClick={() => { const now = new Date(); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); }}>Today</button><button type="button" aria-label="Next month" onClick={() => changeMonth(1)}>›</button></div></div>;
  if (props.view === 'list') return <div class="task-list-view"><table><thead><tr>{[['title','Task'],['stage','Status'],['date','Run date'],['duration','Recorded time']].map(([key,text]) => <th scope="col" aria-sort={sort === key ? descending ? 'descending' : 'ascending' : 'none'}><button type="button" onClick={() => changeSort(key as typeof sort)}>{text}{sort === key ? descending ? ' ↓' : ' ↑' : ''}</button></th>)}<th scope="col">Runs</th></tr></thead><tbody>{ordered.slice(0, visible).map(task => <tr key={task.id}><td><button type="button" class="task-list-title" title={task.title} onClick={() => props.onOpen(task)}>{task.parentTaskId ? <span aria-label="Subtask">↳ </span> : null}{task.title}</button></td><td><span class={`task-card-state ${task.session?.status === 'running' ? 'is-running' : ''}`}>{task.session?.status === 'running' ? <span class="cli-session-spinner" aria-hidden="true" /> : null}{label(props.stages.get(task.id) ?? task.stage)}</span></td><td>{taskDate(task) ? new Date(taskDate(task)).toLocaleDateString() : 'No date'}</td><td>{recordedTime(task)}</td><td>{task.timing?.runCount ?? '—'}</td></tr>)}</tbody></table>{ordered.length > visible ? <button type="button" onClick={() => setVisible(visible+50)}>Show more ({ordered.length-visible})</button> : null}{!ordered.length ? <p class="task-board-empty">No matching tasks.</p> : null}</div>;
  const start = new Date(month.getFullYear(), month.getMonth(), 1), end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const dayCount = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  if (props.view === 'gantt') {
    const rows = ordered.filter(task => taskDate(task) < end.getTime() && (task.timing?.lastObservedAt ?? taskDate(task)) >= start.getTime());
    return <section class="task-time-view" aria-label="Gantt view">{tools}<div class="task-gantt-scroll"><div class="task-gantt-grid" style={{ '--task-days': dayCount }}><div class="task-gantt-ruler"><strong>Task · recorded time</strong><div>{Array.from({ length: dayCount }, (_, index) => <span key={index}>{index+1}</span>)}</div></div>{rows.slice(0,visible).map(task => {
      const first = Math.max(start.getTime(), taskDate(task)), last = Math.min(end.getTime(), task.timing?.lastObservedAt ?? taskDate(task));
      const left = (first - start.getTime()) / (end.getTime() - start.getTime()) * 100, width = Math.max(100 / dayCount * .6, (last - first) / (end.getTime() - start.getTime()) * 100);
      return <div class="task-gantt-row" key={task.id}><button type="button" onClick={() => props.onOpen(task)} title={task.title}><span>{task.title}</span><small>{recordedTime(task)}</small></button><div class="task-gantt-track"><button type="button" class={`task-gantt-bar is-${props.stages.get(task.id) ?? task.stage}`} style={{ left: `${left}%`, width: `${Math.min(width,100-left)}%` }} aria-label={`Open ${task.title}`} title={`${task.title} · ${recordedTime(task)}${task.timing ? ' · Recorded run span' : ' · Activity date; duration not recorded'}`} onClick={() => props.onOpen(task)} /></div></div>;
    })}</div>{rows.length > visible ? <button type="button" onClick={() => setVisible(visible+50)}>Show more ({rows.length-visible})</button> : null}{!rows.length ? <p class="task-board-empty">No recorded task activity this month.</p> : null}</div><small class="task-time-note">Bars show recorded run spans. Recorded time excludes gaps between separate turns.</small></section>;
  }
  const calendarStart = new Date(start); calendarStart.setDate(1 - start.getDay());
  const byDay = new Map<string, TaskCard[]>();
  for (const task of ordered) { const at = taskDate(task); if (!Number.isFinite(at)) continue; const key = new Date(at).toDateString(); const list = byDay.get(key); if (list) list.push(task); else byDay.set(key, [task]); }
  return <section class="task-time-view" aria-label="Calendar view">{tools}<div class="task-calendar-scroll"><div class="task-calendar-weekdays">{Array.from({ length: 7 }, (_, index) => <span key={index}>{new Date(2026,9,18+index).toLocaleDateString(undefined,{weekday:'short'})}</span>)}</div><div class="task-calendar-grid">{Array.from({ length: 42 }, (_, index) => {
    const date = new Date(calendarStart); date.setDate(calendarStart.getDate()+index); const rows = byDay.get(date.toDateString()) ?? [], limit = dayLimits[date.toDateString()] ?? 5;
    return <div key={date.toDateString()} class={`task-calendar-day ${date.getMonth() !== month.getMonth() ? 'is-other-month' : ''} ${date.toDateString() === new Date().toDateString() ? 'is-today' : ''}`}><time dateTime={`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`}>{date.getDate()}</time>{rows.slice(0,limit).map(task => <button type="button" key={task.id} class={`is-${props.stages.get(task.id) ?? task.stage}`} title={`${task.title} · ${recordedTime(task)}`} onClick={() => props.onOpen(task)}>{task.title}</button>)}{rows.length > limit ? <button type="button" class="task-calendar-more" onClick={() => setDayLimits(current => ({ ...current, [date.toDateString()]: limit+10 }))}>{rows.length-limit} more</button> : null}</div>;
  })}</div></div></section>;
}

function FolderIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6h7l2 3h9v11H3z"/></svg>; }

function ChevronDownIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>; }
