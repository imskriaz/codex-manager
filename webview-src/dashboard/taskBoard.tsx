import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DashboardCliProject, DashboardCliSessionSummary, DashboardHostMessage, DashboardActionName, DashboardActionPayload, DashboardActionResultPayload } from '../../src/domain/dashboard/types';
import type { ProjectBoard, ProjectTask, ProjectTaskDetails, ProjectTaskMutation, TaskStage, ProjectSharePermission } from '../../src/domain/projectTasks';
import { projectTaskStages, sessionTaskStage, PROJECT_SHARE_FEATURES } from '../../src/domain/projectTasks';
import { readBrowserCache, writeBrowserCache, listBrowserOutbox, deleteBrowserCache } from './cliSessionCache';
import { ModalShell } from './primitives';
import { SessionMessage } from './cliSessionsModal';
import type { SendAction } from './hookTypes';

type Outbox = { savedAt: number; project: string; device?: string; lastError?: string; task?: ProjectTaskMutation; comment?: { id: string; taskId: string; text: string } };
type TaskCard = ProjectTask & { session?: DashboardCliSessionSummary };
type DetailTab = NonNullable<DashboardActionPayload['taskView']>;
const stages: TaskStage[] = ['idea', 'planned', 'running', 'completed'];
const tabs: DetailTab[] = ['messages', 'activities', 'files', 'changes', 'git'];
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() || value;
const label = (value: string) => value === 'git' ? 'Git history' : value[0]!.toUpperCase() + value.slice(1);
const boardScope = (device: string | undefined, project: string) => JSON.stringify([device ?? 'local', project]);

export function TaskBoard(props: {
  sessions: DashboardCliSessionSummary[]; projects?: DashboardCliProject[]; connected: boolean; targetDeviceId?: string;
  sendAction: SendAction; onOpenSession: (session: DashboardCliSessionSummary) => void;
}) {
  const [extraProjects, setExtraProjects] = useState<string[]>([]), [projectInput, setProjectInput] = useState('');
  const projects = useMemo(() => [...new Set([...extraProjects, ...(props.projects ?? []).map(project => project.path), ...props.sessions.filter(session => session.deviceId === props.targetDeviceId).flatMap(session => session.projectPath ? [session.projectPath] : [])])], [extraProjects, props.projects, props.sessions, props.targetDeviceId]);
  const [project, setProject] = useState(''), [board, setBoard] = useState<ProjectBoard>();
  const [outbox, setOutbox] = useState<Array<{ key: string; value: Outbox }>>([]);
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<TaskCard>();
  const [title, setTitle] = useState(''), [prompt, setPrompt] = useState(''), [parent, setParent] = useState(''), [comment, setComment] = useState('');
  const [search, setSearch] = useState(''), [dropStage, setDropStage] = useState<TaskStage>();
  const [tab, setTab] = useState<DetailTab>('messages'), [cursor, setCursor] = useState<string>();
  const [details, setDetails] = useState<ProjectTaskDetails>(), [detailLoading, setDetailLoading] = useState(false);
  const [file, setFile] = useState<DashboardActionResultPayload['workspaceFile']>();
  const [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false), [share, setShare] = useState<{ url: string; expiresAt: number; permissions: ProjectSharePermission[] }>();
  const [sharePermissions, setSharePermissions] = useState<ProjectSharePermission[]>(['messages', 'activities', 'comments', 'submissions']);
  const [shareDays, setShareDays] = useState(7);
  const scope = boardScope(props.targetDeviceId, project), active = useRef(scope); active.current = scope;
  const deviceRef = useRef(props.targetDeviceId); deviceRef.current = props.targetDeviceId;
  const selection = useRef(selected?.id); selection.current = selected?.id;
  const detailGeneration = useRef(0), receivedBoard = useRef(false), syncing = useRef(false);
  const failedChanges = useRef(new Map<string, string>());
  const refreshing = useRef<{ scope: string; work: Promise<void> }>();
  const currentBoard = useRef(board); currentBoard.current = board;
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const requests = useRef(new Map<string, { resolve: (result: DashboardActionResultPayload) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const call = (action: DashboardActionName, payload: DashboardActionPayload = {}) => new Promise<DashboardActionResultPayload>((resolve, reject) => {
    if (!props.connected) { reject(new Error('Reconnect to use this operation. It was not sent or queued.')); return; }
    const id = props.sendAction(action, undefined, { projectPath: project, targetDeviceId: props.targetDeviceId, ...payload });
    if (!id) { reject(new Error('The request could not be sent.')); return; }
    const timer = setTimeout(() => { requests.current.delete(id); reject(new Error('Completion was not confirmed. Refresh before retrying. Your local draft was kept.')); }, action === 'startProjectTask' ? 915000 : 65000);
    requests.current.set(id, { resolve, reject, timer });
  });
  useEffect(() => {
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type === 'dashboard:project-changed') { void refreshRef.current(); return; }
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
    let disposed = false; setExtraProjects([]); setProject('');
    void readBrowserCache<string[]>(`projects:${props.targetDeviceId ?? 'local'}`).then(saved => { if (!disposed && Array.isArray(saved)) setExtraProjects(saved.filter(path => typeof path === 'string').slice(0, 50)); });
    return () => { disposed = true; };
  }, [props.targetDeviceId]);
  useEffect(() => {
    let disposed = false; receivedBoard.current = false;
    setBoard(undefined); setSelected(undefined); setShare(undefined); setStatus('');
    void readBrowserCache<ProjectBoard>(`board:${scope}`).then(saved => { if (!disposed && !receivedBoard.current && saved) setBoard(saved); });
    void listBrowserOutbox<Outbox>().then(rows => { if (!disposed) setOutbox(rows); });
    return () => { disposed = true; };
  }, [scope]);
  const apply = (next: ProjectBoard | undefined, origin = scope) => {
    if (!next) return;
    const previous = origin === active.current ? currentBoard.current : undefined;
    if (previous && (next.revision !== undefined && previous.revision !== undefined ? next.revision < previous.revision : next.updatedAt < previous.updatedAt)) return;
    void writeBrowserCache(`board:${origin}`, next);
    if (origin === active.current) { receivedBoard.current = true; setBoard(next); }
  };
  const refresh = async () => {
    if (!project || !props.connected) return;
    if (refreshing.current?.scope === scope) return refreshing.current.work;
    const work = (async () => {
      try { apply((await call('getProjectBoard')).projectBoard); }
      catch (error) { if (scope === active.current) setStatus((error as Error).message); }
    })().finally(() => { if (refreshing.current?.work === work) refreshing.current = undefined; });
    refreshing.current = { scope, work }; await work;
  };
  refreshRef.current = refresh;
  const sync = async (retry = false) => {
    if (!props.connected || syncing.current) return;
    syncing.current = true;
    const failures: Record<string, string> = {}, blocked = new Set<string>();
    try {
      const pending = (await listBrowserOutbox<Outbox>()).sort((a,b) => (a.value?.savedAt ?? 0) - (b.value?.savedAt ?? 0) || Number(!!b.value?.task) - Number(!!a.value?.task));
      for (const row of pending) {
        const value = row.value;
        if (!value || typeof value.project !== 'string' || (!value.task && !value.comment) || (value.task && value.comment)) { failures[row.key] = 'Unreadable local change. Copy its contents before removing it.'; continue; }
        const key = JSON.stringify([value.device, value.project, value.task?.id ?? value.comment?.taskId]);
        if (blocked.has(key)) continue;
        const previousError = failedChanges.current.get(row.key) ?? value.lastError;
        if (previousError && !(retry && value.project === project && value.device === props.targetDeviceId)) { failures[row.key] = previousError; blocked.add(key); continue; }
        try {
          const result = await call(value.task ? 'saveProjectTask' : 'addProjectComment', { projectPath: value.project, targetDeviceId: value.device, task: value.task, comment: value.comment });
          if (!await deleteBrowserCache(row.key)) throw new Error('Saved on host; browser cleanup is unconfirmed. Retrying this request is safe.');
          failedChanges.current.delete(row.key);
          apply(result.projectBoard, boardScope(value.device, value.project));
        } catch (error) {
          const message = (error as Error).message;
          failures[row.key] = message; blocked.add(key); failedChanges.current.set(row.key, message);
          await writeBrowserCache(row.key, { ...value, lastError: message });
        }
      }
      setSyncErrors(failures); setOutbox(await listBrowserOutbox<Outbox>());
      if (Object.keys(failures).length) setStatus('Some changes need review. Local drafts were kept; independent changes were synced.');
    } finally { syncing.current = false; }
  };
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden && !disposed) { await refresh(); await sync(); }
      if (!disposed && props.connected) timer = setTimeout(() => { void poll(); }, 5000);
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [scope, props.connected]);
  const rows = outbox.filter(row => row.value?.project === project && row.value.device === props.targetDeviceId);
  const pendingIds = new Set(rows.flatMap(row => row.value.task ? [row.value.task.id] : []));
  const cards = useMemo(() => {
    const tasks: TaskCard[] = (board?.tasks ?? []).map(task => ({ ...task }));
    for (const row of rows) if (row.value.task) {
      const draft = row.value.task, index = tasks.findIndex(task => task.id === draft.id), current = tasks[index];
      const next = { ...current, ...draft, parentTaskId: draft.parentTaskId === null ? undefined : draft.parentTaskId ?? current?.parentTaskId, revision: draft.expectedRevision, createdAt: current?.createdAt ?? 0, updatedAt: row.value.savedAt };
      if (index < 0) tasks.push(next); else tasks[index] = next;
    }
    const sessions = new Map(board?.sessions.map(session => [session.id, session]));
    for (const session of props.sessions) if (session.deviceId === props.targetDeviceId) sessions.set(session.id, session);
    for (const task of tasks) if (task.sessionId && (!task.sourceKey || task.sourceKey.startsWith(`${board?.homeKey}:`))) {
      task.session = sessions.get(task.sessionId);
      if (task.session && !pendingIds.has(task.id)) { task.title = task.session.title; task.sessionStatus = task.session.status; if (task.session.status !== 'unknown') task.stage = sessionTaskStage(task.session); }
    }
    return tasks.sort((a,b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }, [board, outbox, props.sessions, scope]);
  const effectiveStages = useMemo(() => projectTaskStages(cards), [cards]);
  const visibleCards = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? cards.filter(task => `${task.title}\n${task.prompt}`.toLowerCase().includes(query)) : cards;
  }, [cards, search]);
  const children = useMemo(() => {
    const map = new Map<string, TaskCard[]>();
    for (const task of cards) if (task.parentTaskId) map.set(task.parentTaskId, [...(map.get(task.parentTaskId) ?? []), task]);
    return map;
  }, [cards]);
  const ids = new Set(cards.map(task => task.id));
  const roots = visibleCards.filter(task => !task.parentTaskId || !ids.has(task.parentTaskId));
  const moveDropped = async (stage: TaskStage, event: DragEvent): Promise<void> => {
    event.preventDefault(); setDropStage(undefined);
    const taskId = event.dataTransfer?.getData('application/x-codex-task');
    const rawSession = event.dataTransfer?.getData('application/x-codex-session');
    let sourceId = taskId;
    if (!sourceId && rawSession) { try { sourceId = (JSON.parse(rawSession) as { id?: string }).id; } catch { /* malformed drag data */ } }
    const task = sourceId ? cards.find(item => item.id === sourceId || item.sessionId === sourceId) : undefined;
    if (!task || !task.revision) { setStatus('Refresh the board before moving this session.'); return; }
    if (task.launchPending) { setStatus('This task cannot move until its current operation is confirmed.'); return; }
    if (task.stage === stage) return;
    await action('saveProjectTask', { task: { id: task.id, title: task.title, prompt: task.prompt, stage, expectedRevision: task.revision, parentTaskId: task.parentTaskId ?? null } });
  };
  const open = (task: TaskCard) => {
    detailGeneration.current++; selection.current = task.id;
    setSelected(task); setTitle(task.title); setPrompt(task.prompt); setParent(task.parentTaskId ?? ''); setComment(''); setTab('messages'); setCursor(undefined); setDetails(undefined); setFile(undefined);
  };
  useEffect(() => {
    const generation = ++detailGeneration.current;
    setDetails(undefined); setFile(undefined); setDetailLoading(false);
    if (!selected?.id || !selected.revision) return;
    const taskId = selected.id, origin = scope;
    let disposed = false, timer: ReturnType<typeof setTimeout>, received = false;
    const current = () => !disposed && generation === detailGeneration.current && origin === active.current && taskId === selection.current;
    const key = `task:${JSON.stringify([props.targetDeviceId ?? 'local', project, taskId, tab, cursor ?? 'latest'])}`;
    void readBrowserCache<ProjectTaskDetails>(key).then(saved => { if (current() && !received && saved) setDetails(saved); });
    const poll = async () => {
      if (!current() || !props.connected) return;
      setDetailLoading(true);
      try {
        const next = (await call('getProjectTaskDetails', { taskId, taskView: tab, taskBefore: cursor })).projectTaskDetails;
        if (next && current()) {
          received = true;
          if (next.warnings.length) setDetails(previous => previous ? { ...previous, warnings: next.warnings } : next);
          else { setDetails(next); void writeBrowserCache(key, next); }
        }
      } catch (error) { if (current()) setStatus((error as Error).message); }
      finally { if (current()) { setDetailLoading(false); if (!cursor) timer = setTimeout(() => { if (!document.hidden) void poll(); else timer = setTimeout(() => { void poll(); }, 3000); }, 3000); } }
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [scope, selected?.id, tab, cursor, props.connected]);
  const enqueue = async (value: Omit<Outbox, 'savedAt'>, operationId: string): Promise<boolean> => {
    const key = `outbox:${JSON.stringify([value.device ?? 'local', value.project, operationId])}`;
    if (!await writeBrowserCache(key, { ...value, savedAt: Date.now() })) { setStatus('Browser storage is full or unavailable. Your open draft was kept; reconnect before closing this view.'); return false; }
    setOutbox(await listBrowserOutbox<Outbox>()); setStatus(props.connected ? 'Saved locally. Syncing…' : 'Saved offline. This task or comment will sync when connected.');
    void sync(); return true;
  };
  const save = async (groupOnly = false) => {
    if (!selected || !title.trim()) return;
    let ancestor = parent;
    const seen = new Set([selected.id]);
    while (ancestor) {
      if (seen.has(ancestor)) { setStatus('Choose a parent outside this task and its descendants.'); return; }
      seen.add(ancestor); ancestor = cards.find(task => task.id === ancestor)?.parentTaskId ?? '';
    }
    if (pendingIds.has(selected.id)) { setStatus('A saved edit is pending. Review or sync it before editing again.'); return; }
    setBusy(true);
    try {
      const task: ProjectTaskMutation = { id: selected.id || crypto.randomUUID(), title: groupOnly ? selected.title : title.trim(), prompt: groupOnly ? selected.prompt : prompt,
        stage: selected.stage, expectedRevision: selected.revision, parentTaskId: parent || null };
      if (await enqueue({ project, device: props.targetDeviceId, task }, `${task.id}:${task.expectedRevision}`)) setSelected(undefined);
    } finally { setBusy(false); }
  };
  const submitComment = async () => {
    if (!selected?.id || !comment.trim()) return;
    setBusy(true);
    try { const id = crypto.randomUUID(); if (await enqueue({ project, device: props.targetDeviceId, comment: { id, taskId: selected.id, text: comment.trim() } }, id)) setComment(''); }
    finally { setBusy(false); }
  };
  const action = async (operation: DashboardActionName, payload: DashboardActionPayload = {}) => {
    const origin = scope; setBusy(true);
    try {
      const result = await call(operation, payload); apply(result.projectBoard, origin);
      if (origin !== active.current) return;
      if (result.projectBoard && selected?.id) { const latest = result.projectBoard.tasks.find(task => task.id === selected.id); if (latest) setSelected({ ...latest, session: selected.session }); }
      if (result.projectShare) setShare({ url: new URL(`/projects/share/${result.projectShare.token}`, location.origin).href, expiresAt: result.projectShare.expiresAt, permissions: result.projectShare.permissions });
      setStatus(result.notice?.message ?? 'Done.'); return true;
    } catch (error) { if (origin === active.current) setStatus((error as Error).message); return false; }
    finally { setBusy(false); }
  };
  const openFile = async (filePath: string) => {
    const generation = detailGeneration.current, key = `file:${JSON.stringify([props.targetDeviceId ?? 'local', project, filePath])}`;
    try {
      const cached = await readBrowserCache<NonNullable<DashboardActionResultPayload['workspaceFile']>>(key);
      if (generation === detailGeneration.current && cached) setFile(cached);
      if (!props.connected) { if (!cached) setStatus('This file has no offline copy. Open it when connected.'); return; }
      const next = (await call('readWorkspaceFile', { filePath })).workspaceFile;
      if (next && generation === detailGeneration.current) { setFile(next); void writeBrowserCache(key, next); }
    } catch (error) { setStatus((error as Error).message); }
  };
  const comments = [...(board?.comments ?? []), ...rows.flatMap(row => row.value.comment && !(board?.comments.some(item => item.id === row.value.comment!.id)) ? [{ ...row.value.comment, author: 'You · pending', createdAt: 0 }] : [])].filter(item => item.taskId === selected?.id);
  return <section class="task-board-section" aria-labelledby="task-board-title">
    <header class="task-board-header"><div><span class="task-board-eyebrow">PROJECT WORK</span><h2 id="task-board-title">Task view</h2></div><div class="task-board-toolbar">
      <select aria-label="Task project" value={project} disabled={busy} onChange={event => setProject(event.currentTarget.value)}><option value="">Choose a project</option>{projects.map(value => <option key={value} value={value}>{basename(value)}</option>)}</select>
      <details class="task-project-picker"><summary>Add project</summary><label>Project folder<input aria-label="Project folder path" placeholder="Absolute folder path" value={projectInput} onInput={event => setProjectInput(event.currentTarget.value)} /></label><button type="button" disabled={!props.connected || busy || !projectInput.trim()} onClick={() => {
        const device = props.targetDeviceId; setBusy(true);
        void call('getProjectBoard', { projectPath: projectInput.trim() }).then(result => {
          if (device !== deviceRef.current || !result.projectBoard) return;
          const path = result.projectBoard.projectPath, next = [path, ...extraProjects.filter(value => value !== path)].slice(0,50);
          setExtraProjects(next); setProject(path); setProjectInput(''); void writeBrowserCache(`projects:${device ?? 'local'}`, next);
          void writeBrowserCache(`board:${boardScope(device, path)}`, result.projectBoard);
        }).catch(error => setStatus((error as Error).message)).finally(() => setBusy(false));
      }}>Use project</button></details>
      <button type="button" disabled={!project || busy} onClick={() => open({ id: '', title: '', prompt: '', stage: 'idea', revision: 0, createdAt: 0, updatedAt: 0 })}>＋ Task</button>
      <button type="button" disabled={!project || !props.connected || busy} onClick={() => setShareOpen(true)}>Share project</button>
      <button type="button" disabled={!project || !props.connected || busy} onClick={() => { void refresh(); }} title="Refresh the saved project board">↻ Refresh</button><button type="button" disabled={!project || !props.connected || busy} onClick={() => { void sync(true); }} title="Sync local task drafts and comments">⇄ Sync{rows.length ? ` (${rows.length})` : ''}</button>
    </div></header>
    <div class="task-board-subtoolbar"><label class="task-board-search"><span>⌕</span><input type="search" aria-label="Search tasks" placeholder="Search tasks…" value={search} onInput={event => setSearch(event.currentTarget.value)} /></label><span class="task-board-hint">Drag a session or card into a column to change its stage.</span></div>
    <p class="task-board-status" role="status">{props.connected ? 'Connected' : 'Offline · saved view'}{board ? ` · Updated ${new Date(board.updatedAt).toLocaleTimeString()}` : ''}{status ? ` · ${status}` : ''}</p>
    <div class="task-board-columns">{stages.map(stage => <TaskColumn key={`${scope}:${stage}`} stage={stage} tasks={roots.filter(task => effectiveStages.get(task.id) === stage)} children={children} pendingIds={pendingIds} onOpen={open} onDrop={moveDropped} isDropTarget={dropStage === stage} onDragOver={() => setDropStage(stage)} onDragLeave={() => setDropStage(undefined)} />)}</div>
    {rows.some(row => syncErrors[row.key]) ? <details class="task-sync-conflicts"><summary>Review unsynced changes</summary>{rows.filter(row => syncErrors[row.key]).map(row => <article key={row.key}><p>{syncErrors[row.key]}</p><pre>{JSON.stringify(row.value.task ?? row.value.comment, null, 2)}</pre><button type="button" onClick={() => { if (window.confirm('Discard this local change? The host version will be kept.')) void deleteBrowserCache(row.key).then(async removed => { if (removed) { setOutbox(await listBrowserOutbox<Outbox>()); setStatus('Local change discarded. Host version kept.'); } else setStatus('Browser storage did not confirm removal. Local change kept.'); }); }}>Discard local change</button></article>)}</details> : null}
    <ModalShell open={Boolean(selected)} title={selected?.title || 'New task'} closeLabel="Close" onClose={() => setSelected(undefined)} className="task-detail-modal">
      {selected ? <><div class="task-detail-meta">{basename(project)} · {label(selected.stage)}{!props.connected ? ' · Offline saved view' : ''}</div>
        {!selected.sourceKey ? <div class="task-edit"><label>Title<input value={title} maxLength={240} onInput={event => setTitle(event.currentTarget.value)} /></label><label>Prompt / idea<textarea value={prompt} maxLength={32000} rows={3} onInput={event => setPrompt(event.currentTarget.value)} /></label><label>Stage<select value={selected.stage} disabled={Boolean(selected.sessionId || selected.launchPending)} onChange={event => setSelected({ ...selected, stage: event.currentTarget.value as TaskStage })}>{stages.filter(stage => stage !== 'running' || selected.stage === 'running').map(stage => <option key={stage} value={stage}>{label(stage)}</option>)}</select></label><div class="settings-actions"><button type="button" disabled={busy || !title.trim() || Boolean(selected.launchPending)} onClick={() => { void save(); }}>Save task</button>{selected.id ? <button type="button" disabled={!props.connected || busy || Boolean(selected.launchPending || selected.sessionId) || !selected.revision || selected.stage !== 'planned' || pendingIds.has(selected.id) || prompt !== selected.prompt || title !== selected.title} onClick={() => { void action('startProjectTask', { taskId: selected.id, taskRevision: selected.revision }); }}>Start in Codex</button> : null}</div></div> : null}
        <div class="task-grouping"><label>Parent task<select aria-label="Parent task" value={parent} disabled={busy || Boolean(selected.launchPending)} onChange={event => setParent(event.currentTarget.value)}><option value="">Top-level board</option>{cards.filter(task => task.id !== selected.id).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>{selected.id ? <><button type="button" disabled={busy || Boolean(selected.launchPending) || parent === (selected.parentTaskId ?? '') || pendingIds.has(selected.id)} onClick={() => { void save(true); }}>Move {parent ? 'under task' : 'to board'}</button><button type="button" disabled={busy} onClick={() => open({ id: '', title: '', prompt: '', stage: 'planned', revision: 0, parentTaskId: selected.id, createdAt: 0, updatedAt: 0 })}>＋ Subtask</button></> : null}</div>
        {selected.launchPending ? <div class="task-start-review"><p>Startup was not confirmed. Review the session list before allowing another start.</p><button type="button" disabled={!props.connected || busy} onClick={() => { if (window.confirm('I reviewed sessions and verified that the previous start was not accepted. Allow this task to start again?')) void action('resetProjectTaskStart', { taskId: selected.id, taskRevision: selected.revision, confirmed: true }); }}>Allow retry after review</button></div> : null}
        {children.get(selected.id)?.length ? <div class="task-subtasks"><strong>Subtasks</strong>{children.get(selected.id)!.map(task => <button key={task.id} type="button" onClick={() => open(task)}>{task.title}<small>{label(effectiveStages.get(task.id) ?? task.stage)}</small></button>)}</div> : null}
        <div class="task-detail-tabs" role="tablist" aria-label="Task details">{tabs.map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => { detailGeneration.current++; setTab(value); setCursor(undefined); }}>{label(value)}</button>)}</div>
        <div class="task-detail-scroll" role="tabpanel">{details?.warnings.map(warning => <p key={warning} class="settings-note" role="status">{warning}</p>)}
          {cursor ? <button type="button" disabled={detailLoading} onClick={() => setCursor(undefined)}>Latest activity</button> : null}{details?.olderThan && ['messages','activities','changes'].includes(tab) ? <button type="button" disabled={detailLoading} onClick={() => setCursor(details.olderThan)}>Older history</button> : null}
          {['messages','activities'].includes(tab) ? details?.messages.filter(item => tab === 'messages' ? !item.kind || item.kind === 'message' : item.kind && item.kind !== 'message').map(item => <SessionMessage key={item.id} message={item} onActionFeedback={notice => setStatus(notice.message)} />) : null}
          {tab === 'files' ? <><p class="settings-note">Files shared or changed in this conversation · read-only</p>{details?.files.map(entry => <button type="button" class="task-file-row" key={entry.path} disabled={entry.type !== 'file'} onClick={() => { void openFile(entry.path); }}><span>{entry.path}</span><small>Chat file</small></button>)}{details && !details.files.length ? <p class="task-board-empty">No files were shared or changed in this conversation.</p> : null}{file ? <article class="task-activity"><strong>{file.path}</strong>{file.kind === 'image' && file.dataUrl ? <img src={file.dataUrl} alt={file.path} /> : <pre>{file.content}</pre>}</article> : null}</> : null}
          {tab === 'changes' ? <><p>Current project: {details?.environment?.changes ?? 0} changed files · +{details?.environment?.additions ?? 0} / −{details?.environment?.deletions ?? 0}</p>{details?.environment?.branchDiff ? <details><summary>Current branch differences</summary><pre>{details.environment.branchDiff}</pre></details> : null}{details?.messages.filter(item => item.changes?.length).map(item => <SessionMessage key={item.id} message={item} />)}</> : null}
          {tab === 'git' ? details?.environment?.isGitRepository ? details.history.map(commit => <article class="task-activity" key={commit.hash}><strong>{commit.subject}</strong><small>{commit.hash.slice(0,8)} · {commit.author} · {commit.date}</small></article>) : details ? <p>This project has no Git repository.</p> : null : null}
          {detailLoading ? <p role="status" class="settings-note">Refreshing {label(tab).toLowerCase()}…</p> : !details ? <p class="task-board-empty">{selected.id ? 'No cached details yet. Reconnect to load this view.' : 'Save this task to add comments and start Codex.'}</p> : !details.messages.length && ['messages','activities'].includes(tab) ? <p class="task-board-empty">No activity on this history page.</p> : null}
        </div>
        <div class="task-comments"><strong>Comments</strong>{comments.map(item => <article class="task-activity" key={item.id}><small>{item.author}</small><p>{item.text}</p></article>)}<textarea aria-label="Add a comment" value={comment} maxLength={8000} placeholder="Leave a comment…" onInput={event => setComment(event.currentTarget.value)} /><button type="button" disabled={busy || !selected.id || !comment.trim()} onClick={() => { void submitComment(); }}>Add comment</button></div>
        <p role="status" class="settings-note">{status}</p>{selected.session ? <button type="button" onClick={() => props.onOpenSession(selected.session!)}>Open conversation ↗</button> : null}
      </> : null}
    </ModalShell>
    <ModalShell open={shareOpen} title="Share project" closeLabel="Close" onClose={() => setShareOpen(false)} className="project-share-modal">
      <p>Anyone with this link can view task titles, prompts, and subtasks. Choose the additional features they can access.</p>
      <div class="project-share-permissions">{PROJECT_SHARE_FEATURES.map(feature => <label key={feature.key}><input type="checkbox" checked={sharePermissions.includes(feature.key)} onChange={event => setSharePermissions(current => event.currentTarget.checked ? [...current, feature.key] : current.filter(value => value !== feature.key))} /><span><strong>{feature.label}</strong><small>{feature.description}</small></span></label>)}</div>
      <label>Link expires<select value={shareDays} onChange={event => setShareDays(Number(event.currentTarget.value))}>{[1,7,30].map(days => <option key={days} value={days}>{days} day{days > 1 ? 's' : ''}</option>)}</select></label>
      <div class="settings-actions"><button type="button" disabled={!props.connected || busy || !location.protocol.startsWith('http')} onClick={() => { void action('shareProjectBoard', { sharePermissions, shareDays }); }}>Create link</button><button type="button" disabled={!props.connected || busy} onClick={() => { void action('revokeProjectShares').then(success => { if (success) setShare(undefined); }); }}>Revoke all project links</button></div>
      {!location.protocol.startsWith('http') ? <p class="settings-note">Open Task view in the browser dashboard to create a reachable public link.</p> : null}
      {share ? <div class="task-share-result"><label>Public link<input readOnly value={share.url} onFocus={event => event.currentTarget.select()} /></label><small>Expires {new Date(share.expiresAt).toLocaleString()}. Permissions are fixed when this link is created.</small><a href={share.url} target="_blank" rel="noreferrer">Open shared board ↗</a>{share.permissions.includes('embed') ? <label>Embed code<textarea readOnly rows={3} value={`<iframe src="${share.url}" title="Project tasks" width="100%" height="720" loading="lazy" referrerpolicy="no-referrer"></iframe>`} onFocus={event => event.currentTarget.select()} /></label> : null}</div> : null}
      <p role="status" class="settings-note">{status}</p>
    </ModalShell>
  </section>;
}

function TaskTree(props: { task: TaskCard; children: Map<string, TaskCard[]>; pendingIds: Set<string>; onOpen: (task: TaskCard) => void }) {
  const [expanded, setExpanded] = useState(false);
  const children = props.children.get(props.task.id) ?? [];
  return <article class="task-tree-item"><button type="button" draggable class="task-board-card" onDragStart={event => { event.dataTransfer?.setData('application/x-codex-task', props.task.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }} onClick={() => props.onOpen(props.task)}><strong>{props.task.title}</strong>{props.task.prompt ? <p>{props.task.prompt}</p> : null}<footer><span>{props.task.launchPending ? 'Start unconfirmed' : props.pendingIds.has(props.task.id) ? 'Pending sync' : props.task.session?.interrupted ? 'Interrupted' : props.task.session?.archived ? 'Archived' : props.task.session?.status === 'unknown' || props.task.sessionStatus === 'unknown' ? 'State unverified' : props.task.sessionId ? 'Codex session' : 'Task'}</span><small>{props.task.session?.model ?? ''}</small></footer></button>{children.length ? <><button type="button" class="task-tree-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '▾' : '▸'} {children.length} subtasks</button>{expanded ? <div class="task-tree-children">{children.map(task => <TaskTree key={task.id} {...props} task={task} />)}</div> : null}</> : null}</article>;
}

function TaskColumn(props: { stage: TaskStage; tasks: TaskCard[]; children: Map<string, TaskCard[]>; pendingIds: Set<string>; onOpen: (task: TaskCard) => void; onDrop: (stage: TaskStage, event: DragEvent) => void; isDropTarget: boolean; onDragOver: () => void; onDragLeave: () => void }) {
  const [visible, setVisible] = useState(50);
  return <section class={`task-board-column is-${props.stage} ${props.isDropTarget ? 'is-drop-target' : ''}`} aria-label={label(props.stage)} onDragOver={event => { event.preventDefault(); props.onDragOver(); }} onDragLeave={event => { if (event.currentTarget === event.target) props.onDragLeave(); }} onDrop={event => props.onDrop(props.stage, event)}><header class="task-board-column-heading"><strong><i />{label(props.stage)}</strong><span>{props.tasks.length}</span></header><div class="task-board-card-list">{props.tasks.slice(0, visible).map(task => <TaskTree key={task.id} task={task} children={props.children} pendingIds={props.pendingIds} onOpen={props.onOpen} />)}{props.tasks.length > visible ? <button type="button" onClick={() => setVisible(visible + 50)}>Show more ({props.tasks.length - visible})</button> : !props.tasks.length ? <p class="task-board-empty">{props.stage === 'idea' ? 'Collect the next useful idea.' : props.stage === 'planned' ? 'Plan your next task.' : props.stage === 'running' ? 'Active work appears here.' : 'Completed and archived work appears here.'}</p> : null}</div></section>;
}
