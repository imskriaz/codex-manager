import { useAnchoredPopover } from './anchoredPopover';
import { ScrollMore } from './scrollMore';
import { deferredPanel } from './deferredPanel';
const WorkspaceTerminal = deferredPanel(() => import('./workspaceTerminal'), 'terminal');
const WorkspaceCodeEditor = deferredPanel(() => import('./workspaceCodeEditor'), 'editor');
import { WorkspaceGit } from './workspaceGit';
import { readChatAttachmentFiles } from './attachmentUploads';
import { createPortal } from "preact/compat";
import type { JSX } from "preact";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import MarkdownIt from "markdown-it";
import { workspaceFileFromLink } from './workspaceFileLink';
import type {
  DashboardCliComposerConfig,
  DashboardCliSandboxMode,
  DashboardCliSessionMessage,
  DashboardCliSessionSummary,
  DashboardCodexSessionLiveState,
  DashboardNotice,
  DashboardWorkspaceEnvironment,
  DashboardWorkspaceGitRequest,
  DashboardWorkspaceFile,
  DashboardWorkspaceFileEntry,
  DashboardWorkspaceTerminalInfo,
  DashboardWorkspaceTerminalOutput,
  DashboardWorkspaceTerminalResult
} from "../../src/domain/dashboard/types";
import type { DashboardAccountViewModel } from "../../src/domain/dashboard/types";
import { validateChatAttachments, prepareChatInput, type ChatAttachment } from "../../src/domain/chatAttachments";
import { readSubAgentMetadata } from "../../src/domain/sessionSource";
import { cliSessionTargetKey } from "./cliSessionRoute";
import { isCliTurnActive, isCliLiveStateCurrent, reconcileCliSessionStatuses } from "./cliSessionLiveState";
import { handleTabKeyDown, ModalShell, useModalAccessibility } from "./primitives";
import { ShareAccessReview, ShareLinkField } from "./shareControls";
import { getSensitiveDisplayValue } from "./helpers";
import { normalizeNativePath } from "../../src/utils/nativePaths";
import { readCliComposerDraft, readLegacyCliComposerDraft, writeCliComposerDraft } from "./cliSessionCache";
import { acknowledgeCliComposerDraft, cliComposerDraftKey, resolveCliComposerSettings, restoreFailedCliComposerDraft, type CliComposerDraft, type CliSubmissionResult } from "./cliSessionComposerState";

export type CliSessionFeedback = DashboardNotice & { key: number };
type WorkspaceTab = WorkspaceToolTab | `agent:${string}` | `file:${string}` | `review:${string}`;
type WorkspaceToolTab = "env" | "git" | "terminal" | "files" | "reviews" | "agents";
type WorkspaceFileDraft = { text: string; revision: string };
type WorkspaceProjectState = { tabs: WorkspaceTab[]; active: WorkspaceTab; draft?: string; fileNotice?: DashboardNotice; fileDrafts?: Record<string, WorkspaceFileDraft>; commitDraft?: string; workspaceGitPending?: boolean; workspaceGitNotice?: string; gitPending?: { requestId: string; kind: 'commit' | 'push' }; gitNotice?: DashboardNotice };
const emptyWorkspaceProject = (): WorkspaceProjectState => ({ tabs: ['env'], active: 'env' });
export type CliSessionSection = "active" | "archived";
import { filterCliSessionsBySection, isCodexCapacityInterruption, isCodexSessionRunning, normalizeCodexSessionGoal, stabilizeCliSessionOrder, showsCodexSessionAutoResume } from "../../src/domain/codexSessionState";
export { filterCliSessionsBySection, countPeerSessions } from "../../src/domain/codexSessionState";

async function copyWorkspaceText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (!document.execCommand("copy")) throw new Error("copy failed");
    } finally {
      textarea.remove();
    }
  }
}

export function getMessagePrompt(messages: DashboardCliSessionMessage[], id: string): string | undefined {
  const index = messages.findIndex((message) => message.id === id);
  return index < 0 ? undefined : messages.slice(0, index + 1).reverse().find((message) => message.role === "user" && (!message.kind || message.kind === "message"))?.text;
}

export function getSessionGoal(messages: DashboardCliSessionMessage[]) {
  let goal: { objective: string; status: string; elapsedMs?: number; detail?: string } | undefined;
  const read = (value?: string): Record<string, unknown> | undefined => {
    try { const parsed: unknown = JSON.parse(value ?? ""); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
  };
  for (const message of messages) {
    if (message.kind !== "tool-call" || message.status !== "completed") continue;
    const operation = /\b(create_goal|get_goal|update_goal)\b/.exec(message.title ?? "")?.[1];
    if (!operation) continue;
    const args = read(message.arguments);
    const result = read(message.result);
    if (operation === "get_goal" && result && result["goal"] === null) { goal = undefined; continue; }
    const nested = result?.["goal"];
    const data = nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : result;
    const objective = data?.["objective"] ?? (operation === "create_goal" ? args?.["objective"] : goal?.objective);
    if (typeof objective !== "string" || !objective.trim()) continue;
    const status = data?.["status"] ?? (operation === "update_goal" ? args?.["status"] : operation === "create_goal" ? "active" : goal?.status);
    if (typeof status !== "string" || !["active", "complete", "paused", "blocked", "cancelled", "budget_limit", "usage_limit"].includes(status)) continue;
    const elapsed = data?.["elapsed_ms"] ?? data?.["elapsedMs"];
    goal = { objective: objective.trim(), status, elapsedMs: typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : goal?.elapsedMs, detail: message.result };
  }
  return goal;
}

const workspaceTabKind = (tab: WorkspaceTab): WorkspaceToolTab => tab.startsWith("agent:") ? "agents" : tab.startsWith("file:") ? "files" : tab.startsWith("review:") ? "reviews" : tab as WorkspaceToolTab;
const workspaceTabPath = (tab: WorkspaceTab): string | undefined => tab.includes(":") ? tab.slice(tab.indexOf(":") + 1) : undefined;

type WorkspaceLayout = {
  sessionView: "projects" | "compact";
  railWidth: number;
  terminalWidth: number;
  composerHeight: number;
};

const WORKSPACE_LAYOUT_STORAGE_KEY = "codexManager.workspaceLayout.v2";
const WORKSPACE_TERMINAL_ID = "workspace-terminal";
const markdownRenderer = new MarkdownIt({ html: false, linkify: true, typographer: true });
const validateMarkdownLink = markdownRenderer.validateLink.bind(markdownRenderer);
markdownRenderer.validateLink = href => validateMarkdownLink(href) || workspaceFileFromLink(href) !== undefined;
const renderMarkdownFence = markdownRenderer.renderer.rules["fence"]!;
markdownRenderer.renderer.rules["fence"] = (tokens, index, options, env, renderer) =>
  `<div class="cli-markdown-code-block"><button type="button" class="cli-code-copy" aria-label="Copy code">Copy code</button>${renderMarkdownFence(tokens, index, options, env, renderer)}</div>`;
markdownRenderer.renderer.rules["link_open"] = (tokens, index, options, _env, renderer) => {
  const token = tokens[index]!, file = workspaceFileFromLink(String(token.attrGet('href') ?? ''));
  if (file) { token.attrSet('href', '#'); token.attrSet('data-workspace-file', file); }
  else { token.attrSet("target", "_blank"); token.attrSet("rel", "noopener noreferrer"); }
  return renderer.renderToken(tokens, index, options);
};
const renderMarkdownImage = markdownRenderer.renderer.rules["image"]!;
markdownRenderer.renderer.rules["image"] = (tokens, index, options, env, renderer) => {
  tokens[index]!.attrSet("loading", "lazy");
  tokens[index]!.attrSet("decoding", "async");
  tokens[index]!.attrSet("tabindex", "0");
  tokens[index]!.attrSet("role", "button");
  tokens[index]!.attrSet("aria-label", "Preview image");
  return renderMarkdownImage(tokens, index, options, env, renderer);
};
const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  sessionView: "compact",
  railWidth: 260,
  terminalWidth: 320,
  composerHeight: 136
};
const EMPTY_CHAT_ATTACHMENTS: ChatAttachment[] = [];
type ComposerDraft = CliComposerDraft;

export type CliSessionsPageProps = {
  browser?: boolean;
  dashboardMode?: boolean;
  taskBoardActive?: boolean;
  taskBoardEnabled?: boolean;
  onTasks?: () => void;
  onApi?: () => void;
  /** Show the remote dashboard sign-out action in the avatar menu. */
  showLogout?: boolean;
  privacyMode: boolean;
  autoResumeEnabled: boolean;
  sessions: DashboardCliSessionSummary[];
  selectedSession?: DashboardCliSessionSummary;
  messages: DashboardCliSessionMessage[];
  liveState?: DashboardCodexSessionLiveState;
  liveStates?: Record<string, DashboardCodexSessionLiveState>;
  connected?: boolean;
  submissionResults?: CliSubmissionResult[];
  steering?: boolean;
  onSteer?: (input: { text: string; attachments?: ChatAttachment[]; expectedTurnId: string }) => string | undefined;
  agentMessages?: Record<string, { messages?: DashboardCliSessionMessage[]; error?: string; loading?: boolean }>;
  onReadAgent?: (agent: DashboardCliSessionSummary) => void;
  composerConfig?: DashboardCliComposerConfig;
  loading: boolean;
  starting: boolean;
  messagesLoading: boolean;
  sending: boolean;
  stopping: boolean;
  mutating: boolean;
  goalUpdating?: boolean;
  onGoalStatus?: (status: "active" | "paused") => void;
  error?: string;
  messagesError?: string;
  onActionFeedback: (notice: DashboardNotice) => void;
  environment?: DashboardWorkspaceEnvironment;
  terminalResults: DashboardWorkspaceTerminalResult[];
  terminalLiveOutputs: DashboardWorkspaceTerminalOutput[];
  workspaceTerminals: DashboardWorkspaceTerminalInfo[];
  environmentLoading: boolean;
  workspaceScopeKey?: string;
  onWorkspaceContextChange?: (key: string) => void;
  terminalRunning: boolean;
  terminalStopping: boolean;
  workspaceFiles: DashboardWorkspaceFileEntry[];
  workspaceFilesByPath: Record<string, DashboardWorkspaceFile>;
  workspaceFilesLoading: boolean;
  workspaceFileLoading: boolean;
  workspaceFileSaving: boolean;
  logoUri?: string;
  onDashboard: () => void;
  onSettings: () => void;
  switchingAccount: boolean;
  account?: DashboardAccountViewModel;
  localAccounts?: DashboardAccountViewModel[];
  onSwitchAccount: (targetDeviceId?: string, accountId?: string) => void;
  peers?: Array<{ id: string; name: string; connected: boolean; local?: boolean }>;
  selectedPeerId?: string;
  peerAccounts?: Record<string, DashboardAccountViewModel[]>;
  onPeerChange?: (peerId: string) => void;
  onRefresh: () => void;
  onStart: (input: { text: string; attachments?: ChatAttachment[]; model?: string; reasoningEffort?: string; sandboxMode: DashboardCliSandboxMode; projectPath?: string }) => string | undefined;
  onSelect: (session: DashboardCliSessionSummary) => void;
  onBackToList: () => void;
  onRefreshMessages: () => void;
  onRefreshEnvironment: (projectPath?: string, includeBranchDiff?: boolean, gitHistory?: DashboardWorkspaceGitRequest) => void;
  onRunTerminal: (command: string, projectPath?: string, terminalId?: string) => string | undefined;
  onListTerminals: () => void;
  onCreateTerminal: (profile: "default" | "powershell" | "cmd" | "bash", projectPath?: string) => void;
  onFocusTerminal: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onCancelTerminal: (terminalId?: string) => void;
  onCommitWorkspace: (commitMessage: string, projectPath?: string) => string | undefined;
  onPushWorkspace: (projectPath?: string) => string | undefined;
  onClearTerminal: () => void;
  onListFiles: (projectPath?: string) => void;
  onReadFile: (filePath: string, projectPath?: string) => void;
  onClearFile: () => void;
  onDeleteFile: (filePath: string, projectPath?: string) => void;
  onSaveFile: (filePath: string, content: string, revision: string, projectPath?: string) => string | undefined;
  onSend: (input: {
    text: string;
    attachments?: ChatAttachment[];
    model?: string;
    reasoningEffort?: string;
    sandboxMode: DashboardCliSandboxMode;
    projectPath?: string;
  }) => string | undefined;
  onStop: (session: DashboardCliSessionSummary) => void;
  onResume: (session: DashboardCliSessionSummary) => void;
  onAutoResume: (session: DashboardCliSessionSummary, enabled: boolean) => void;
  onQueue: (session: DashboardCliSessionSummary, enabled: boolean, priority?: number) => void;
  onRename: (name: string) => void;
  onFork: () => void;
  onCopyLink: () => void;
  onShare: () => void;
  onArchive: (session: DashboardCliSessionSummary) => void;
  onOpenInCodex: (session: DashboardCliSessionSummary) => void;
  onUnarchive: (session: DashboardCliSessionSummary) => void;
  onDelete: (session: DashboardCliSessionSummary) => void;
};

export function shouldShowLatestButton(scrollHeight: number, clientHeight: number, scrollTop: number, wasVisible = false): boolean {
  const overflow = scrollHeight - clientHeight;
  if (overflow <= 2) return false;
  const remaining = Math.max(0, overflow - Math.max(0, scrollTop));
  return remaining > (wasVisible ? 16 : 48);
}

function SessionRowMenu(props: {
  session: DashboardCliSessionSummary;
  running?: boolean;
  canResume?: boolean;
  autoResume?: boolean;
  disabled: boolean;
  onResume: () => void;
  onStop: () => void;
  onAutoResume: (enabled: boolean) => void;
  onQueue: (enabled: boolean, priority?: number) => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { session } = props;
  const close = (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => event.currentTarget.closest("details")?.removeAttribute("open");
  return <details class="cli-session-row-menu-wrap" onClick={(event) => event.stopPropagation()}>
    <summary class="cli-icon-button" aria-label={`Actions for ${session.title}`} title={`Actions for ${session.title}`}>
      <MoreIcon />
    </summary>
    <div class="cli-session-menu" role="menu" aria-label={`Actions for ${session.title}`}>
      {props.running ? <button type="button" role="menuitem" disabled={props.disabled} onClick={(event) => { close(event); props.onStop(); }}><StopIcon /> Stop</button> : props.canResume ? <button type="button" role="menuitem" title="Resume this interrupted conversation" disabled={props.disabled} onClick={(event) => { close(event); props.onResume(); }}><PlayIcon /> Start / Resume</button> : null}
      {showsCodexSessionAutoResume(session) ? <button type="button" role="menuitem" disabled={props.disabled} onClick={(event) => { close(event); props.onAutoResume(!props.autoResume); }}><AutoResumeIcon enabled={Boolean(props.autoResume)} goal={!!session.goal} /> {props.autoResume ? "Pause Auto Resume" : "Enable Auto Resume"}</button> : null}
      <button type="button" role="menuitem" disabled={props.disabled || props.running === true} onClick={(event) => { close(event); props.onQueue(!session.queueEnabled, session.queueEnabled ? undefined : 3); }}>{session.queueEnabled ? "Remove from queue" : "Queue session"}</button>
      <span aria-hidden="true" />
      {session.archived ? <button type="button" role="menuitem" disabled={props.disabled} onClick={(event) => { close(event); props.onRestore(); }}><RestoreIcon /> Restore</button> : <button type="button" role="menuitem" disabled={props.disabled || props.running === true} onClick={(event) => { close(event); props.onArchive(); }}><ArchiveIcon /> Archive</button>}
      <button type="button" role="menuitem" class="is-danger" disabled={props.disabled} onClick={(event) => { close(event); props.onDelete(); }}><TrashIcon /> Delete</button>
    </div>
  </details>;
}

export function CliSessionsPage(props: CliSessionsPageProps) {
  const [section, setSection] = useState<CliSessionSection>("active");
  const [search, setSearch] = useState("");

  const [attachmentReading, setAttachmentReading] = useState(false);
  const submittedDrafts = useRef(new Map<string, ComposerDraft & { key: string }>());
  const attachmentReadRef = useRef(false);
  const [projectPath, setProjectPath] = useState<string>();
  const [newChatProject, setNewChatProject] = useState<string>();
  const selectedDevice = props.selectedSession?.deviceId ?? props.selectedPeerId ?? props.peers?.find(peer => peer.local)?.id;
  const draftKey = cliComposerDraftKey(selectedDevice, props.selectedSession?.id, newChatProject ?? projectPath);
  const currentDraftKey = useRef(draftKey);
  currentDraftKey.current = draftKey;
  const [composerDrafts, setComposerDrafts] = useState<Record<string, ComposerDraft>>({});
  const composerDraftsRef = useRef(composerDrafts);
  composerDraftsRef.current = composerDrafts;
  const [draftReadyKeys, setDraftReadyKeys] = useState<Set<string>>(new Set());
  const loadedDraftKeys = useRef(new Set<string>());
  const scheduledDrafts = useRef(new Map<string, ComposerDraft>());
  const [draftStorageFailedKeys, setDraftStorageFailedKeys] = useState(new Set<string>());
  const [legacyDraft, setLegacyDraft] = useState<{ key: string; value: ComposerDraft }>();
  const dirtyDraftFields = useRef(new Map<string, Set<keyof ComposerDraft>>());
  const markDraftFields = (fields: Array<keyof ComposerDraft>): void => {
    const dirty = dirtyDraftFields.current.get(draftKey) ?? new Set<keyof ComposerDraft>();
    for (const field of fields) dirty.add(field);
    dirtyDraftFields.current.set(draftKey, dirty);
  };
  const settings = resolveCliComposerSettings(composerDrafts[draftKey], props.composerConfig);
  const { model, reasoningEffort, sandboxMode } = settings;
  const updateDraftSettings = (patch: Partial<ComposerDraft>) => {
    markDraftFields(Object.keys(patch) as Array<keyof ComposerDraft>);
    setComposerDrafts((current) => ({ ...current, [draftKey]: { ...(current[draftKey] ?? { text: "", attachments: EMPTY_CHAT_ATTACHMENTS }), ...patch } }));
  };
  const setModel = (value?: string) => updateDraftSettings({ model: value });
  const setReasoningEffort = (value?: string) => updateDraftSettings({ reasoningEffort: value });
  const setSandboxMode = (value: DashboardCliSandboxMode) => updateDraftSettings({ sandboxMode: value });
  const draft = composerDrafts[draftKey]?.text ?? "";
  const attachments = composerDrafts[draftKey]?.attachments ?? EMPTY_CHAT_ATTACHMENTS;
  const setDraft = (value: string | ((current: string) => string)): void => {
    markDraftFields(["text"]);
    setComposerDrafts((current) => {
      const previous = current[draftKey] ?? { text: "", attachments: EMPTY_CHAT_ATTACHMENTS };
      return { ...current, [draftKey]: { ...previous, text: typeof value === "function" ? value(previous.text) : value } };
    });
  };
  const setAttachments = (value: ChatAttachment[] | ((current: ChatAttachment[]) => ChatAttachment[])): void => {
    markDraftFields(["attachments"]);
    setComposerDrafts((current) => {
      const previous = current[draftKey] ?? { text: "", attachments: EMPTY_CHAT_ATTACHMENTS };
      return { ...current, [draftKey]: { ...previous, attachments: typeof value === "function" ? value(previous.attachments) : value } };
    });
  };
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [railCollapsed, setRailCollapsed] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const [sidebarToggleTarget, setSidebarToggleTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setSidebarToggleTarget(railCollapsed ? document.getElementById(props.dashboardMode ? props.taskBoardActive ? 'task-sidebar-toggle-slot' : 'dashboard-sidebar-toggle-slot' : 'session-sidebar-toggle-slot') : null);
  }, [railCollapsed, props.dashboardMode, props.taskBoardActive, props.selectedSession?.id]);

  const [contextCollapsed, setContextCollapsed] = useState(() => window.innerWidth < 1180);
  const toolsCollapsed = contextCollapsed || !props.selectedSession || props.dashboardMode === true;
  const [contextTabsByProject, setContextTabsByProject] = useState<Record<string, WorkspaceProjectState>>({});
  const submittedTerminalDrafts = useRef(new Map<string, { key: string; text: string }>());
  const submittedGitDrafts = useRef(new Map<string, { key: string; text?: string; kind: 'commit' | 'push' }>());
  const submittedFileDrafts = useRef(new Map<string, { key: string; path: string; text: string; revision: string }>());
  const [branchReview, setBranchReview] = useState(false);
  useEffect(() => setBranchReview(false), [props.selectedSession?.id, props.selectedSession?.deviceId]);
  const [contextAddOpen, setContextAddOpen] = useState(false);
  const [layout, setLayout] = useState(loadWorkspaceLayout);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<DashboardCliSessionSummary>();
  const reportLocalFeedback = props.onActionFeedback;
  const [shareOpen, setShareOpen] = useState(false);
  const messageViewportRef = useRef<HTMLElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const [showLatestButton, setShowLatestButton] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loadedDraftKeys.current.has(draftKey)) return;
    loadedDraftKeys.current.add(draftKey);
    void readCliComposerDraft(draftKey).then((saved) => {
      if (saved) setComposerDrafts((current) => {
        const edited = Object.fromEntries([...(dirtyDraftFields.current.get(draftKey) ?? [])].map((field) => [field, current[draftKey]?.[field]]));
        return { ...current, [draftKey]: { ...saved, ...edited } };
      });
      if (!saved) void readLegacyCliComposerDraft(draftKey).then(value => { if (currentDraftKey.current === draftKey && value && (value.text || value.attachments.length)) setLegacyDraft({key: draftKey, value}); });
      setDraftReadyKeys((current) => new Set([...current, draftKey]));
    });
  }, [draftKey]);
  useEffect(() => {
    for (const [key, value] of Object.entries(composerDrafts)) {
      if (!draftReadyKeys.has(key) || scheduledDrafts.current.get(key) === value) continue;
      scheduledDrafts.current.set(key, value);
      void writeCliComposerDraft(key, value).then((saved) => {
        setDraftStorageFailedKeys((current) => { const next = new Set(current); if (saved) next.delete(key); else next.add(key); return next; });
      });
    }
  }, [composerDrafts, draftReadyKeys]);
  useEffect(() => {
    for (const result of props.submissionResults ?? []) {
      const saved = submittedFileDrafts.current.get(result.requestId);
      if (saved) {
        submittedFileDrafts.current.delete(result.requestId);
        setContextTabsByProject(current => {
          const entry = current[saved.key];
          return entry ? { ...current, [saved.key]: { ...entry, fileNotice: { level: result.status === 'completed' ? 'info' : 'error', message: result.message ?? (result.status === 'completed' ? 'File saved.' : 'File save was not confirmed. Your draft was kept.') } } } : current;
        });
        if (result.status === 'completed' && result.fileRevision) setContextTabsByProject(current => {
          const entry = current[saved.key], draft = entry?.fileDrafts?.[saved.path];
          if (!entry || !draft || draft.revision !== saved.revision) return current;
          const fileDrafts = { ...entry.fileDrafts };
          if (draft.text === saved.text) delete fileDrafts[saved.path];
          else fileDrafts[saved.path] = { ...draft, revision: result.fileRevision! };
          return { ...current, [saved.key]: { ...entry, fileDrafts } };
        });
      }
      const git = submittedGitDrafts.current.get(result.requestId);
      if (git) {
        submittedGitDrafts.current.delete(result.requestId);
        setContextTabsByProject(current => {
          const entry = current[git.key];
          if (!entry || entry.gitPending?.requestId !== result.requestId) return current;
          return { ...current, [git.key]: { ...entry, gitPending: undefined,
            commitDraft: result.status === 'completed' && git.kind === 'commit' && entry.commitDraft?.trim() === git.text ? '' : entry.commitDraft,
            gitNotice: { level: result.status === 'completed' ? 'info' : result.status === 'cancelled' ? 'warning' : 'error', message: result.message ?? (result.status === 'completed' ? `${git.kind === 'commit' ? 'Commit' : 'Push'} completed.` : 'Git action was not confirmed. Your draft was kept; check the repository before retrying.') } } };
        });
      }
      const terminal = submittedTerminalDrafts.current.get(result.requestId);
      if (terminal) {
        submittedTerminalDrafts.current.delete(result.requestId);
        if (result.status === 'completed') setContextTabsByProject(current => {
          const entry = current[terminal.key];
          return entry?.draft?.trim() === terminal.text ? { ...current, [terminal.key]: { ...entry, draft: '' } } : current;
        });
      }
      const submitted = submittedDrafts.current.get(result.requestId);
      if (!submitted) continue;
      submittedDrafts.current.delete(result.requestId);
      setComposerDrafts((current) => {
        const draft = current[submitted.key];
        if (!draft) return current;
        return { ...current, [submitted.key]: result.status === "completed"
          ? acknowledgeCliComposerDraft(draft, submitted)
          : restoreFailedCliComposerDraft(draft, submitted) };
      });
    }
  }, [props.submissionResults]);

  const legacyDraftWarning = legacyDraft?.key === draftKey ? <span class="cli-draft-recovery" role="status"><small>Older draft · unverified system.</small><button type="button" onClick={() => { const value = legacyDraft.value; setComposerDrafts(current => { const edited = Object.fromEntries([...(dirtyDraftFields.current.get(draftKey) ?? [])].map(field => [field, current[draftKey]?.[field]])); return { ...current, [draftKey]: { ...value, ...edited } }; }); setLegacyDraft(undefined); }}>Restore here</button><button type="button" onClick={() => setLegacyDraft(undefined)}>Dismiss</button></span> : null;
  const draftStorageWarning = draftStorageFailedKeys.has(draftKey) ? <p class="cli-composer-unavailable" role="status">This draft is kept in this tab. Browser storage could not save it; copy it before closing or reloading. <button type="button" onClick={() => { const value = composerDrafts[draftKey]; if (value) void writeCliComposerDraft(draftKey, value).then((saved) => { if (saved) { setDraftStorageFailedKeys((current) => { const next = new Set(current); next.delete(draftKey); return next; }); } }); }}>Retry saving draft</button></p> : null;

  useEffect(() => {
    if (!props.composerConfig) return;
    setProjectPath((current) => current ?? props.composerConfig?.projects?.[0]?.path);
  }, [props.composerConfig]);

  useEffect(() => saveWorkspaceLayout(layout), [layout]);

  useEffect(() => {
    // A session deep link should open in its matching state tab, but returning
    // to the workspace list (including after archive/delete) must restore the
    // default Active view instead of leaving the rail on Archive.
    setSection(props.selectedSession?.archived ? "archived" : "active");
    setDeleteTarget(undefined);
  }, [props.selectedSession?.id, props.selectedSession?.archived]);

  useLayoutEffect(() => {
    followLatestRef.current = true;
    previousScrollTopRef.current = 0;
    setShowLatestButton(false);
    const viewport = messageViewportRef.current;
    const content = messagesContentRef.current;
    if (!viewport || !content || !props.selectedSession) return;
    let frame = 0;
    const reconcile = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (followLatestRef.current) {
          viewport.scrollTop = viewport.scrollHeight;
          previousScrollTopRef.current = viewport.scrollTop;
          setShowLatestButton(false);
        } else {
          setShowLatestButton((visible) => shouldShowLatestButton(viewport.scrollHeight, viewport.clientHeight, viewport.scrollTop, visible));
        }
      });
    };
    const observer = new ResizeObserver(reconcile);
    observer.observe(content);
    observer.observe(viewport);
    reconcile();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [props.selectedSession?.id]);
  useLayoutEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) return;
    if (followLatestRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      previousScrollTopRef.current = viewport.scrollTop;
      setShowLatestButton(false);
    } else {
      setShowLatestButton((visible) => shouldShowLatestButton(viewport.scrollHeight, viewport.clientHeight, viewport.scrollTop, visible));
    }
  }, [props.messages, props.sending, props.messagesLoading]);
  const updateMessageScrollState = (): void => {
    const viewport = messageViewportRef.current;
    if (!viewport) return;
    const currentTop = viewport.scrollTop;
    const remaining = Math.max(0, viewport.scrollHeight - currentTop - viewport.clientHeight);
    if (currentTop < previousScrollTopRef.current - 2 && remaining > 16) followLatestRef.current = false;
    else if (remaining <= 16) followLatestRef.current = true;
    previousScrollTopRef.current = currentTop;
    setShowLatestButton((visible) => !followLatestRef.current && shouldShowLatestButton(viewport.scrollHeight, viewport.clientHeight, currentTop, visible));
  };
  const scrollToLatest = (): void => {
    const viewport = messageViewportRef.current;
    if (!viewport) return;
    followLatestRef.current = true;
    viewport.scrollTop = viewport.scrollHeight;
    previousScrollTopRef.current = viewport.scrollTop;
    setShowLatestButton(false);
  };

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 1179px)");
    const apply = (): void => {
      if (compact.matches) setContextCollapsed(true);
    };
    apply();
    compact.addEventListener("change", apply);
    return () => {
      compact.removeEventListener("change", apply);
    };
  }, []);

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 760px)");
    const update = (): void => {
      setMobileLayout(mobile.matches);
      setRailCollapsed(mobile.matches);
    };
    mobile.addEventListener("change", update);
    return () => mobile.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    if (!mobileLayout || railCollapsed) return;
    const sidebar = sidebarRef.current;
    const dashboard = props.dashboardMode ? document.querySelector<HTMLElement>("#dashboard-main") : null;
    const previousInert = dashboard?.inert;
    if (dashboard) dashboard.inert = true;
    const frame = window.requestAnimationFrame(() => sidebar?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus());
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return;
      if ([...document.querySelectorAll<HTMLElement>('.overlay.open, [aria-modal="true"]:not(#cli-session-sidebar)')].some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setRailCollapsed(true);
      } else if (event.key === "Tab") {
        const controls = [...new Set([sidebarToggleRef.current, ...Array.from(sidebar?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]') ?? []), ...Array.from(document.querySelectorAll<HTMLElement>('.cli-account-menu button:not([disabled]), .cli-account-menu input, .cli-account-menu select, .cli-account-menu a[href]'))])]
          .filter((element): element is HTMLElement => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden"));
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      if (dashboard) dashboard.inert = previousInert ?? false;
      sidebarToggleRef.current?.focus();
    };
  }, [mobileLayout, railCollapsed, props.dashboardMode]);

  const sessionOrder = useRef(new Map<string, number>());
  const localPeerId = props.peers?.find((peer) => peer.local)?.id;
  const selectedSystem = props.selectedPeerId === "local" ? localPeerId : props.selectedPeerId;
  const orderedSessions = useMemo(() => {
    const sessions = reconcileCliSessionStatuses(props.sessions.filter(session =>
      selectedSystem && selectedSystem !== localPeerId ? session.deviceId === selectedSystem : !session.remote
    ), props.liveStates ?? {});
    return stabilizeCliSessionOrder(sessions, sessionOrder.current).sort((left, right) =>
      Number(isCodexSessionRunning(right)) - Number(isCodexSessionRunning(left))
    );
  }, [props.sessions, props.liveStates, selectedSystem, localPeerId]);
  const composerSystemKey = selectedSystem && selectedSystem !== localPeerId ? selectedSystem : "local";
  const composerSystem = useRef(composerSystemKey);
  useEffect(() => {
    if (composerSystem.current === composerSystemKey) return;
    composerSystem.current = composerSystemKey;
    setNewChatProject(undefined);
    setProjectPath(undefined);
  }, [composerSystemKey]);
  const activeSessions = filterCliSessionsBySection(orderedSessions, "active");
  const archivedSessions = filterCliSessionsBySection(orderedSessions, "archived");
  const runningCount = activeSessions.filter((session) => isCodexSessionRunning(session)).length;
  const [sessionLimits, setSessionLimits] = useState<Record<string,number>>({});
  useEffect(() => setSessionLimits({}), [selectedSystem, search, section, layout.sessionView]);
  const growSessions = (key: string) => setSessionLimits(current => ({...current,[key]:(current[key] ?? 50)+50}));
  const visibleSessions = useMemo(() => {
    const source = section === "active" ? activeSessions : archivedSessions;
    const query = search.trim().toLocaleLowerCase();
    return query
      ? source.filter((session) => `${session.title} ${session.id} ${session.projectPath ?? ""}`.toLocaleLowerCase().includes(query))
      : source;
  }, [activeSessions, archivedSessions, search, section]);
  const selectedModel = props.composerConfig?.models.find((option) => option.id === model);
  const reasoningOptions = selectedModel?.reasoningEfforts.length
    ? selectedModel.reasoningEfforts
    : ["low", "medium", "high", "xhigh"];
  const selectedArchived = props.selectedSession?.archived === true;
  const ownedLiveTurn = isCliLiveStateCurrent(props.selectedSession, props.liveState) && isCliTurnActive(props.liveState);
  const canSteer = Boolean(ownedLiveTurn && props.connected !== false && props.liveState?.status === "running" && props.liveState.turnId && props.onSteer);
  const composerBlockedByOwner = Boolean((isCodexSessionRunning(props.selectedSession)) && !props.sending && !ownedLiveTurn);
  const sessionAutoResume = props.autoResumeEnabled ? props.selectedSession?.autoResumeEnabled !== false : props.selectedSession?.autoResumeEnabled === true;
  const hasInProgressActivity = props.messages.some((message) => message.status === "inProgress");
  const projects = props.composerConfig?.projects ?? [];
  const composerProjects = useMemo(() => {
    const known = new Set(projects.map((project) => canonicalWebPath(project.path)));
    const extraPaths = [...orderedSessions.map(session => session.projectPath), props.selectedSession?.projectPath, newChatProject, projectPath]
      .filter((projectPath): projectPath is string => typeof projectPath === "string" && projectPath.length > 0 && !known.has(canonicalWebPath(projectPath)));
    const uniqueExtraPaths = extraPaths.filter((projectPath, index, all) => all.findIndex((candidate) => canonicalWebPath(candidate) === canonicalWebPath(projectPath)) === index);
    return [...projects, ...uniqueExtraPaths.map((projectPath) => ({
      id: `session-project:${projectPath}`,
      label: projectDisplayName(projectPath),
      path: projectPath
    }))];
  }, [projects, orderedSessions, props.selectedSession?.projectPath, newChatProject, projectPath]);
  const railFiles = useMemo(() => props.messages.flatMap((message) => message.changes ?? []).filter((change, index, all) => all.findIndex((item) => item.path === change.path) === index), [props.messages]);
  const railAgents = useMemo(() => props.messages.filter((message) => message.kind === "collaboration"), [props.messages]);
  const retryMessage = (id: string): void => {
    const prompt = getMessagePrompt(props.messages, id);
    if (prompt !== undefined) draftFromMessage(prompt, false);
    else reportLocalFeedback({ level: "warning", message: "No user prompt is available to retry." });
  };
  const currentTurnRunning = Boolean(props.sending || ownedLiveTurn || isCodexSessionRunning(props.selectedSession));
  const goal = useMemo(() => props.selectedSession?.goal !== undefined ? normalizeCodexSessionGoal(props.selectedSession.goal) : getSessionGoal(props.messages), [props.messages, props.selectedSession?.goal]);
  const turnChanges = useMemo(() => summarizeTurnChanges(props.messages, props.liveState?.turnId), [props.messages, props.liveState?.turnId]);
  const showWorking = currentTurnRunning && !hasInProgressActivity;
  const selectedProjectPath = props.selectedSession ? props.selectedSession.projectPath : newChatProject ?? projectPath;
  const toolProjectPath = selectedProjectPath;
  const contextProjectKey = JSON.stringify([props.selectedSession?.deviceId ?? props.selectedPeerId ?? 'local', canonicalWebPath(toolProjectPath ?? '__workspace__')]);
  const workspacePeer = props.peers?.find(peer => peer.id === (props.selectedSession?.deviceId ?? props.selectedPeerId)) ?? props.peers?.find(peer => peer.local);
  const workspaceSystemName = getSensitiveDisplayValue(props.selectedSession?.deviceName ?? workspacePeer?.name ?? (props.selectedSession?.remote ? 'Remote PC' : 'This PC'), props.privacyMode, 'name');
  const contextProjectState = contextTabsByProject[contextProjectKey] ?? emptyWorkspaceProject();
  useLayoutEffect(() => {
    if (props.dashboardMode || props.taskBoardActive) return;
    props.onWorkspaceContextChange?.(contextProjectKey);
    if (toolsCollapsed || !props.selectedSession) return;
    const kind = workspaceTabKind(contextProjectState.active), path = workspaceTabPath(contextProjectState.active);
    if (kind === 'files') { props.onListFiles(toolProjectPath); if (path) props.onReadFile(path, toolProjectPath); }
    else if (toolProjectPath && (kind === 'env' || kind === 'git')) props.onRefreshEnvironment(toolProjectPath);
  }, [contextProjectKey, props.dashboardMode, props.taskBoardActive, props.selectedSession?.id, toolsCollapsed]);
  const currentWorkspaceData = !props.workspaceScopeKey || props.workspaceScopeKey === contextProjectKey;
  const contextTabs = contextProjectState.tabs;
  const activeContextTab = contextProjectState.active;
  const terminalDraft = contextProjectState.draft ?? '';
  const setTerminalDraft = (draft: string): void => setContextTabsByProject(current => ({ ...current, [contextProjectKey]: { ...(current[contextProjectKey] ?? emptyWorkspaceProject()), draft } }));
  useEffect(() => { setContextAddOpen(false); }, [contextProjectKey]);
  useLayoutEffect(() => {
    if (toolsCollapsed) return;
    const root = workspaceRef.current, header = root?.querySelector<HTMLElement>('.cli-conversation-header');
    const place = () => root?.style.setProperty('--cli-tools-top', `${header?.getBoundingClientRect().bottom ?? 44}px`);
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    if (header) observer?.observe(header);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || contextAddOpen || [...document.querySelectorAll<HTMLElement>('[aria-modal="true"], .overlay.open')].some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible') || !root?.querySelector('.cli-terminal-panel')?.contains(document.activeElement)) return;
      event.preventDefault(); setContextCollapsed(true); root.querySelector<HTMLButtonElement>('.cli-inspector-toggle')?.focus();
    };
    window.addEventListener('keydown', escape);
    return () => { observer?.disconnect(); window.removeEventListener('keydown', escape); };
  }, [toolsCollapsed, contextAddOpen, props.selectedSession?.id]);
  const setContextTabs = (next: WorkspaceTab[] | ((current: WorkspaceTab[]) => WorkspaceTab[])): void => {
    setContextTabsByProject(current => {
      const entry = current[contextProjectKey] ?? emptyWorkspaceProject();
      const tabs = typeof next === "function" ? next(entry.tabs) : next;
      return { ...current, [contextProjectKey]: { ...entry, tabs } };
    });
  };
  const setActiveContextTab = (next: WorkspaceTab | ((current: WorkspaceTab) => WorkspaceTab)): void => {
    setContextTabsByProject(current => {
      const entry = current[contextProjectKey] ?? emptyWorkspaceProject();
      return { ...current, [contextProjectKey]: { ...entry, active: typeof next === "function" ? next(entry.active) : next } };
    });
  };
  const setCommitDraft = (commitDraft: string): void => setContextTabsByProject(current => ({ ...current, [contextProjectKey]: { ...(current[contextProjectKey] ?? emptyWorkspaceProject()), commitDraft } }));
  const editFileDraft = (path: string, text: string): void => setContextTabsByProject(current => {
    const entry = current[contextProjectKey] ?? emptyWorkspaceProject(), previous = entry.fileDrafts?.[path], file = props.workspaceFilesByPath[path];
    return { ...current, [contextProjectKey]: { ...entry, fileDrafts: { ...entry.fileDrafts, [path]: { text, revision: previous && previous.text !== file?.content ? previous.revision : file?.revision ?? '' } } } };
  });
  const runGitAction = (kind: 'commit' | 'push'): void => {
    if (props.connected === false || [...submittedGitDrafts.current.values()].some(item => item.key === contextProjectKey)) return;
    const text = contextProjectState.commitDraft?.trim();
    const requestId = kind === 'commit' ? text ? props.onCommitWorkspace(text, toolProjectPath) : undefined : props.onPushWorkspace(toolProjectPath);
    if (requestId) submittedGitDrafts.current.set(requestId, { key: contextProjectKey, kind, text });
    setContextTabsByProject(current => ({ ...current, [contextProjectKey]: { ...(current[contextProjectKey] ?? emptyWorkspaceProject()),
      gitPending: requestId ? { requestId, kind } : undefined,
      gitNotice: requestId ? undefined : { level: 'error', message: 'Git action was not sent. Your draft was kept.' } } }));
  };
  const startNewChat = (nextProject?: string): void => {
    if (mobileLayout) setRailCollapsed(true);
    if (props.selectedSession) props.onPeerChange?.(props.selectedSession.deviceId ?? localPeerId ?? "local");
    props.onBackToList();
    const preferred = nextProject ?? props.selectedSession?.projectPath ?? newChatProject ?? projectPath;
    const selected = composerProjects.find((project) => preferred && canonicalWebPath(project.path) === canonicalWebPath(preferred))?.path ?? preferred ?? projects[0]?.path ?? "";
    setNewChatProject(selected);
    setProjectPath(selected);
  };
  const pcGroups = useMemo(() => {
    const localPeer = props.peers?.find((peer) => peer.local);
    const visibleKeys = new Set(visibleSessions.map((session) => `${session.deviceId ?? "local"}:${session.id}`));
    const groups = new Map<string, { id: string; name: string; local: boolean; connected: boolean; sessions: DashboardCliSessionSummary[]; allSessions: DashboardCliSessionSummary[] }>();
    for (const peer of props.peers ?? []) {
      groups.set(peer.id, {
        id: peer.id,
        name: peer.name.trim() || (peer.local ? "This PC" : "Remote PC"),
        local: Boolean(peer.local),
        connected: peer.connected,
        sessions: [],
        allSessions: []
      });
    }
    for (const session of [...filterCliSessionsBySection(orderedSessions, "active"), ...filterCliSessionsBySection(orderedSessions, "archived")]) {
      const id = session.deviceId ?? localPeer?.id ?? "local";
      const existing = groups.get(id);
      if (existing) {
        existing.allSessions.push(session);
        if (visibleKeys.has(`${session.deviceId ?? "local"}:${session.id}`)) existing.sessions.push(session);
      }
      else groups.set(id, {
        id,
        name: session.deviceName?.trim() || (session.remote ? "Remote PC" : "This PC"),
        local: !session.remote,
        connected: true,
        sessions: visibleKeys.has(`${session.deviceId ?? "local"}:${session.id}`) ? [session] : [],
        allSessions: [session]
      });
    }
    if (groups.size === 0) groups.set("local", { id: "local", name: "This PC", local: true, connected: true, sessions: [], allSessions: [] });
    return [...groups.values()].filter(group => selectedSystem ? group.id === selectedSystem : group.local);
  }, [props.peers, orderedSessions, visibleSessions, selectedSystem]);
  const toggleGroup = (id: string, defaultCollapsed = false): void => {
    setCollapsedGroups((current) => ({ ...current, [id]: !(current[id] ?? defaultCollapsed) }));
  };
  const selectContextTab = (tab: WorkspaceTab): void => {
    setActiveContextTab(tab);
    if (toolProjectPath && (tab === 'env' || tab === 'git')) props.onRefreshEnvironment(toolProjectPath);
    const filePath = workspaceTabPath(tab);
    if (workspaceTabKind(tab) === "agents" && filePath) {
      const agent = props.sessions.find((session) => session.id === filePath && (session.deviceId ?? "local") === (props.selectedSession?.deviceId ?? "local") && readSubAgentMetadata(session).subAgent);
      if (agent) props.onReadAgent?.(agent);
    }
    if (workspaceTabKind(tab) === "files") {
      props.onListFiles(toolProjectPath);
      if (filePath) props.onReadFile(filePath, toolProjectPath);
    }
  };
  const openContextTab = (tab: WorkspaceToolTab, filePath?: string): void => {
    if (tab === "reviews") setBranchReview(false);
    const resolvedFilePath = filePath && tab === "files" ? workspaceRelativePath(filePath, toolProjectPath) : filePath;
    const tabId: WorkspaceTab = resolvedFilePath ? `${tab === "agents" ? "agent" : tab === "files" ? "file" : "review"}:${resolvedFilePath}` : tab;
    setContextTabs((current) => {
      const withBase = current.includes(tab) ? current : [...current, tab];
      return withBase.includes(tabId) ? withBase : [...withBase, tabId];
    });
    selectContextTab(tabId);
    setContextCollapsed(false);
    setContextAddOpen(false);
  };
  const renderSession = (session: DashboardCliSessionSummary, grouped = false): preact.ComponentChildren => session.archived ? (
    <div role="listitem" class={`cli-session-row is-archived ${grouped ? "is-grouped" : ""}`} key={`${session.deviceId ?? "local"}:${session.id}`}>
        <span class="cli-session-row-main has-project"><strong title={session.title}>{session.title}</strong>{grouped ? <time class="cli-session-row-time" title={session.updatedAt}>{relativeTime(session.updatedAt)}</time> : <small class="cli-session-row-meta"><span>{sessionMeta(session)}</span><span>{relativeTime(session.updatedAt)}</span></small>}</span>
      <span class="cli-session-row-status" aria-label="Archived"><SessionRowMenu session={session} disabled={props.mutating} onResume={() => undefined} onStop={() => undefined} onAutoResume={() => undefined} onQueue={() => undefined} onArchive={() => undefined} onRestore={() => props.onUnarchive(session)} onDelete={() => setDeleteTarget(session)} /></span>
    </div>
  ) : (
    (() => {
      const running = isCodexSessionRunning(session);
      const canResume = !running && session.interrupted === true && !session.goal && !session.subAgent && !session.parentSessionId;
      const autoResume = props.autoResumeEnabled ? session.autoResumeEnabled !== false : session.autoResumeEnabled === true;
      return <div role="listitem" draggable class={`cli-session-row ${grouped ? "is-grouped" : ""} ${running ? "is-running" : ""} ${props.selectedSession?.id === session.id && props.selectedSession?.deviceId === session.deviceId ? "is-selected" : ""}`} key={`${session.deviceId ?? "local"}:${session.id}`} onDragStart={(event) => { event.dataTransfer?.setData("application/x-codex-session", JSON.stringify({ id: session.id, deviceId: session.deviceId })); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; }}>
      <button type="button" class="cli-session-row-select" onClick={() => { if (mobileLayout) setRailCollapsed(true); setNewChatProject(undefined); setProjectPath(session.projectPath); props.onPeerChange?.(session.deviceId ?? localPeerId ?? "local"); props.onSelect(session); }}>
        <span class="cli-session-row-main has-project"><strong title={session.title}>{session.title}</strong>{grouped ? <time class="cli-session-row-time" title={session.updatedAt}>{relativeTime(session.updatedAt)}</time> : <small class="cli-session-row-meta"><span>{sessionMeta(session)}</span><span>{relativeTime(session.updatedAt)}</span></small>}</span>
      </button>
      <span class="cli-session-row-status" title={running ? (session.status === "unknown" ? session.statusError ?? "Running state unavailable" : "Running") : undefined} aria-label={running ? (session.status === "unknown" ? "Running state unavailable" : "Running") : undefined}>
        {running ? (session.status === "unknown" ? <ShieldIcon /> : <span class="cli-session-spinner" aria-hidden="true" />) : null}
        <SessionRowMenu session={session} running={running} canResume={canResume} autoResume={autoResume} disabled={props.mutating || props.connected === false} onResume={() => props.onResume(session)} onStop={() => props.onStop(session)} onAutoResume={(enabled) => props.onAutoResume(session, enabled)} onQueue={(enabled, priority) => props.onQueue(session, enabled, priority)} onArchive={() => props.onArchive(session)} onRestore={() => props.onUnarchive(session)} onDelete={() => setDeleteTarget(session)} />
      </span>
      </div>;
    })()
  );
  const returnToSessionList = (): void => {
    setNewChatProject(undefined);
    props.onBackToList();
  };

  const submit = (): void => {
    if ((currentTurnRunning && !canSteer) || props.steering || props.starting || attachmentReading || props.connected === false || !draftReadyKeys.has(draftKey)) return;
    const text = draft.trim();
    if (!text && !attachments.length) {
      reportLocalFeedback({ level: "warning", message: "Write a message before sending it to Codex." });
      return;
    }
    try { prepareChatInput(text, attachments); }
    catch (error) { reportLocalFeedback({ level: "error", message: error instanceof Error ? error.message : String(error) }); return; }
    let requestId: string | undefined;
    if (!props.selectedSession) {
      requestId = props.onStart({ text, attachments, model, reasoningEffort, sandboxMode, projectPath: newChatProject ?? projectPath });
    } else if (canSteer && props.liveState?.turnId) {
      requestId = props.onSteer?.({ text, attachments, expectedTurnId: props.liveState.turnId });
    } else {
      requestId = props.onSend({ text, attachments, model, reasoningEffort, sandboxMode, projectPath: props.selectedSession.projectPath ?? projectPath });
    }
    if (!requestId) { reportLocalFeedback({ level: "warning", message: "Your message was not sent. The draft is saved; reconnect or wait for the current request before trying again." }); return; }
    const submitted = { ...composerDrafts[draftKey]!, key: draftKey, text: draft, attachments };
    submittedDrafts.current.set(requestId, submitted);
    // Keep the submitted draft durable until the host confirms completion.
    reportLocalFeedback({ level: "info", message: canSteer ? "Sending your follow-up to the running turn…" : props.selectedSession ? "Codex is working on your request…" : "Starting a new Codex chat…" });
  };
  const addAttachments = async (files: File[]): Promise<void> => {
    if (attachmentReadRef.current || props.starting) return;
    if (!files.length) return;
    attachmentReadRef.current = true;
    setAttachmentReading(true);
    try {
      const added = await readChatAttachmentFiles(files, attachments.length);
      const currentAttachments = composerDraftsRef.current[draftKey]?.attachments ?? EMPTY_CHAT_ATTACHMENTS;
      const combined = validateChatAttachments([...currentAttachments, ...added.filter((file) => !currentAttachments.some((item) => item.name === file.name && item.data === file.data))]);
      setAttachments(combined);
      if (currentDraftKey.current !== draftKey) reportLocalFeedback({ level: "warning", message: "Attachments saved in the previous chat draft. Return there to use them." });
    } catch (error) { reportLocalFeedback({ level: "error", message: error instanceof Error ? error.message : String(error) }); }
    finally { attachmentReadRef.current = false; setAttachmentReading(false); }
  };
  const draftFromMessage = (text: string, quote: boolean): void => {
    setDraft((current) => quote ? `${current}${current ? "\n\n" : ""}${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : text);
    reportLocalFeedback({ level: "info", message: quote ? "Message quoted in your draft." : "Message added to your draft. Review it and send as a new turn." });
    window.requestAnimationFrame(() => workspaceRef.current?.querySelector<HTMLTextAreaElement>('textarea[name="codex-message"]')?.focus());
  };
  const beginPanelResize = (
    panel: "rail" | "terminal",
    event: JSX.TargetedPointerEvent<HTMLDivElement>
  ): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startValue = panel === "rail" ? layout.railWidth : layout.terminalWidth;
    const onMove = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientX - startX;
      setLayout((current) => panel === "rail"
        ? { ...current, railWidth: clamp(startValue + delta, 200) }
        : { ...current, terminalWidth: clamp(startValue - delta, 280) });
    };
    const onUp = (): void => {
      document.body.classList.remove("is-resizing-workspace");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    document.body.classList.add("is-resizing-workspace");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };
  const adjustPanelWithKeyboard = (panel: "rail" | "terminal", key: string, large: boolean): void => {
    if (key !== "ArrowLeft" && key !== "ArrowRight") return;
    const direction = key === "ArrowRight" ? 1 : -1;
    const step = large ? 40 : 10;
    setLayout((current) => panel === "rail"
      ? { ...current, railWidth: clamp(current.railWidth + direction * step, 200) }
      : { ...current, terminalWidth: clamp(current.terminalWidth - direction * step, 280) });
  };
  const beginComposerResize = (event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = layout.composerHeight;
    const onMove = (moveEvent: PointerEvent): void => {
      setLayout((current) => ({ ...current, composerHeight: clamp(startHeight - (moveEvent.clientY - startY), 120) }));
    };
    const onUp = (): void => {
      document.body.classList.remove("is-resizing-workspace");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    document.body.classList.add("is-resizing-workspace");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };
  const adjustComposerWithKeyboard = (key: string, large: boolean): void => {
    if (key !== "ArrowUp" && key !== "ArrowDown") return;
    const step = large ? 40 : 10;
    setLayout((current) => ({
      ...current,
      composerHeight: clamp(current.composerHeight + (key === "ArrowUp" ? step : -step), 120)
    }));
  };

  useEffect(() => {
    if (props.dashboardMode) {
      setRailCollapsed(window.matchMedia("(max-width: 760px)").matches);
      setContextCollapsed(true);
      return;
    }
    if (window.matchMedia("(max-width: 760px)").matches && props.selectedSession) setRailCollapsed(true);
    if (newChatProject !== undefined) {
      setContextCollapsed(true);
      return;
    }
    if (props.selectedSession && window.innerWidth >= 1180) setContextCollapsed(false);
  }, [newChatProject, props.dashboardMode, props.selectedSession?.id]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--cli-shell-rail-width", railCollapsed ? "0px" : `${layout.railWidth}px`);
    root.style.setProperty("--cli-shell-terminal-width", toolsCollapsed ? "0px" : `${layout.terminalWidth}px`);
    root.style.setProperty("--cli-shell-divider-width", "5px");
    return () => {
      root.style.removeProperty("--cli-shell-rail-width");
      root.style.removeProperty("--cli-shell-terminal-width");
      root.style.removeProperty("--cli-shell-divider-width");
    };
  }, [toolsCollapsed, layout.railWidth, layout.terminalWidth, railCollapsed]);

  const sidebarToggle = <button ref={sidebarToggleRef} type="button" class="cli-rail-toggle" aria-expanded={!railCollapsed} aria-controls="cli-session-sidebar" aria-label={railCollapsed ? "Show sessions sidebar" : "Hide sessions sidebar"} title={railCollapsed ? "Show sessions sidebar" : "Hide sessions sidebar"} onClick={() => setRailCollapsed((collapsed) => !collapsed)}>{railCollapsed ? props.logoUri ? <img src={props.logoUri} alt="" aria-hidden="true" /> : <CodexSessionIcon /> : <SidebarIcon />}</button>;
  return (
    <div
      ref={workspaceRef}
      class={`cli-workspace ${props.dashboardMode ? "is-dashboard-mode" : ""} ${railCollapsed ? "is-rail-collapsed" : ""} ${toolsCollapsed ? "is-terminal-collapsed" : ""}`}
      style={`--cli-rail-width:${layout.railWidth}px;--cli-terminal-width:${layout.terminalWidth}px;--cli-composer-height:${layout.composerHeight}px`}
    >
      {railCollapsed && sidebarToggleTarget ? createPortal(sidebarToggle, sidebarToggleTarget) : null}
      {mobileLayout && !toolsCollapsed && railCollapsed ? <button type="button" class="cli-tools-backdrop" aria-label="Close workspace tools" tabIndex={-1} onClick={() => setContextCollapsed(true)} /> : null}
      {mobileLayout && !railCollapsed ? <button type="button" class="cli-sidebar-backdrop" aria-label="Close sessions sidebar" tabIndex={-1} onClick={() => setRailCollapsed(true)} /> : null}
      <div class={`cli-workspace-grid ${props.selectedSession ? "has-context" : ""}`}>
        <aside ref={sidebarRef} id="cli-session-sidebar" class={`cli-session-rail ${props.selectedSession ? "has-selection" : ""}`} role={mobileLayout ? "dialog" : undefined} aria-modal={mobileLayout && !railCollapsed || undefined} aria-hidden={railCollapsed || undefined} inert={railCollapsed || undefined} aria-label="Codex sessions">
          <div class="cli-rail-header">{!railCollapsed ? sidebarToggle : null}
            <button type="button" class="cli-rail-brand" aria-label="Open dashboard" title="Open dashboard" onClick={() => { if (mobileLayout) setRailCollapsed(true); props.onDashboard(); }}>{props.logoUri ? <img src={props.logoUri} alt="" aria-hidden="true" /> : <span class="cli-brand-mark"><CodexSessionIcon /></span>}<strong>Codex</strong></button>
            {props.browser ? <label class="cli-rail-system" title="Switch system"><span aria-hidden="true"><Icon><rect x="3" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 16v4m-4 0h8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></Icon></span><select aria-label="System" value={props.selectedPeerId ?? localPeerId ?? 'local'} onChange={event => props.onPeerChange?.(event.currentTarget.value)}>{props.peers?.length ? props.peers.map(peer => <option key={peer.id} value={peer.id}>{getSensitiveDisplayValue(peer.name, props.privacyMode, 'name')}{peer.connected ? '' : ' · Offline'}</option>) : <option value="local">This PC</option>}</select>{(props.peers?.length ?? 0) > 1 ? <span class="cli-system-count" aria-label={`${props.peers!.length} systems`}>{props.peers!.length}</span> : null}</label> : null}
          </div>
            <nav class="cli-primary-nav" aria-label="Workspace navigation">
              <div class="cli-sidebar-toolbar">
                <button type="button" class="cli-dashboard-nav" aria-current={props.dashboardMode && !props.taskBoardActive ? 'page' : undefined} title="Dashboard" aria-label="Dashboard" onClick={() => { if (mobileLayout) setRailCollapsed(true); props.onDashboard(); }}><DashboardIcon /><span>Dashboard</span></button>
                <button type="button" class="cli-dashboard-nav cli-workspace-nav" aria-current={props.selectedSession ? "page" : undefined} onClick={() => { if (mobileLayout) setRailCollapsed(true); returnToSessionList(); }} title="Open workspace"><SidebarIcon /><span>Workspace</span></button>
                {props.taskBoardEnabled ? <button type="button" class="cli-dashboard-nav cli-task-nav" aria-current={props.taskBoardActive ? 'page' : undefined} onClick={() => props.onTasks?.()} title="Project task board"><TaskActivityIcon /><span>Kanban</span></button> : null}
                <div class="cli-sidebar-actions" role="group" aria-label="Session list controls"><button type="button" class="cli-icon-button cli-new-chat-icon" aria-label="New chat" title="New chat" onClick={() => startNewChat()}><PlusIcon /></button><IconButton label={props.loading ? "Refreshing sessions" : "Refresh sessions"} disabled={props.loading} onClick={props.onRefresh}><RefreshIcon /></IconButton><button type="button" class={`cli-icon-button cli-session-section-toggle ${section === "archived" ? "is-active" : ""}`} aria-pressed={section === "archived"} aria-label={section === "active" ? `Show archived sessions (${archivedSessions.length})` : `Show active sessions (${activeSessions.length})`} title={section === "active" ? `Show archived sessions (${archivedSessions.length})` : `Show active sessions (${activeSessions.length})`} onClick={() => setSection((current) => current === "active" ? "archived" : "active")}><ArchiveIcon /></button><button type="button" class="cli-icon-button cli-session-view-toggle" aria-pressed={layout.sessionView === "compact"} aria-label={layout.sessionView === "projects" ? "Show compact session list" : "Show projects and sessions"} title={layout.sessionView === "projects" ? "Show compact session list" : "Show projects and sessions"} onClick={() => setLayout((current) => ({ ...current, sessionView: current.sessionView === "projects" ? "compact" : "projects" }))}>{layout.sessionView === "projects" ? <SessionListIcon /> : <EmptyFolderIcon />}</button></div>
              </div>
            </nav>
          <div class="cli-session-filters">
            <div class="cli-session-search-line"><div class="cli-session-search-wrap"><SearchIcon /><input class="cli-session-search" name="session-search" type="search" autoComplete="off" value={search} placeholder="Search sessions…" aria-label="Search sessions" onInput={(event) => setSearch(event.currentTarget.value)} /></div></div>

          </div>

          <div class="cli-session-list-region">
          {layout.sessionView === "compact" || Boolean(search.trim()) ? <div class="cli-compact-session-list" role="list" aria-label="Sessions">{visibleSessions.slice(0,sessionLimits['compact'] ?? 50).map(session => renderSession(session))}<ScrollMore remaining={visibleSessions.length-(sessionLimits['compact'] ?? 50)} onMore={() => growSessions('compact')} /></div> : <div class="cli-project-list cli-pc-project-list is-dense-tree" aria-label="Projects and sessions">
            {pcGroups.map((pc) => {
              const knownProjectPaths = new Set((pc.local ? projects : []).map((project) => canonicalWebPath(project.path)));
              const sessionProjects = [...new Map(pc.allSessions
                .filter((session) => session.projectPath && !knownProjectPaths.has(canonicalWebPath(session.projectPath)))
                .map((session) => [canonicalWebPath(session.projectPath!), {
                  id: `${pc.id}:${canonicalWebPath(session.projectPath!)}`,
                  label: projectDisplayName(session.projectPath!),
                  path: session.projectPath!
                }])).values()];
              const pcProjects = [...new Map((pc.local ? [...projects, ...sessionProjects] : sessionProjects).map((project) => [canonicalWebPath(project.path), project])).values()];
              const assigned = new Set<string>();
              const projectGroups = pcProjects.map((project) => {
                const sessions = pc.sessions.filter((session) => {
                  const projectPath = session.projectPath;
                  const matches = Boolean(projectPath && project.path && canonicalWebPath(projectPath) === canonicalWebPath(project.path));
                  if (matches) assigned.add(session.id);
                  return matches;
                });
                return { project, sessions };
              }).filter(({ sessions }) => sessions.length > 0);
              const unassigned = pc.sessions.filter((session) => !assigned.has(session.id));
               if (unassigned.length > 0) projectGroups.unshift({ project: { id: `${pc.id}:recents`, label: "Recent", path: "" }, sessions: unassigned });
               return <section class="cli-pc-group" key={pc.id}>
                <div class="cli-pc-group-children">
                  {projectGroups.map(({ project, sessions }) => {
                    const groupId = `project:${pc.id}:${project.id}`;
                    const projectCollapsed = collapsedGroups[groupId] ?? true;
                    const runningSessions = sessions.filter((session) => !session.archived && session.status === "running").length;
                    return <section class="cli-project-group" key={groupId}>
                       <div class={`cli-project-row ${newChatProject === project.path ? "is-selected" : ""}`}>
                         <button type="button" class="cli-project-select" aria-label={`${projectCollapsed ? "Expand" : "Collapse"} ${project.label}`} title={project.path || undefined} aria-expanded={!projectCollapsed} onClick={() => toggleGroup(groupId, true)}>
                           <EmptyFolderIcon /><span><strong>{project.label}</strong></span><small class={`cli-project-count ${runningSessions ? "cli-project-running" : ""}`} aria-label={`${runningSessions} running / ${sessions.length} total sessions`} title={`${runningSessions} running / ${sessions.length} total sessions`}>{runningSessions ? <><span class="cli-session-spinner" aria-hidden="true" />{runningSessions} / {sessions.length}</> : sessions.length}</small><span class="cli-project-fold" aria-hidden="true"><ChevronIcon /></span>
                         </button>
                      </div>
                      {!projectCollapsed ? <div class="cli-project-sessions" role="list">{sessions.slice(0,sessionLimits[groupId] ?? 50).map(session => renderSession(session, true))}<ScrollMore remaining={sessions.length-(sessionLimits[groupId] ?? 50)} onMore={() => growSessions(groupId)} /></div> : null}
                    </section>;
                  })}
                </div>
              </section>;
            })}
          </div>}
          {props.loading && props.sessions.length === 0 ? <SessionRailSkeleton /> : null}
          {props.error ? <InlineError text={props.error} retry={props.onRefresh} /> : null}
          {!props.loading && !props.error && visibleSessions.length === 0 ? <EmptySessions search={Boolean(search)} section={section} /> : null}
          {deleteTarget && deleteTarget.archived ? <DeleteConfirmation compact title={deleteTarget.title} onCancel={() => { setDeleteTarget(undefined); reportLocalFeedback({ level: "info", message: "Session deletion cancelled." }); }} onDelete={() => { const target = deleteTarget; setDeleteTarget(undefined); props.onDelete(target); }} /> : null}

          </div>
          <SessionAccountFooter
            onApi={props.onApi}
            account={props.account}
            privacyMode={props.privacyMode}
            showLogout={props.showLogout}
            accounts={props.selectedPeerId && props.selectedPeerId !== localPeerId ? (props.peerAccounts?.[props.selectedPeerId] ?? []) : undefined}
            localAccounts={props.localAccounts}
            peers={props.peers}
            peerAccounts={props.peerAccounts}
            selectedPeerId={props.selectedPeerId}
            onPeerChange={props.onPeerChange}
            switching={props.switchingAccount}
            onDashboard={() => { if (mobileLayout) setRailCollapsed(true); props.onDashboard(); }}
            onSettings={() => { if (mobileLayout) setRailCollapsed(true); props.onSettings(); }}
            onSwitchAccount={(peerId, accountId) => { if (mobileLayout) setRailCollapsed(true); props.onSwitchAccount(peerId, accountId); }}
          />
        </aside>
        <PanelResizeHandle
          label="Resize sessions sidebar"
          value={layout.railWidth}
          minimum={200}
          onPointerDown={(event) => beginPanelResize("rail", event)}
          onKeyDown={(event) => adjustPanelWithKeyboard("rail", event.key, event.shiftKey)}
          onReset={() => setLayout((current) => ({ ...current, railWidth: DEFAULT_WORKSPACE_LAYOUT.railWidth }))}
        />

        <main
          class={`cli-conversation ${props.selectedSession ? "has-session" : newChatProject !== undefined ? "has-new-chat" : ""}`}
          aria-hidden={props.dashboardMode || undefined}
          inert={props.dashboardMode || (mobileLayout && !railCollapsed) || undefined}
        >
          {!props.selectedSession ? <header class="cli-content-toolbar"><span id="session-sidebar-toggle-slot" class="content-sidebar-slot" /></header> : null}
          {props.selectedSession ? (
            <>
              <ConversationHeader
                session={props.selectedSession}
                archived={selectedArchived}
                busy={props.mutating}
                sending={props.sending}
                onBack={returnToSessionList}
                onRefresh={props.onRefreshMessages}
                onRename={props.onRename}
                onFork={props.onFork}
                onOpenInCodex={() => props.onOpenInCodex(props.selectedSession!)}
                onCopyLink={props.onCopyLink}
                onShare={() => setShareOpen(true)}
                onArchive={() => props.onArchive(props.selectedSession!)}
                onRestore={() => props.onUnarchive(props.selectedSession!)}
                onDelete={() => setDeleteTarget(props.selectedSession)}
                onRenameCancelled={() => reportLocalFeedback({ level: "info", message: "Rename cancelled." })}
                terminalCollapsed={toolsCollapsed}
                onToggleTerminal={() => { setContextCollapsed(current => !current); setContextAddOpen(false); }}
              />
              {deleteTarget && !deleteTarget.archived ? <DeleteConfirmation title={deleteTarget.title} onCancel={() => { setDeleteTarget(undefined); reportLocalFeedback({ level: "info", message: "Session deletion cancelled." }); }} onDelete={() => { const target = deleteTarget; setDeleteTarget(undefined); props.onDelete(target); }} /> : null}
              <div class="cli-message-region"><section ref={messageViewportRef} class="cli-message-viewport" aria-live="polite" aria-busy={props.messagesLoading} onScroll={updateMessageScrollState}>
                {props.messagesLoading && props.messages.length === 0 ? <MessageSkeleton /> : null}
                {props.messagesError ? <InlineError text={props.messagesError} retry={props.onRefreshMessages} /> : null}
                {!props.messagesLoading && !props.messagesError && props.messages.length === 0 ? <ConversationEmpty archived={selectedArchived} logoUri={props.logoUri} /> : null}
                <div ref={messagesContentRef} class="cli-session-messages" onPointerDownCapture={(event) => { if ((event.target as Element).closest("summary,button,img")) followLatestRef.current = false; }} onClick={(event) => { if ((event.target as Element).closest("summary,button,img")) followLatestRef.current = false; }}>
                  <SessionTranscript messages={props.messages} running={currentTurnRunning} logoUri={props.logoUri} onActionFeedback={reportLocalFeedback} onRetryPrompt={!props.sending && !currentTurnRunning && !props.selectedSession?.archived ? retryMessage : undefined} onDraftMessage={!props.sending && !currentTurnRunning && !props.selectedSession?.archived ? draftFromMessage : undefined} onOpenFile={filePath => openContextTab('files', filePath)} onOpenReviews={filePath => openContextTab('reviews', filePath)} />
                  {showWorking ? <WorkingMessage /> : null}
                  <LiveTurnDetails state={props.liveState} loading={props.messagesLoading} onLoadHistory={props.onRefreshMessages} />
                  <div />
                </div>
              </section>
              {showLatestButton ? <button type="button" class="cli-scroll-latest" aria-label="Scroll to latest message" title="Scroll to latest message" onClick={scrollToLatest}><ChevronIcon /></button> : null}</div>
              {turnChanges ? <div class="cli-turn-change-bar" role="group" aria-label="Turn changes"><span>{turnChanges.files} file{turnChanges.files === 1 ? "" : "s"} changed <b class="is-added">+{turnChanges.additions}</b> <b class="is-removed">−{turnChanges.deletions}</b></span><button type="button" onClick={() => openContextTab("reviews")}>View changes</button></div> : null}

              {draftStorageWarning}
              {goal ? <details class={"cli-goal-strip is-" + goal.status}><summary><span class="cli-goal-mark" aria-hidden="true" title="Goal status">◎</span><span title={goal.objective}>{goal.status === "active" ? "Pursuing goal" : goal.status === "complete" ? "Goal completed" : "Goal " + goal.status.replaceAll("_", " ")} <strong>{goal.objective}</strong></span><small title="Elapsed goal time">{goal.elapsedMs !== undefined ? formatDuration(goal.elapsedMs) : ""}</small>{props.onGoalStatus && props.selectedSession?.goal && !selectedArchived && !props.selectedSession.subAgent && !props.selectedSession.parentSessionId && ["active", "paused", "blocked", "usage_limited"].includes(goal.status) ? <button type="button" class="cli-icon-button cli-goal-control" disabled={props.goalUpdating || props.connected === false || props.selectedSession.status === "unknown"} aria-busy={props.goalUpdating} aria-label={goal.status === "active" ? "Pause goal" : "Resume goal"} title={goal.status === "active" ? "Pause automatic goal continuation" : "Resume this goal in Codex"} onClick={event => { event.preventDefault(); event.stopPropagation(); props.onGoalStatus?.(goal.status === "active" ? "paused" : "active"); }}>{goal.status === "active" ? <Icon><path d="M8 5v14M16 5v14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" /></Icon> : <Icon><path d="m8 5 11 7-11 7Z" fill="currentColor" /></Icon>}</button> : null}<ChevronIcon /></summary><div><p>{goal.objective}</p><small>{goal.detail || "Goal status and elapsed time update with the conversation."}</small></div></details> : null}
              {props.selectedSession?.queueEnabled ? <div class="cli-queue-strip" role="status"><span class="cli-queue-mark" aria-hidden="true" title="Queued session">☷</span><span title="This session waits until active work finishes"><strong>Queued</strong><small>Priority {props.selectedSession.queuePriority ?? 3}</small></span><button type="button" class="cli-icon-button" disabled={props.mutating || props.connected === false} aria-label="Remove session from queue" title="Remove from queue" onClick={() => props.onQueue(props.selectedSession!, false)}><CloseIcon /></button></div> : null}
              {selectedArchived ? (
                <div class="cli-archived-lock"><ArchiveIcon /><span><strong>This session is archived.</strong> Restore it to open or continue the conversation.</span><button type="button" class="cli-primary-button" disabled={props.mutating} onClick={() => props.onUnarchive(props.selectedSession!)}>Restore session</button></div>
              ) : props.selectedSession.status === "unknown" ? (
                <div class="cli-workspace-feedback is-warning" role="status"><ShieldIcon /><span>Running state unavailable. {props.selectedSession.statusError} Your draft is saved; refresh before sending.</span><button type="button" onClick={props.onRefreshMessages} disabled={props.messagesLoading}>Retry</button></div>
              ) : composerBlockedByOwner || props.connected === false ? (
                <div class={`cli-composer-unavailable is-running ${props.connected === false ? "is-reconnecting" : ""}`} role="status" title={props.connected === false ? "The live connection is unavailable. Sending resumes after reconnect." : `${props.selectedSession.status === "running" ? `Running in ${props.selectedSession.runningBy ?? "another Codex process"}. Wait for that run to finish.` : "Session locked. Wait for Codex to release the lock."} Next turn: ${selectedModel?.label ?? model ?? "Default"} · ${reasoningEffort ?? "Default"} · ${sandboxMode}`}>
                  {props.connected === false ? <ShieldIcon /> : props.selectedSession.status === "running" || props.selectedSession.locked ? <span class="cli-live-spinner" aria-hidden="true" /> : <ShieldIcon />}<span><strong>{props.connected === false ? "Reconnecting" : props.selectedSession.status === "running" || props.selectedSession.locked ? "Running elsewhere" : "Session locked"}</strong><small class="cli-locked-turn-settings" title={`${model ?? 'Default model'} · ${reasoningEffort ?? 'Default effort'} · ${sandboxMode}`}> · {selectedModel?.label ?? model ?? "Default"} · {reasoningEffort ?? "Default"} · {sandboxMode === "danger-full-access" ? "Full" : sandboxMode === "read-only" ? "RO" : "RW"}</small></span>
                  {legacyDraftWarning}<span class="cli-running-actions">
                    {!props.selectedSession.subAgent && !props.selectedSession.parentSessionId ? <IconButton pressed={sessionAutoResume} label={sessionAutoResume ? 'Pause Auto Resume' : 'Enable Auto Resume'} title={sessionAutoResume ? 'Pause Auto Resume for this session' : 'Enable Auto Resume for this session'} disabled={props.mutating || props.connected === false} onClick={() => props.onAutoResume(props.selectedSession!, !sessionAutoResume)}><AutoResumeIcon enabled={sessionAutoResume} goal={!!goal} /></IconButton> : null}
                    <IconButton label="Stop turn" title={props.stopping ? 'Stopping…' : props.selectedSession.canStop ? 'Stop this turn' : 'Stop this turn from its owning Codex window'} disabled={!props.selectedSession.canStop || props.stopping || props.connected === false} onClick={() => props.onStop(props.selectedSession!)}><StopIcon /></IconButton>
                  </span>
                </div>
              ) : (
                <Composer
                  attachments={attachments} attachmentReading={attachmentReading} onAttach={(files) => void addAttachments(files)} onRemoveAttachment={(id) => setAttachments((current) => current.filter((file) => file.id !== id))}
                  draft={draft}
                  model={model}
                  reasoningEffort={reasoningEffort}
                  sandboxMode={sandboxMode}
                  projectPath={props.selectedSession.projectPath ?? projectPath}
                  projectLocked
                  projects={composerProjects}
                  models={props.composerConfig?.models ?? []}
                  reasoningOptions={reasoningOptions}
                  sending={currentTurnRunning}
                  canSteer={canSteer}
                  submitDisabled={!props.connected || !draftReadyKeys.has(draftKey) || props.steering}
                  stopping={props.stopping}
                  onDraft={setDraft}
                  onModel={(nextModel) => {
                    setModel(nextModel);
                    const option = props.composerConfig?.models.find((item) => item.id === nextModel);
                    setReasoningEffort(option?.defaultReasoningEffort ?? option?.reasoningEfforts[0]);
                  }}
                  onReasoning={setReasoningEffort}
                  onSandbox={setSandboxMode}
                  onProject={setProjectPath}
                  onSubmit={submit}
                  composerHeight={layout.composerHeight}
                  onResize={beginComposerResize}
                  onResizeKeyDown={(event) => adjustComposerWithKeyboard(event.key, event.shiftKey)}
                  onStop={() => props.selectedSession && props.onStop(props.selectedSession)}
                />
              )}
              {!composerBlockedByOwner && props.connected !== false ? legacyDraftWarning : null}
            </>
          ) : newChatProject !== undefined ? (
            <>
              <section class="cli-message-viewport cli-new-chat-viewport"><div class="cli-new-chat-copy"><span class="cli-empty-mark">{props.logoUri ? <img src={props.logoUri} alt="" aria-hidden="true" /> : <CodexSessionIcon />}</span><h2>What should we build in {composerProjects.find((project) => project.path === newChatProject)?.label ?? "your workspace"}?</h2><p>Describe the task and Codex will work directly in this project.</p></div></section>
              <UsageBanner account={props.account} onAction={(message) => reportLocalFeedback({ level: "info", message })} />

              {legacyDraftWarning}{draftStorageWarning}
              {props.starting ? <div class="cli-composer-unavailable is-running" role="status"><span class="cli-live-spinner" aria-hidden="true" />Starting your Codex session…</div> : <Composer attachments={attachments} attachmentReading={attachmentReading} onAttach={(files) => void addAttachments(files)} onRemoveAttachment={(id) => setAttachments((current) => current.filter((file) => file.id !== id))} draft={draft} model={model} reasoningEffort={reasoningEffort} sandboxMode={sandboxMode} projectPath={newChatProject} projects={composerProjects} models={props.composerConfig?.models ?? []} reasoningOptions={reasoningOptions} sending={false} stopping={false} submitDisabled={props.connected === false || !draftReadyKeys.has(draftKey)} onDraft={setDraft} onModel={(nextModel) => { setModel(nextModel); const option = props.composerConfig?.models.find((item) => item.id === nextModel); setReasoningEffort(option?.defaultReasoningEffort ?? option?.reasoningEfforts[0]); }} onReasoning={setReasoningEffort} onSandbox={setSandboxMode} onProject={(next) => { setProjectPath(next); setNewChatProject(next); }} onSubmit={submit} composerHeight={layout.composerHeight} onResize={beginComposerResize} onResizeKeyDown={(event) => adjustComposerWithKeyboard(event.key, event.shiftKey)} onStop={() => undefined} />}
            </>
          ) : <WorkspaceEmpty logoUri={props.logoUri} running={runningCount} active={activeSessions.length} archived={archivedSessions.length} onNewChat={() => startNewChat()} />}
        </main>
        <PanelResizeHandle
          label="Resize terminal panel"
          value={layout.terminalWidth}
          minimum={280}
          onPointerDown={(event) => beginPanelResize("terminal", event)}
          onKeyDown={(event) => adjustPanelWithKeyboard("terminal", event.key, event.shiftKey)}
          onReset={() => setLayout((current) => ({ ...current, terminalWidth: DEFAULT_WORKSPACE_LAYOUT.terminalWidth }))}
        />
        <WorkspaceContextPanel
          onCollapse={() => { setContextCollapsed(true); setContextAddOpen(false); }}
          connected={props.connected !== false}
          projectPath={toolProjectPath}
          targetDeviceId={workspacePeer?.local === false ? workspacePeer.id : props.selectedSession?.remote ? props.selectedSession.deviceId : undefined}
          session={props.selectedSession}
          systemName={workspaceSystemName}
          autoResumeEnabled={props.autoResumeEnabled ? props.selectedSession?.autoResumeEnabled !== false : props.selectedSession?.autoResumeEnabled === true}
          environment={currentWorkspaceData && props.environment && canonicalWebPath(props.environment.projectPath) === canonicalWebPath(toolProjectPath ?? '') ? props.environment : undefined}
          environmentLoading={props.environmentLoading}
          workspaceGitPending={contextProjectState.workspaceGitPending}
          workspaceGitNotice={contextProjectState.workspaceGitNotice}
          onWorkspaceGitPending={(pending, message, committedDraft) => setContextTabsByProject(current => {
            const entry = current[contextProjectKey] ?? emptyWorkspaceProject();
            return { ...current, [contextProjectKey]: { ...entry, workspaceGitPending: pending, workspaceGitNotice: message, commitDraft: committedDraft !== undefined && entry.commitDraft === committedDraft ? '' : entry.commitDraft } };
          })}
          commitDraft={contextProjectState.commitDraft ?? ''}
          gitPending={contextProjectState.gitPending?.kind}
          gitNotice={contextProjectState.gitNotice}
          scopeKey={contextProjectKey}
          fileDrafts={contextProjectState.fileDrafts ?? {}}
          fileNotice={contextProjectState.fileNotice}
          onFileDraft={editFileDraft}
          onCommitDraft={setCommitDraft}
          onCommit={() => runGitAction('commit')}
          onPush={() => runGitAction('push')}
          onRefreshEnvironment={(gitHistory) => props.onRefreshEnvironment(toolProjectPath, undefined, gitHistory)}
          onBranchReview={() => { openContextTab('reviews'); setBranchReview(true); props.onRefreshEnvironment(toolProjectPath, true); }}
          terminalWidth={layout.terminalWidth}
          draft={terminalDraft}
          results={props.terminalResults}
          liveOutputs={props.terminalLiveOutputs}
          terminals={props.workspaceTerminals}
          running={props.terminalRunning || props.terminalLiveOutputs.some((output) => output.terminalId === props.workspaceTerminals.find((terminal) => terminal.isActive)?.id)}
          stopping={props.terminalStopping}
          collapsed={toolsCollapsed}
          tabs={contextTabs}
          activeTab={activeContextTab}
          addOpen={contextAddOpen}
          files={currentWorkspaceData ? props.workspaceFiles : []}
          filesByPath={currentWorkspaceData ? props.workspaceFilesByPath : {}}
          fileChanges={railFiles}
          branchReview={branchReview}
          branchEnvironment={currentWorkspaceData && props.environment && toolProjectPath && canonicalWebPath(props.environment.projectPath) === canonicalWebPath(toolProjectPath) ? props.environment : undefined}
          comparisonLoading={props.environmentLoading}
          onCompareBranch={() => props.onRefreshEnvironment(toolProjectPath, true)}
          onShowTurnReview={() => setBranchReview(false)}
          agents={railAgents}
          agentSessions={props.sessions.map((session) => ({ ...session, ...readSubAgentMetadata(session) })).filter((session) => session.subAgent && session.parentSessionId === props.selectedSession?.id && (session.deviceId ?? "local") === (props.selectedSession?.deviceId ?? "local"))}
          agentMessages={props.agentMessages ?? {}}
          onReadAgent={props.onReadAgent}
          filesLoading={props.workspaceFilesLoading}
          fileLoading={props.workspaceFileLoading}
          fileSaving={props.workspaceFileSaving}
          onDraft={setTerminalDraft}
          onRun={(command, terminalId) => { const id = props.onRunTerminal(command, toolProjectPath, terminalId); if (id) submittedTerminalDrafts.current.set(id, { key: contextProjectKey, text: command }); else reportLocalFeedback({ level:'error', message:'Command was not sent. Your terminal draft was kept.' }); }}
          onListTerminals={props.onListTerminals}
          onCreateTerminal={(profile) => props.onCreateTerminal(profile, toolProjectPath)}
          onFocusTerminal={props.onFocusTerminal}
          onCloseTerminal={props.onCloseTerminal}
          onFeedback={reportLocalFeedback}
          onStop={() => props.onCancelTerminal(props.workspaceTerminals.find((terminal) => terminal.isActive)?.id ?? WORKSPACE_TERMINAL_ID)}
          onClear={props.onClearTerminal}
          onTab={selectContextTab}
          onAddToggle={() => setContextAddOpen((open) => !open)}
          onAdd={openContextTab}
          onCloseTab={(tab) => { if (tab === 'env') return; const next = contextTabs.filter((item) => item !== tab); setContextTabs(next); if (activeContextTab === tab) setActiveContextTab('env'); }}
          onListFiles={() => props.onListFiles(toolProjectPath)}
          onReadFile={(filePath) => props.onReadFile(filePath, toolProjectPath)}
          onClearFile={props.onClearFile}
          onDeleteFile={(filePath) => props.onDeleteFile(filePath, toolProjectPath)}
          onSaveFile={(filePath, content, revision) => { const id = props.onSaveFile(filePath, content, revision, toolProjectPath); if (id) submittedFileDrafts.current.set(id, { key: contextProjectKey, path: filePath, text: content, revision }); }}
          onResizePointerDown={(event) => beginPanelResize("terminal", event)}
          onResizeKeyDown={(event) => adjustPanelWithKeyboard("terminal", event.key, event.shiftKey)}
          onResizeReset={() => setLayout((current) => ({ ...current, terminalWidth: DEFAULT_WORKSPACE_LAYOUT.terminalWidth }))}
        />
      </div>
      {shareOpen && props.selectedSession ? <SessionShareModal connected={props.connected !== false} key={cliSessionTargetKey(props.selectedSession)} title={props.selectedSession.title} sessionKey={cliSessionTargetKey(props.selectedSession)} messages={props.messages} onClose={() => setShareOpen(false)} /> : null}
    </div>
  );
}

export function ConversationHeader(props: {
  session: DashboardCliSessionSummary; readOnly?: boolean; archived?: boolean; busy?: boolean; sending?: boolean;
  onBack?: () => void; onRefresh: () => void;
  onRename?: (name: string) => void; onFork?: () => void; onCopyLink?: () => void; onShare?: () => void;
  onArchive?: () => void; onRestore?: () => void; onDelete?: () => void; onRenameCancelled?: () => void; onOpenInCodex?: () => void;
  terminalCollapsed?: boolean; onToggleTerminal?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const close = (event: Event): void => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") { setMenuOpen(false); menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(props.session.title);
  useEffect(() => setName(props.session.title), [props.session.id, props.session.title]);
  const statusLabel = props.archived ? "Archived" : props.session.status === "unknown" ? "Status unavailable" : props.session.status === "running" ? "Running" : "Ready";
  return <header class="cli-conversation-header">
    {!props.readOnly ? <span id="session-sidebar-toggle-slot" class="content-sidebar-slot" /> : null}<div class="cli-conversation-title"><div class="cli-conversation-title-line"><h1>{props.session.title}</h1>{!props.readOnly || props.session.status !== 'unknown' ? <span title={statusLabel} aria-label={statusLabel} class={`cli-state-pill ${props.archived ? "is-archived" : props.session.status === "running" ? "is-running" : ""}`}>{statusLabel}</span> : null}</div>{props.session.projectPath ? <div class="cli-conversation-project" title={props.session.projectPath}><EmptyFolderIcon /><strong>{projectDisplayName(props.session.projectPath)}</strong><span>{props.session.projectPath}</span></div> : null}</div>
    <div class="cli-conversation-actions">
      {props.readOnly || !props.archived ? <IconButton label="Refresh conversation" disabled={props.busy} onClick={props.onRefresh}><RefreshIcon /></IconButton> : <button type="button" class="cli-secondary-button" disabled={props.busy} onClick={props.onRestore}><RestoreIcon /> Restore</button>}
      {!props.readOnly ? <><button type="button" class="cli-icon-button cli-inspector-toggle" aria-label={props.terminalCollapsed ? "Show workspace tools" : "Hide workspace tools"} title="Workspace tools" aria-expanded={!props.terminalCollapsed} onClick={() => props.onToggleTerminal?.()}><PanelIcon /></button>
      <div class="cli-session-menu-wrap" ref={menuRef}>
        <button type="button" class="cli-icon-button" aria-label="Session actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreIcon /></button>
        {menuOpen ? <div class="cli-session-menu" role="menu">
          {!props.archived ? <>
            <button type="button" role="menuitem" class="cli-mobile-menu-item" disabled={props.busy} onClick={() => { setMenuOpen(false); props.onRefresh(); }}><RefreshIcon /> Refresh conversation</button>
            <span class="cli-mobile-menu-item" />
          </> : <button type="button" role="menuitem" class="cli-mobile-menu-item" disabled={props.busy} onClick={() => { setMenuOpen(false); props.onRestore?.(); }}><RestoreIcon /> Restore</button>}
          {!props.archived ? <>
            {props.onOpenInCodex ? <button type="button" role="menuitem" disabled={props.busy} onClick={() => { setMenuOpen(false); props.onOpenInCodex?.(); }}><CodexSessionIcon /> Open in Codex</button> : null}
            <button type="button" role="menuitem" disabled={props.busy || props.sending} onClick={() => { setMenuOpen(false); setRenaming(true); }}><PencilIcon /> Rename</button>
            <button type="button" role="menuitem" disabled={props.busy || props.sending} onClick={() => { setMenuOpen(false); props.onFork?.(); }}><ForkIcon /> Fork session</button>
            <button type="button" role="menuitem" disabled={props.busy || props.sending} onClick={() => { setMenuOpen(false); props.onArchive?.(); }}><ArchiveIcon /> Archive</button>
            <span />
            <button type="button" role="menuitem" disabled={props.busy || props.sending} onClick={() => { setMenuOpen(false); props.onShare?.(); }}><ShareIcon /> Share</button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onCopyLink?.(); }}><LinkIcon /> Copy link</button>
            <span />
          </> : null}
          <button type="button" role="menuitem" class="is-danger" disabled={props.busy || props.sending} onClick={() => { setMenuOpen(false); props.onDelete?.(); }}><TrashIcon /> Delete</button>
        </div> : null}
      </div>
    </> : null}</div>
    {renaming ? <form class="cli-rename-form" onSubmit={(event) => { event.preventDefault(); const normalized = name.trim(); if (normalized) { props.onRename?.(normalized); setRenaming(false); } }}><PencilIcon /><input value={name} maxLength={160} autoFocus aria-label="Session name" onInput={(event) => setName(event.currentTarget.value)} /><button type="button" onClick={() => { setName(props.session.title); setRenaming(false); props.onRenameCancelled?.(); }}>Cancel</button><button type="submit" disabled={!name.trim()}>Save</button></form> : null}
  </header>;
}

function Composer(props: {
  attachments: ChatAttachment[]; attachmentReading: boolean; onAttach: (files: File[]) => void; onRemoveAttachment: (id: string) => void;
  draft: string; model?: string; reasoningEffort?: string; sandboxMode: DashboardCliSandboxMode;
  projectPath?: string; projectLocked?: boolean; projects: Array<{ id: string; label: string; path: string }>;
  models: DashboardCliComposerConfig["models"]; reasoningOptions: string[]; sending: boolean; stopping: boolean;
  canSteer?: boolean; submitDisabled?: boolean;
  composerHeight: number;
  onDraft: (value: string) => void; onModel: (value: string) => void; onReasoning: (value: string) => void;
  onSandbox: (value: DashboardCliSandboxMode) => void; onProject: (value: string) => void; onSubmit: () => void; onStop: () => void;
  onResize: (event: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!optionsOpen) return;
    const close = (event: Event): void => { if (!optionsRef.current?.contains(event.target as Node)) setOptionsOpen(false); };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOptionsOpen(false);
      optionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [optionsOpen]);
  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    const fit = (): void => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    };
    fit();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      fit();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [props.draft, props.composerHeight]);
  const modelChoices = props.models.length > 0 ? props.models : [{ id: props.model ?? "", label: props.model ?? "Default model", reasoningEfforts: props.reasoningOptions }];
  const selectedModel = modelChoices.find((option) => option.id === props.model) ?? modelChoices[0];
  const reasoningChoices = selectedModel?.reasoningEfforts.length ? selectedModel.reasoningEfforts : props.reasoningOptions.length ? props.reasoningOptions : ["medium"];
  const selectedReasoning = reasoningChoices.includes(props.reasoningEffort ?? "")
    ? props.reasoningEffort
    : reasoningChoices[0];
  const projectPicker = !props.projectLocked ? <div class="cli-composer-location is-top"><EmptyFolderIcon /><select name="project-path" value={props.projectPath ?? ""} aria-label="Project" title={props.projectPath ?? "Work locally"} onChange={(event) => props.onProject(event.currentTarget.value)}>{props.projects.map((project) => <option value={project.path} key={project.id}>{project.label}</option>)}</select></div> : null;

  return <>{projectPicker}<form class="cli-composer" style={`--cli-composer-text-limit:${props.composerHeight}px`} onDragOver={(event) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { if (!event.dataTransfer?.files.length) return; event.preventDefault(); props.onAttach(Array.from(event.dataTransfer.files)); }} onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
    <input ref={fileInput} type="file" hidden multiple aria-label="Choose attachments" accept="image/png,image/jpeg,image/webp,text/*,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.yaml,.yml,.toml,.rs,.go,.sql" onChange={(event) => { props.onAttach(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
    {props.attachments.length ? <div class="cli-attachment-list">{props.attachments.map((file) => <span key={file.id}>{file.kind === "image" ? <img src={file.data} alt="" /> : <FileIcon />}<span title={file.name}>{file.name}</span><button type="button" disabled={props.attachmentReading} aria-label={`Remove ${file.name}`} onClick={() => props.onRemoveAttachment(file.id)}>×</button></span>)}</div> : null}
    <div class="cli-composer-resizer" role="separator" aria-label="Resize message composer" aria-orientation="horizontal" aria-valuemin={120} aria-valuenow={Math.round(props.composerHeight)} tabIndex={0} onPointerDown={props.onResize} onKeyDown={props.onResizeKeyDown}><span /></div>
    <textarea ref={textarea} name="codex-message" value={props.draft} rows={1} maxLength={64_000} placeholder="Message Codex…" aria-label="Message Codex" onInput={(event) => props.onDraft(event.currentTarget.value)} onPaste={(event) => { const files = Array.from(event.clipboardData?.files ?? []); if (files.length) { event.preventDefault(); props.onAttach(files); } }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && (event.ctrlKey || event.metaKey || !window.matchMedia("(max-width: 760px)").matches)) { event.preventDefault(); props.onSubmit(); } }} />
    <div class="cli-composer-toolbar"><div class="cli-composer-selectors"><button type="button" class="cli-attach-button" aria-label="Attach files" title="Attach images or text/code files (up to 8 files, 1 MB total)" disabled={props.attachmentReading} onClick={() => fileInput.current?.click()}>{props.attachmentReading ? <span class="cli-live-spinner" /> : <PlusIcon />}</button>
      <label class={`cli-composer-access ${props.sandboxMode === "danger-full-access" ? "is-full-access" : ""}`} title="Access for the next turn"><ShieldIcon /><select name="sandbox-mode" value={props.sandboxMode} aria-label="Access mode" onChange={(event) => props.onSandbox(event.currentTarget.value as DashboardCliSandboxMode)}><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access</option></select></label>
    </div><div class="cli-composer-submit">
      <div class="cli-composer-options-wrap" ref={optionsRef}>
        <button type="button" class="cli-composer-options-toggle" aria-label="Message settings" aria-expanded={optionsOpen} title={`${selectedModel?.label ?? "Default model"} · ${selectedReasoning ?? "Default reasoning"} · ${props.sandboxMode}`} onClick={() => setOptionsOpen((open) => !open)}><span>{selectedModel?.label ?? "Default"} {selectedReasoning === "xhigh" ? "Extra high" : capitalize(selectedReasoning ?? "medium")}</span><ChevronIcon /></button>
        {optionsOpen ? <div class="cli-composer-options" role="group" aria-label="Message settings">
          <header><strong>{props.sending ? "Next turn settings" : "Message settings"}</strong><button type="button" aria-label="Close message settings" onClick={() => setOptionsOpen(false)}>×</button></header>
          <label><span>Model</span><select name="model" value={selectedModel?.id ?? ""} aria-label="Model" onChange={(event) => props.onModel(event.currentTarget.value)}>{modelChoices.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
          <label><span>Reasoning</span><select name="reasoning-effort" value={selectedReasoning ?? ""} aria-label="Reasoning" onChange={(event) => props.onReasoning(event.currentTarget.value)}>{reasoningChoices.map((effort) => <option value={effort} key={effort}>{effort === "xhigh" ? "Extra high" : capitalize(effort)}</option>)}</select></label>
        </div> : null}
      </div>
      <span>{props.draft.length > 60_000 ? `${64_000 - props.draft.length} left` : null}</span>{props.sending ? <button type="button" class="cli-stop-button" disabled={props.stopping} aria-busy={props.stopping} aria-label={props.stopping ? "Stopping" : "Stop"} title={props.stopping ? "Stopping" : "Stop"} onClick={props.onStop}><StopIcon /> {props.stopping ? "Stopping" : "Stop"}</button> : null}{!props.sending || props.canSteer ? <button type="submit" class="cli-send-button" disabled={props.submitDisabled || props.attachmentReading || (!props.draft.trim() && !props.attachments.length)} aria-label={props.canSteer ? "Send follow-up" : "Send message"} title={props.canSteer ? "Send follow-up to the running turn" : "Send message"}><SendIcon /></button> : null}</div></div>
  </form></>;
}

function LiveTurnDetails({ state }: { state?: DashboardCodexSessionLiveState; loading?: boolean; onLoadHistory?: () => void }) {
  const tokens = state?.tokenUsage;
  const counts = tokens ? [["Input", tokens.input], ["Cached", tokens.cachedInput], ["Output", tokens.output], ["Reasoning", tokens.reasoningOutput], ["Total", tokens.total], ["Context", tokens.contextWindow]].filter((entry) => typeof entry[1] === "number") : [];
  const total = typeof tokens?.total === "number" ? `${tokens.total.toLocaleString()} tokens` : undefined;
  const primary = state?.rateLimits?.primary ? `${Math.round(state.rateLimits.primary.usedPercent)}% used` : undefined;
  if (!state?.error && !state?.plan?.steps.length && !state?.diff && !counts.length && !state?.rateLimits) return null;
  return <div class="cli-turn-details">
    {state?.error ? <p class="cli-composer-unavailable" role="alert">{state.error}</p> : null}
    {state?.plan?.steps.length ? <details class="cli-activity is-plan"><summary><strong>Current plan</strong></summary><div class="cli-activity-body">{state.plan.explanation ? <p>{state.plan.explanation}</p> : null}<ol>{state.plan.steps.map((step, index) => <li key={index}>{step.status === "completed" ? "✓ " : step.status === "inProgress" ? "In progress · " : "Pending · "}{step.step}</li>)}</ol></div></details> : null}
    {state?.diff ? <details class="cli-activity is-file-change"><summary><strong>Turn changes</strong></summary><DiffPreview diff={state.diff} /></details> : null}
    {counts.length || state?.rateLimits ? <details class="cli-activity cli-turn-usage"><summary><span class="cli-activity-icon" aria-hidden="true" title="Token usage">Σ</span><span class="cli-activity-heading"><strong>Turn usage</strong><small>{[total, primary].filter(Boolean).join(" · ") || "Details"}</small></span><ChevronIcon /></summary><div class="cli-activity-body"><div class="cli-usage-grid">{counts.map(([label, count]) => <span key={String(label)} title={`${label} tokens`}><i aria-hidden="true">{String(label).toLowerCase().includes("cache") ? "◌" : String(label).toLowerCase().includes("output") ? "↑" : String(label).toLowerCase().includes("input") ? "↓" : "•"}</i><b>{label}</b><strong>{Number(count).toLocaleString()}</strong></span>)}</div>{state?.rateLimits ? Object.entries(state.rateLimits).map(([window, limit]) => limit ? <p class="cli-rate-window" key={window}><span>{window === "primary" ? "Primary" : "Secondary"} window</span><strong>{Math.round(limit.usedPercent)}% used</strong><small>{limit.resetsAt ? `Resets ${new Date(limit.resetsAt * 1000).toLocaleString()}` : "Reset time unavailable"}</small></p> : null) : null}</div></details> : null}
  </div>;
}

export function SessionMessage({ message, logoUri, turnCopyText, onActionFeedback, onDraftMessage, onRetryPrompt, onOpenFile, onOpenReviews }: { message: DashboardCliSessionMessage; logoUri?: string; turnCopyText?: string; onActionFeedback?: (notice: DashboardNotice) => void; onDraftMessage?: (text: string, quote: boolean) => void; onRetryPrompt?: () => void; onOpenFile?: (filePath: string) => void; onOpenReviews?: (filePath?: string) => void }) {
  const renderedText = (!message.kind || message.kind === 'message') && message.role !== 'user' ? <MarkdownMessage text={message.text} onOpenFile={onOpenFile} /> : message.text;
  const questionReplies = useMemo(() => message.role === "user" ? parseQuestionReply(message.text) : undefined, [message.text, message.role]);
  if (!message.kind || message.kind === "message") {
    const isUser = message.role === "user";
    return <article tabIndex={0} onPointerDown={(event) => { if (event.pointerType === "touch" && !(event.target as Element).closest("button,a,input,textarea,select")) event.currentTarget.focus({ preventScroll: true }); }} aria-label={`${isUser ? "Your" : "Codex"} message; focus for actions`} class={`cli-session-message is-${message.role ?? "assistant"} ${turnCopyText ? "has-turn-copy" : ""}`}><div class="cli-session-avatar">{isUser ? "Y" : logoUri ? <img src={logoUri} alt="" aria-hidden="true" /> : <CodexSessionIcon />}</div><div class="cli-session-message-body"><div class="cli-session-message-head"><strong>{isUser ? "You" : "Codex"}</strong><time>{formatTime(message.timestamp)}</time></div>{questionReplies ? <div class="cli-question-replies" aria-label="Answered questions">{questionReplies.map((reply, index) => <div class="cli-question-reply" key={`${index}-${reply.question}`}><small>Answered question</small><strong>{reply.question}</strong><span>{reply.answer}</span></div>)}</div> : message.text ? <div class="cli-session-message-text">{renderedText}</div> : null}{message.images?.length ? <div class="cli-session-images">{message.images.map((image, index) => <ImagePreview key={`${image.src}-${index}`} image={image} index={index} />)}</div> : null}{message.text || turnCopyText ? <div class="cli-message-actions" role="group" aria-label="Message actions"><span class="cli-message-action-menu">{message.text ? <TurnCopyButton text={message.text} label="Copy message" onActionFeedback={onActionFeedback} /> : null}{turnCopyText && turnCopyText !== message.text ? <TurnCopyButton text={turnCopyText} onActionFeedback={onActionFeedback} /> : null}{onDraftMessage && message.text ? <><button type="button" aria-label="Quote" title="Quote" onClick={() => onDraftMessage(message.text, true)}><QuoteIcon /></button>{isUser ? <button type="button" aria-label="Edit and resend" title="Edit and resend" onClick={() => onDraftMessage(message.text, false)}><PencilIcon /></button> : turnCopyText && onRetryPrompt ? <button type="button" aria-label="Retry prompt" title="Retry prompt" onClick={onRetryPrompt}><RefreshIcon /></button> : null}</> : null}</span></div> : null}</div></article>;
  }
  return <ActivityMessage message={message} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} />;
}

function ImagePreview({ image, index }: { image: { src: string; alt?: string }; index: number }) {
  const [open, setOpen] = useState(false);
  const alt = image.alt ?? `Image ${index + 1}`;
  return <>
    <button type="button" class="cli-image-preview-trigger" aria-label={`Preview ${alt}`} onClick={() => setOpen(true)}>
      <img src={image.src} alt={alt} loading="lazy" />
    </button>
    {open ? <ImageLightbox image={{ ...image, alt }} onClose={() => setOpen(false)} /> : null}
  </>;
}

function ImageLightbox({ image, onClose }: { image: { src: string; alt?: string }; onClose: () => void }) {
  const accessibility = useModalAccessibility(true, onClose);
  const [failed, setFailed] = useState(false);
  const alt = image.alt || "Image preview";
  return createPortal(
      <div ref={accessibility.modalRef} class="cli-image-lightbox" role="dialog" aria-modal="true" aria-label={alt} tabIndex={-1} onKeyDown={accessibility.onKeyDown} onPointerDown={accessibility.onBackdropPointerDown} onMouseDown={accessibility.onBackdropMouseDown} onClick={accessibility.onBackdropClick}>
        <div class="cli-image-lightbox-toolbar"><strong>{alt}</strong><span><a href={image.src} target="_blank" rel="noopener noreferrer">Open original</a><button type="button" aria-label="Close image preview" onClick={onClose}><CloseIcon /></button></span></div>
        {failed ? <p role="alert">Image unavailable. Open the original or close this preview.</p> : <img src={image.src} alt={alt} onError={() => setFailed(true)} />}
      </div>,
      document.body
    );
}

export function parseQuestionReply(text: string): Array<{ question: string; answer: string }> | undefined {
  const match = text.match(/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/);
  if (!match) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]!);
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const replies = value.map((item: unknown) => {
      if (!item || typeof item !== "object") return undefined;
      const reply = item as Record<string, unknown>;
      if (typeof reply["question"] !== "string" || typeof reply["answer"] !== "string") return undefined;
      const question = reply["question"].trim();
      const answer = reply["answer"].trim();
      return question && answer ? { question, answer } : undefined;
    });
    return replies.every((reply) => reply !== undefined) ? replies as Array<{ question: string; answer: string }> : undefined;
  } catch {
    return undefined;
  }
}

function MarkdownMessage({ text, onOpenFile }: { text: string; onOpenFile?: (path: string) => void }) {
  const html = useMemo(() => markdownRenderer.render(text), [text]);
  const [feedback, setFeedback] = useState<string>();
  const [preview, setPreview] = useState<{ src: string; alt?: string }>();
  const copyCode = async (event: JSX.TargetedMouseEvent<HTMLDivElement>): Promise<void> => {
    const file = (event.target as Element).closest<HTMLAnchorElement>('a[data-workspace-file]');
    if (file) {
      event.preventDefault();
      if (onOpenFile) onOpenFile(file.dataset['workspaceFile']!);
      else setFeedback('Open this conversation in its workspace to view this file.');
      return;
    }
    if (event.target instanceof HTMLImageElement) {
      event.preventDefault();
      setPreview({ src: event.target.src, alt: event.target.alt });
      return;
    }
    const button = (event.target as Element).closest<HTMLButtonElement>(".cli-code-copy");
    if (!button || button.disabled) return;
    const code = button.parentElement?.querySelector("pre code");
    if (!code) return;
    button.disabled = true;
    try {
      await copyWorkspaceText(code.textContent ?? "");
      setFeedback(undefined);
      button.textContent = "Copied";
      window.setTimeout(() => { if (button.isConnected) button.textContent = "Copy code"; }, 1500);
    } catch {
      setFeedback("Code could not be copied. Select the code and copy it manually.");
    } finally {
      button.disabled = false;
    }
  };
  return <><div class="cli-message-markdown" onClick={(event) => void copyCode(event)} onKeyDown={(event) => { if (event.target instanceof HTMLImageElement && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setPreview({ src: event.target.src, alt: event.target.alt }); } }} dangerouslySetInnerHTML={{ __html: html }} />{feedback ? <small role="status" class="cli-code-copy-feedback">{feedback}</small> : null}{preview ? <ImageLightbox image={preview} onClose={() => setPreview(undefined)} /> : null}</>;
}

export function splitMessageParagraphs(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split(/\n{2,}/).filter((paragraph) => paragraph.length > 0);
}

export function TurnCopyButton({ text, label = "Copy assistant turn", onActionFeedback }: { text: string; label?: string; onActionFeedback?: (notice: DashboardNotice) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await copyWorkspaceText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      onActionFeedback?.({ level: "error", message: "Response could not be copied." });
    }
  };
  return <button type="button" class="cli-turn-copy" aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label} onClick={() => void copy()}>{copied ? <CheckIcon /> : <CopyIcon />}</button>;
}

function CopySnippet({ text, label = "Copy code" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async (): Promise<void> => {
    try {
      await copyWorkspaceText(text);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1200);
    } catch {
      setState("failed");
    }
  };
  return <button type="button" class="cli-code-copy cli-code-copy-float" aria-label={state === "copied" ? "Copied" : state === "failed" ? `${label} failed. Select and copy manually, or retry.` : label} title={state === "failed" ? "Copy failed. Select and copy manually, or retry." : state === "copied" ? "Copied" : label} onClick={() => void copy()}>{state === "copied" ? <CheckIcon /> : state === "failed" ? <WarningIcon /> : <CopyIcon />}</button>;
}

function ActivityMessage({ message, onOpenFile, onOpenReviews }: { message: DashboardCliSessionMessage; onOpenFile?: (filePath: string) => void; onOpenReviews?: (filePath?: string) => void }) {
  const running = message.status === "inProgress";
  const failed = message.status === "failed" || message.kind === "error";
  const capacity = isCodexCapacityInterruption([message.text, message.result, message.debug].filter(Boolean).join(" "));
  return <details class={`cli-activity is-${message.kind} ${running ? "is-running" : ""} ${failed ? "is-failed" : ""}`} open={message.kind === "reasoning"}>
    <summary title={[message.command ?? message.title, message.cwd, formatTime(message.timestamp)].filter(Boolean).join(" · ")}>
      <span class="cli-activity-icon"><ActivityGlyph kind={message.kind} /></span>
      <span class="cli-activity-heading"><strong>{activityLabel(message)}</strong><small>{activityMeta(message)}</small></span>
      <span class={`cli-activity-status is-${message.status ?? "completed"}`}>{running ? <i /> : capacity ? "Capacity" : failed ? "Failed" : message.status === "declined" ? "Declined" : message.status === "interrupted" ? "Interrupted" : message.status === "unknown" ? "Unknown" : <CheckIcon />}</span>
      <ChevronIcon />
    </summary>
    <div class="cli-activity-body">
      {message.kind === "command" ? <>
        <div class="cli-code-surface cli-command-surface"><div class="cli-code-surface-head"><span title={message.cwd}>Shell{message.cwd ? ` · ${message.cwd}` : ""}</span><span><CopySnippet text={message.command ?? message.text} label="Copy command" />{message.output ? <CopySnippet text={message.output} label="Copy output" /> : null}</span></div><pre class="cli-activity-output"><code><span class="cli-command-line">$ {message.command ?? message.text}{"\n"}</span>{message.output || (running ? "Waiting for command output…" : "No command output.")}</code></pre></div>
      </> : message.kind === "file-change" ? <FileChangeDetails changes={message.changes ?? []} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} /> : message.kind === "tool-call" ? <>
        {message.text !== message.result ? <div class="cli-activity-copy cli-human-summary">{message.text}</div> : null}
        {message.arguments ? <div class="cli-activity-result"><div class="cli-code-surface"><div class="cli-code-surface-head"><strong>Arguments</strong><CopySnippet text={message.arguments} /></div><pre><code>{message.arguments}</code></pre></div></div> : null}
        {message.result ? <div class={`cli-activity-result ${failed ? "is-error" : ""}`}><div class="cli-code-surface"><div class="cli-code-surface-head"><strong>{failed ? "Error" : "Result"}</strong><CopySnippet text={message.result} label={failed ? "Copy error" : "Copy result"} /></div><pre><code>{message.result}</code></pre></div></div> : null}
        {message.debug ? <details class="cli-debug-details"><summary>Debug details</summary><div class="cli-code-surface"><CopySnippet text={message.debug} label="Copy debug details" /><pre><code>{message.debug}</code></pre></div></details> : null}
      </> : message.kind === "image" ? <><div class="cli-activity-copy">{message.text}</div>{message.images?.length ? <div class="cli-session-images cli-activity-images">{message.images.map((image, index) => <ImagePreview key={`${image.src}-${index}`} image={image} index={index} />)}</div> : null}</> : <ActivityDetail message={message} />}
    </div>
  </details>;
}

/**
 * Every persisted Codex activity kind gets a concrete detail surface.  The
 * summary row remains compact, while the expanded body preserves the useful
 * context that otherwise used to fall through to an unlabelled text blob.
 */
function ActivityDetail({ message }: { message: DashboardCliSessionMessage }) {
  switch (message.kind) {
    case "reasoning":
      return <div class="cli-activity-copy cli-activity-detail cli-activity-reasoning"><strong>Thinking</strong><span>{message.text || "Codex is reasoning about the next step."}</span></div>;
    case "plan":
      return <div class="cli-activity-copy cli-activity-detail cli-activity-plan"><strong>Plan</strong><span>{message.text || "Codex prepared a plan."}</span></div>;
    case "collaboration":
      return <div class="cli-activity-copy cli-activity-detail cli-activity-collaboration"><strong>{message.subtitle || "Agent activity"}</strong><span>{message.text || "An agent contributed to this turn."}</span>{message.result ? <div class="cli-code-surface"><div class="cli-code-surface-head"><span>Agent status</span><CopySnippet text={message.result} label="Copy agent status" /></div><pre><code>{message.result}</code></pre></div> : null}</div>;
    case "web-search":
      return <div class="cli-activity-detail cli-activity-search"><strong>Search query</strong><code>{message.text || "Web search"}</code>{message.result ? <span>{message.result}</span> : null}</div>;
    case "review":
      return <div class="cli-activity-copy cli-activity-detail cli-activity-review"><strong>Code review</strong><span>{message.text || "Codex reviewed the current changes."}</span></div>;
    case "compaction":
      return <div class="cli-activity-copy cli-activity-detail cli-activity-compaction"><strong>{message.status === "inProgress" ? "Compacting context" : "Context compacted"}</strong><span>{message.text || (message.status === "inProgress" ? "Codex is condensing earlier context before continuing." : "Codex condensed earlier context to continue working.")}</span></div>;
    case "error":
      return <div class="cli-activity-copy cli-activity-detail cli-activity-error">{isCodexCapacityInterruption([message.text, message.result, message.debug].filter(Boolean).join(" ")) ? <><strong>Model at capacity</strong><span>Selected model is at capacity. Try a different model, then retry.</span></> : <><strong>Error</strong><span>{message.text || "Codex reported an error."}</span></>}{message.debug ? <div class="cli-code-surface"><CopySnippet text={message.debug} label="Copy debug details" /><pre><code>{message.debug}</code></pre></div> : null}</div>;
    default:
      return <div class="cli-activity-copy cli-activity-detail">{isCodexCapacityInterruption([message.text, message.result, message.debug].filter(Boolean).join(" ")) ? <><strong>Model at capacity</strong><span>Selected model is at capacity. Try a different model, then retry.</span></> : <span>{message.text}</span>}</div>;
  }
}

function FileChangeDetails({ changes, onOpenFile, onOpenReviews }: { changes: NonNullable<DashboardCliSessionMessage["changes"]>; onOpenFile?: (filePath: string) => void; onOpenReviews?: (filePath?: string) => void }) {
  if (changes.length === 0) return <div class="cli-activity-copy">File changes are being prepared…</div>;
  return <div class="cli-file-change-list"><button type="button" class="cli-open-reviews" onClick={() => onOpenReviews?.()}><ReviewIcon /> Open all in Reviews</button>{changes.map((change) => <details key={`${change.path}-${change.kind}`}>
    <summary><span><FileIcon /><strong>{change.path}</strong></span><button type="button" onClick={(event) => { event.preventDefault(); onOpenFile?.(change.path); }}>Open</button><button type="button" onClick={(event) => { event.preventDefault(); onOpenReviews?.(change.path); }}>Review</button><small>{capitalize(change.kind)}</small><ChevronIcon /></summary>
    {change.diff ? <DiffPreview diff={change.diff} /> : <div class="cli-activity-copy">No diff details were recorded.</div>}
  </details>)}</div>;
}

function WorkspaceEnvironmentView(props: {
  environment?: DashboardWorkspaceEnvironment; session?: DashboardCliSessionSummary; projectPath?: string;
  systemName: string;
  autoResumeEnabled: boolean;
  connected: boolean; loading: boolean; terminals: DashboardWorkspaceTerminalInfo[]; agents: DashboardCliSessionSummary[];
  editedFiles: number; dirtyFiles: number;
  onRefresh: () => void; onOpen: (tab: WorkspaceToolTab, path?: string) => void;
}) {
  const environment = props.environment;
  const runningAgents = props.agents.filter(agent => agent.status === 'running').length;
  const unknownAgents = props.agents.filter(agent => agent.status === 'unknown').length;
  const projectTerminals = props.terminals.filter(terminal => terminal.cwd && props.projectPath && canonicalWebPath(terminal.cwd) === canonicalWebPath(props.projectPath));
  const detail = (label: string, value?: string | number) => <div><dt>{label}</dt><dd title={String(value ?? '')}>{value ?? 'Unavailable'}</dd></div>;
  return <section class="cli-inspector-view" aria-label="Environment" aria-busy={props.loading}>
    <header class="cli-inspector-heading"><EmptyFolderIcon /><span><strong>{environment?.projectName || projectDisplayName(props.projectPath ?? '') || 'Workspace'}</strong><small>{props.systemName}</small></span><IconButton label="Refresh Environment" disabled={props.loading || !props.connected || !props.projectPath} onClick={props.onRefresh}><RefreshIcon /></IconButton></header>
    <div class="cli-inspector-body">
      {environment?.warning ? <p role="status">{environment.warning}</p> : null}
      <section><h3>Project</h3><dl>{detail('Folder', props.projectPath || 'No project selected')}{detail('System', props.systemName)}{detail('Connection', props.connected ? 'Connected' : 'Offline · saved view')}{environment?.availability ? detail('Folder status', environment.availability === 'missing' ? 'Missing on this system' : 'Unavailable on this system') : null}{detail('Repository', environment?.availability ? 'Not verified' : environment ? environment.isGitRepository ? 'Git' : 'No Git repository' : props.loading ? 'Loading…' : 'Not verified')}</dl></section>
      <section><h3>Session</h3><dl>{detail('Status', !props.session ? 'No session selected' : props.session.archived ? 'Archived' : props.session.status === 'unknown' ? 'Not verified' : props.session.status === 'running' ? 'Running' : props.session.interrupted ? 'Interrupted' : 'Ready')}{detail('Model', props.session?.model)}{detail('Reasoning', props.session?.reasoningEffort)}{detail('Surface', props.session?.sessionSurface)}{detail('Updated', props.session?.updatedAt ? formatTime(props.session.updatedAt) : undefined)}{detail('Goal', props.session?.goal?.status ?? 'None')}{detail('Auto Resume', props.autoResumeEnabled ? 'Enabled' : 'Disabled')}{detail('Queue', props.session?.queueEnabled ? `Priority ${props.session.queuePriority ?? 3}` : 'Not queued')}</dl></section>
      {environment?.isGitRepository ? <section><h3>Repository</h3><dl>{detail('Branch', environment.branch)}{detail('Tracking', environment.upstream ?? 'No upstream')}{detail('Changes', environment.changes)}{detail('Ahead / behind', `${environment.ahead} / ${environment.behind}`)}</dl></section> : null}
      <section><h3>Tools overview</h3><div class="cli-inspector-shortcuts"><button type="button" aria-label="Open Git" disabled={Boolean(environment?.availability)} onClick={() => props.onOpen('git')}><ForkIcon /><span>Git</span><small>{environment?.availability ? 'Folder unavailable' : environment ? environment.isGitRepository ? `${environment.changes} changed` : 'No repository' : 'Not verified'}</small></button><button type="button" disabled={Boolean(environment?.availability)} onClick={() => props.onOpen('files')}><FileIcon /><span>Files</span><small>{props.editedFiles} recorded edits{props.dirtyFiles ? ` · ${props.dirtyFiles} unsaved` : ''}</small></button><button type="button" disabled={Boolean(environment?.availability)} onClick={() => props.onOpen('terminal')}><TerminalIcon /><span>Terminals</span><small>{projectTerminals.length} project · {props.terminals.length} observed</small></button><button type="button" onClick={() => props.onOpen('agents')}><ForkIcon /><span>Agents</span><small>{props.agents.length} recorded · {runningAgents} running{unknownAgents ? ` · ${unknownAgents} unknown` : ''}</small></button><button type="button" onClick={() => props.onOpen('reviews')}><ReviewIcon /><span>Reviews</span><small>{props.editedFiles} recorded files</small></button></div></section>
      {props.agents.length ? <section><h3>Agents</h3><div class="cli-inspector-shortcuts">{props.agents.slice(0, 3).map(agent => <button type="button" key={cliSessionTargetKey(agent)} title={agent.title} onClick={() => props.onOpen('agents', agent.id)}><ForkIcon /><span>{agent.agentName ?? agent.title}</span><small>{agent.status === 'running' ? 'Running' : agent.status === 'unknown' ? 'Not verified' : 'Ready'}</small></button>)}{props.agents.length > 3 ? <button type="button" onClick={() => props.onOpen('agents')}>View all {props.agents.length} agents</button> : null}</div></section> : null}
    </div>
  </section>;
}

export type ConsolidatedSessionItem = DashboardCliSessionMessage | {
  id: string;
  messages: DashboardCliSessionMessage[];
};

export function getCompletedTurnCopyText(messages: DashboardCliSessionMessage[], currentTurnRunning = false): Map<string, string> {
  const completed = new Map<string, string>();
  let assistantTexts: string[] = [];
  let lastAssistantMessageId: string | undefined;
  const completeTurn = (): void => {
    if (lastAssistantMessageId && assistantTexts.length > 0) completed.set(lastAssistantMessageId, assistantTexts.join("\n\n"));
    assistantTexts = [];
    lastAssistantMessageId = undefined;
  };
  for (const message of messages) {
    if (message.role === "user" && (!message.kind || message.kind === "message")) completeTurn();
    else if (message.role === "assistant" && (!message.kind || message.kind === "message") && message.text.trim()) {
      assistantTexts.push(message.text.trim());
      lastAssistantMessageId = message.id;
    }
  }
  if (!currentTurnRunning) completeTurn();
  return completed;
}

export function consolidateSessionMessages(messages: DashboardCliSessionMessage[]): ConsolidatedSessionItem[] {
  const result: ConsolidatedSessionItem[] = [];
  let turn: DashboardCliSessionMessage[] = [];
  const flushTurn = (): void => {
    const latestThinking = turn.length - 1 - [...turn].reverse().findIndex((message) => message.kind === "reasoning" && message.status === "inProgress");
    let adjacent: DashboardCliSessionMessage[] = [];
    const flushGroup = (): void => {
      if (adjacent.length) result.push({ id: `activity-group-${adjacent[0]!.id}`, messages: adjacent });
      adjacent = [];
    };
    turn.forEach((message, index) => {
      if (message.kind === "reasoning" && index !== latestThinking) return;
      if (isGroupableTurnActivity(message) && message.status !== "inProgress") {
        adjacent.push(message);
      } else {
        flushGroup();
        result.push(message);
      }
    });
    flushGroup();
    turn = [];
  };
  for (const message of messages) {
    if ((!message.kind || message.kind === "message") && message.role === "user") {
      flushTurn();
      result.push(message);
    } else turn.push(message);
  }
  flushTurn();
  return result;
}

type CompletedTranscriptTurn = { id: string; items: ConsolidatedSessionItem[]; answer: DashboardCliSessionMessage; startedAt?: string };

export function groupCompletedTurns(items: ConsolidatedSessionItem[], running: boolean): Array<ConsolidatedSessionItem | CompletedTranscriptTurn> {
  const result: Array<ConsolidatedSessionItem | CompletedTranscriptTurn> = [];
  let turn: ConsolidatedSessionItem[] = [];
  let startedAt: string | undefined;
  const flush = (active: boolean): void => {
    const answer = turn.at(-1);
    if (!active && !turn.some((item) => ("messages" in item ? item.messages : [item]).some((message) => message.status === "inProgress")) && turn.length > 1 && answer && !("messages" in answer) && answer.role === "assistant" && (!answer.kind || answer.kind === "message")) {
      result.push({ id: `completed-turn-${turn[0]!.id}`, items: turn.slice(0, -1), answer, startedAt });
    } else result.push(...turn);
    turn = [];
  };
  for (const item of items) {
    if (!("messages" in item) && item.role === "user" && (!item.kind || item.kind === "message")) {
      flush(false);
      result.push(item);
      startedAt = item.timestamp;
    } else turn.push(item);
  }
  flush(running);
  return result;
}

export function summarizeTurnChanges(messages: DashboardCliSessionMessage[], turnId?: string) {
  const matched = turnId ? messages.findIndex((message) => message.turnId === turnId) : -1;
  const turnStart = matched >= 0 ? matched : messages.length - 1 - [...messages].reverse().findIndex((message) => message.role === "user" && (!message.kind || message.kind === "message"));
  const summary = activitySummary(messages.slice(turnStart >= messages.length ? 0 : Math.max(0, turnStart)));
  return summary?.files ? summary : undefined;
}

export function parseDiffLines(diff: string) {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
      return { text, kind: "meta", oldLine: undefined, newLine: undefined };
    }
    if (text.startsWith("diff --git")) { oldLine = 0; newLine = 0; inHunk = false; }
    if ((!inHunk && /^(?:diff --git|index |--- |\+\+\+ |@@)/.test(text)) || text.startsWith("\\ No newline")) return { text, kind: "meta", oldLine: undefined, newLine: undefined };
    if (text.startsWith("+")) return { text, kind: "added", oldLine: undefined, newLine: inHunk ? newLine++ : undefined };
    if (text.startsWith("-")) return { text, kind: "removed", oldLine: inHunk ? oldLine++ : undefined, newLine: undefined };
    return { text, kind: "context", oldLine: inHunk ? oldLine++ : undefined, newLine: inHunk ? newLine++ : undefined };
  });
}

export function summarizeChangedFiles(messages: DashboardCliSessionMessage[]) {
  const files = new Map<string, { path: string; additions: number; deletions: number }>();
  for (const change of messages.flatMap((message) => message.changes ?? [])) {
    const file = files.get(change.path) ?? { path: change.path, additions: 0, deletions: 0 };
    for (const line of parseDiffLines(change.diff ?? "")) {
      if (line.kind === "added") file.additions++;
      else if (line.kind === "removed") file.deletions++;
    }
    files.set(change.path, file);
  }
  return [...files.values()];
}

function DiffPreview({ diff }: { diff: string }) {
  const lines = useMemo(() => parseDiffLines(diff), [diff]);
  return <div class="cli-code-surface cli-diff-surface"><div class="cli-code-surface-head"><span>Diff</span><CopySnippet text={diff} label="Copy diff" /></div><pre class="cli-activity-output is-diff"><code>{lines.map((line, index) => <span key={index} class={`cli-diff-line is-${line.kind}`}><span class="cli-diff-line-number" aria-hidden="true" title={`Old: ${line.oldLine ?? "—"} · New: ${line.newLine ?? "—"}`}>{line.newLine ?? line.oldLine ?? ""}</span><span>{line.text || " "}</span></span>)}</code></pre></div>;
}

function CompletedTurn({ turn, logoUri, onActionFeedback, onDraftMessage, onRetryPrompt, onOpenFile, onOpenReviews }: { turn: CompletedTranscriptTurn; onRetryPrompt?: () => void; logoUri?: string; onActionFeedback: (notice: DashboardNotice) => void; onDraftMessage?: (text: string, quote: boolean) => void; onOpenFile?: (path: string) => void; onOpenReviews?: (path?: string) => void }) {
  const messages = turn.items.flatMap((item) => "messages" in item ? item.messages : [item]);
  const start = Date.parse(turn.startedAt ?? messages.find((message) => message.timestamp)?.timestamp ?? "");
  const end = Date.parse(turn.answer.timestamp ?? messages.filter((message) => message.timestamp).at(-1)?.timestamp ?? "");
  const duration = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
  const turnCopy = [...messages, turn.answer].filter((message) => message.role === "assistant" && (!message.kind || message.kind === "message")).map((message) => message.text).join("\n\n");
  return <div class="cli-completed-turn">
    <details class="cli-completed-work"><summary><span>{duration !== undefined ? `Worked for ${formatDuration(duration)}` : "Worked"}</span><ChevronIcon /></summary><div class="cli-completed-work-body">{turn.items.map((item) => "messages" in item ? <ActivityGroup key={item.id} messages={item.messages} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} /> : <SessionMessage key={item.id} message={item} logoUri={logoUri} onActionFeedback={onActionFeedback} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} />)}</div></details>
    <SessionMessage message={turn.answer} logoUri={logoUri} turnCopyText={turnCopy} onRetryPrompt={onRetryPrompt} onActionFeedback={onActionFeedback} onDraftMessage={onDraftMessage} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} />
    {onOpenReviews ? <CompletedTurnChanges messages={messages} onOpenReviews={onOpenReviews} /> : null}
  </div>;
}

/** One transcript renderer; public views omit callbacks for private operations. */
export function SessionTranscript({ messages, running = false, logoUri, onActionFeedback, onRetryPrompt, onDraftMessage, onOpenFile, onOpenReviews }: { messages: DashboardCliSessionMessage[]; running?: boolean; logoUri?: string; onActionFeedback: (notice: DashboardNotice) => void; onRetryPrompt?: (id: string) => void; onDraftMessage?: (text: string, quote: boolean) => void; onOpenFile?: (path: string) => void; onOpenReviews?: (path?: string) => void }) {
  const items = useMemo(() => groupCompletedTurns(consolidateSessionMessages(messages), running), [messages, running]);
  const copies = useMemo(() => getCompletedTurnCopyText(messages, running), [messages, running]);
  return <>{items.map(item => 'items' in item ? <CompletedTurn key={item.id} turn={item} logoUri={logoUri} onActionFeedback={onActionFeedback} onRetryPrompt={onRetryPrompt ? () => onRetryPrompt(item.answer.id) : undefined} onDraftMessage={onDraftMessage} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews}/> : 'messages' in item ? <ActivityGroup key={item.id} messages={item.messages} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews}/> : <SessionMessage key={item.id} message={item} logoUri={logoUri} turnCopyText={copies.get(item.id)} onActionFeedback={onActionFeedback} onRetryPrompt={onRetryPrompt ? () => onRetryPrompt(item.id) : undefined} onDraftMessage={onDraftMessage} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews}/>)}</>;
}

function CompletedTurnChanges({ messages, onOpenReviews }: { messages: DashboardCliSessionMessage[]; onOpenReviews: (path?: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const files = useMemo(() => summarizeChangedFiles(messages), [messages]);
  if (!files.length) return null;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return <section class="cli-completed-changes" aria-label="Edited files"><header><FileIcon /><span><strong>Edited {files.length} file{files.length === 1 ? "" : "s"}</strong><small><b class="is-added">+{additions}</b> <b class="is-removed">−{deletions}</b></small></span><button type="button" onClick={() => onOpenReviews()}>View changes</button></header><div>{(expanded ? files : files.slice(0, 3)).map((file) => <button type="button" key={file.path} class="cli-completed-file" title={file.path} onClick={() => onOpenReviews(file.path)}><span>{file.path}</span><span><b class="is-added">+{file.additions}</b> <b class="is-removed">−{file.deletions}</b></span></button>)}</div>{files.length > 3 ? <button type="button" class="cli-show-more-files" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show fewer files" : `Show ${files.length - 3} more file${files.length - 3 === 1 ? "" : "s"}`}<ChevronIcon /></button> : null}</section>;
}


function isTurnActivity(message: DashboardCliSessionMessage): boolean {
  return message.kind === "reasoning"
    || message.kind === "plan"
    || message.kind === "command"
    || message.kind === "file-change"
    || message.kind === "tool-call"
    || message.kind === "collaboration"
    || message.kind === "web-search"
    || message.kind === "image"
    || message.kind === "review"
    || message.kind === "compaction";
}

function isGroupableTurnActivity(message: DashboardCliSessionMessage): boolean {
  // Image activities stay as their own rich preview card; tool/command/file
  // activity from the same turn is consolidated behind one disclosure.
  return isTurnActivity(message) && message.kind !== "reasoning" && message.kind !== "image" && message.kind !== "collaboration";
}

function ActivityGroup({ messages, onOpenFile, onOpenReviews }: { messages: DashboardCliSessionMessage[]; onOpenFile?: (filePath: string) => void; onOpenReviews?: (filePath?: string) => void }) {
  const running = messages.some((message) => message.status === "inProgress");
  const [expanded, setExpanded] = useState(running);
  useLayoutEffect(() => setExpanded(running), [running]);
  const summary = activitySummary(messages);
  const incomplete = messages.find((message) => message.status && !["completed", "inProgress", "failed"].includes(message.status))?.status;
  return <div class={`cli-activity-group ${running ? "is-running" : ""}`}>
    <details class="cli-activity-group-details" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary title={consolidatedActivityLabel(messages)}>
      <span class="cli-activity-icon"><ToolIcon /></span>
      <span class="cli-activity-heading"><strong>{consolidatedActivityLabel(messages)}</strong>{summary?.files ? <small><b class="is-added">+{summary.additions}</b> <b class="is-removed">−{summary.deletions}</b></small> : null}</span>
      <span class={`cli-activity-status ${running ? "is-inProgress" : incomplete ? "is-" + incomplete : "is-completed"}`}>{running ? <i /> : incomplete ? capitalize(incomplete) : <CheckIcon />}</span>
      <ChevronIcon />
    </summary>
    <div class="cli-activity-group-body">{messages.map((message) => message.kind === "file-change" && message.changes?.length && (!message.status || message.status === "completed") ? <FileChangeDetails key={message.id} changes={message.changes} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} /> : <ActivityMessage key={message.id} message={message} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} />)}</div>
    </details>
  </div>;
}

function activitySummary(messages: DashboardCliSessionMessage[]): { files: number; additions: number; deletions: number; label: string; detail?: string } | undefined {
  const changes = summarizeChangedFiles(messages);
  if (changes.length > 0) {
    let additions = 0;
    let deletions = 0;
    for (const change of changes) { additions += change.additions; deletions += change.deletions; }
    return { files: changes.length, additions, deletions, label: "Files changed" };
  }
  return undefined;
}

export function consolidatedActivityLabel(messages: DashboardCliSessionMessage[]): string {
  const counts = new Map<DashboardCliSessionMessage["kind"], number>();
  for (const message of messages) counts.set(message.kind, (counts.get(message.kind) ?? 0) + 1);
  const labels = [...counts].map(([kind, count]) => {
    switch (kind) {
      case "plan": return count === 1 ? "updated the plan" : `updated ${count} plans`;
      case "file-change": { const files = summarizeChangedFiles(messages).length || count; return files === 1 ? "edited a file" : "edited " + files + " files"; }
      case "command": return count === 1 ? "ran a command" : `ran ${count} commands`;
      case "tool-call": return count === 1 ? "used a tool" : `used ${count} tools`;
      case "collaboration": return count === 1 ? "worked with an agent" : `worked with ${count} agents`;
      case "web-search": return count === 1 ? "searched the web" : `searched the web ${count} times`;
      case "image": return count === 1 ? "viewed an image" : `viewed ${count} images`;
      case "review": return count === 1 ? "reviewed changes" : `reviewed changes ${count} times`;
      case "compaction": return count === 1 ? "compacted context" : `compacted context ${count} times`;
      default: return activityTitle(kind).toLowerCase();
    }
  });
  const label = labels.join(", ");
  return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : "Activity";
}

function WorkspaceContextPanel(props: {
  targetDeviceId?: string;
  workspaceGitPending?: boolean;
  workspaceGitNotice?: string;
  onWorkspaceGitPending: (pending: boolean, message?: string, committedDraft?: string) => void;
  connected?: boolean;
  projectPath?: string;
  session?: DashboardCliSessionSummary;
  systemName: string;
  autoResumeEnabled: boolean;
  environment?: DashboardWorkspaceEnvironment;
  environmentLoading: boolean;
  commitDraft: string;
  gitPending?: 'commit' | 'push';
  gitNotice?: DashboardNotice;
  onCommitDraft: (value: string) => void;
  onCommit: () => void;
  onPush: () => void;
  onRefreshEnvironment: (history?: DashboardWorkspaceGitRequest) => void;
  onBranchReview: () => void;
  scopeKey: string;
  fileDrafts: Record<string, WorkspaceFileDraft>;
  fileNotice?: DashboardNotice;
  onFileDraft: (path: string, text: string) => void;
  terminalWidth: number;
  draft: string;
  results: DashboardWorkspaceTerminalResult[];
  liveOutputs: DashboardWorkspaceTerminalOutput[];
  terminals: DashboardWorkspaceTerminalInfo[];
  running: boolean;
  stopping: boolean;
  collapsed: boolean;
  onCollapse: () => void;
  tabs: WorkspaceTab[];
  activeTab: WorkspaceTab;
  addOpen: boolean;
  files: DashboardWorkspaceFileEntry[];
  filesByPath: Record<string, DashboardWorkspaceFile>;
  fileChanges: Array<{ path: string; diff?: string }>;
  branchReview: boolean;
  branchEnvironment?: DashboardWorkspaceEnvironment;
  comparisonLoading: boolean;
  onCompareBranch: () => void;
  onShowTurnReview: () => void;
  agents: DashboardCliSessionMessage[];
  agentSessions: DashboardCliSessionSummary[];
  agentMessages: Record<string, { messages?: DashboardCliSessionMessage[]; error?: string; loading?: boolean }>;
  onReadAgent?: (agent: DashboardCliSessionSummary) => void;
  filesLoading: boolean;
  fileLoading: boolean;
  fileSaving: boolean;
  onDraft: (value: string) => void;
  onRun: (command: string, terminalId?: string) => void;
  onListTerminals: () => void;
  onCreateTerminal: (profile: "default" | "powershell" | "cmd" | "bash") => void;
  onFocusTerminal: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onFeedback: (notice: DashboardNotice) => void;
  onStop: () => void;
  onClear: () => void;
  onTab: (tab: WorkspaceTab) => void;
  onAddToggle: () => void;
  onAdd: (tab: WorkspaceToolTab, filePath?: string) => void;
  onCloseTab: (tab: WorkspaceTab) => void;
  onListFiles: () => void;
  onReadFile: (filePath: string) => void;
  onClearFile: () => void;
  onDeleteFile: (filePath: string) => void;
  onSaveFile: (filePath: string, content: string, revision: string) => void;
  onResizePointerDown: (event: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => void;
  onResizeReset: () => void;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLSpanElement>(null);
  const addPanelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useAnchoredPopover(props.addOpen && !props.collapsed, addMenuRef, addPanelRef, 'start');
  useLayoutEffect(() => {
    if (!props.addOpen || props.collapsed) return;
    const panel = addPanelRef.current;
    if (!panel) return;
    panel.showPopover?.();
    panel.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent): void => { if (!addMenuRef.current?.contains(event.target as Node)) props.onAddToggle(); };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onAddToggle(); addMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
      else if (panel.contains(document.activeElement) && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { if (panel.isConnected) panel.hidePopover?.(); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [props.addOpen, props.collapsed]);
  useEffect(() => {
    const activeTab = tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    activeTab?.closest("span")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeTab, props.tabs.length]);
  if (props.collapsed) return <aside class="cli-terminal-panel is-collapsed" aria-hidden="true" />;
  const activeKind = workspaceTabKind(props.activeTab);
  const activePath = workspaceTabPath(props.activeTab);
  return <aside class="cli-terminal-panel cli-context-panel-v3" aria-label="Workspace tools">
    <div class="cli-context-edge-resizer" role="separator" aria-label="Resize terminal panel" aria-orientation="vertical" aria-valuemin={280} aria-valuenow={Math.round(props.terminalWidth)} tabIndex={0} onPointerDown={props.onResizePointerDown} onKeyDown={props.onResizeKeyDown} onDblClick={props.onResizeReset}><span /></div>
    <header class="cli-context-tabbar"><div class="cli-context-tabs-v3" role="tablist" onKeyDown={handleTabKeyDown} aria-label="Workspace tools"><div ref={tabsRef} class="cli-context-tab-scroll" onWheel={event => { const target = event.currentTarget; if (target.scrollWidth <= target.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return; event.preventDefault(); target.scrollLeft += event.deltaY; }}>{props.tabs.map((tab, index) => {
      const kind = workspaceTabKind(tab), path = workspaceTabPath(tab);
      const label = kind === 'env' ? 'Env' : kind === 'git' ? 'Git' : kind === 'agents' && path ? `Agent: ${props.agentSessions.find(agent => agent.id === path)?.agentName ?? path.slice(0, 8)}` : path ? path.split(/[\\/]/).pop() ?? path : capitalize(kind);
      return <span class={props.activeTab === tab ? 'is-active' : ''} key={tab}><button type="button" role="tab" id={`${panelId}-tab-${index}`} aria-controls={`${panelId}-body`} tabIndex={props.activeTab === tab ? 0 : -1} aria-selected={props.activeTab === tab} onClick={() => props.onTab(tab)} title={kind === 'env' ? 'Environment' : path ?? label}>{kind === 'terminal' ? <TerminalIcon /> : kind === 'files' ? <FileIcon /> : kind === 'agents' || kind === 'git' ? <ForkIcon /> : kind === 'env' ? <PanelIcon /> : <ReviewIcon />}<span class="cli-context-tab-label">{label}</span></button>{tab !== 'env' ? <button type="button" aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => props.onCloseTab(tab)}><CloseIcon /></button> : null}</span>;
    })}</div><span ref={addMenuRef} class="cli-context-add-wrap"><button type="button" class="cli-context-add" aria-label="Add workspace tool" title="Add a workspace tool" aria-haspopup="menu" aria-expanded={props.addOpen} onClick={props.onAddToggle}><PlusIcon /></button>{props.addOpen ? <div ref={addPanelRef} popover="manual" class="cli-context-add-menu" role="menu" aria-label="Workspace tools menu">{(['git', 'terminal', 'files', 'reviews', 'agents'] as const).filter(tab => !props.tabs.includes(tab)).map(tab => <button type="button" role="menuitem" onClick={() => props.onAdd(tab)}>{tab === 'git' || tab === 'agents' ? <ForkIcon /> : tab === 'terminal' ? <TerminalIcon /> : tab === 'files' ? <FileIcon /> : <ReviewIcon />}<span>{capitalize(tab)}</span></button>)}{(['git', 'terminal', 'files', 'reviews', 'agents'] as const).every(tab => props.tabs.includes(tab)) ? <span>All tools are open</span> : null}</div> : null}</span></div><IconButton label="Close workspace tools" onClick={props.onCollapse}><CloseIcon /></IconButton></header>
    <div class="cli-context-body" id={`${panelId}-body`} role="tabpanel" aria-labelledby={`${panelId}-tab-${props.tabs.indexOf(props.activeTab)}`}>
    {props.activeTab === 'env' ? <WorkspaceEnvironmentView autoResumeEnabled={props.autoResumeEnabled} systemName={props.systemName} environment={props.environment} session={props.session} projectPath={props.projectPath} connected={props.connected !== false} loading={props.environmentLoading} terminals={props.terminals} agents={props.agentSessions} editedFiles={props.fileChanges.length} dirtyFiles={Object.entries(props.fileDrafts).filter(([path, draft]) => draft.text !== props.filesByPath[path]?.content).length} onRefresh={() => props.onRefreshEnvironment()} onOpen={props.onAdd} /> : props.activeTab === 'git' ? <WorkspaceGit key={props.scopeKey} draft={props.commitDraft} onDraft={props.onCommitDraft} pending={props.workspaceGitPending} notice={props.workspaceGitNotice} onPending={props.onWorkspaceGitPending} projectPath={props.projectPath} targetDeviceId={props.targetDeviceId} connected={props.connected !== false} onOpenFile={path => props.onAdd('files', path)} renderDiff={diff => <DiffPreview diff={diff} />} /> : null}
    {props.tabs.includes(props.activeTab) && activeKind === "agents" ? <AgentWorkspace sessions={props.agentSessions} data={props.agentMessages} activeId={activePath} onRefresh={props.onReadAgent} onFeedback={props.onFeedback} /> : props.tabs.includes(props.activeTab) && props.activeTab === "terminal" ? <WorkspaceTerminal key={props.scopeKey} projectPath={props.projectPath} targetDeviceId={props.targetDeviceId} connected={props.connected !== false} terminals={props.terminals} onList={props.onListTerminals} onFocus={props.onFocusTerminal} /> : props.tabs.includes(props.activeTab) && activeKind === "files" ? <WorkspaceFilesView key={props.scopeKey} drafts={props.fileDrafts} notice={props.fileNotice} onDraft={props.onFileDraft} connected={props.connected} files={props.files} file={activePath ? Object.values(props.filesByPath).find((candidate) => canonicalWebPath(candidate.path) === canonicalWebPath(activePath)) : undefined} activePath={activePath} loading={props.filesLoading} fileLoading={props.fileLoading} saving={props.fileSaving} onRefresh={props.onListFiles} onOpenFile={(filePath) => props.onAdd("files", filePath)} onDeleteFile={props.onDeleteFile} onClearFile={props.onClearFile} onFeedback={props.onFeedback} onSave={props.onSaveFile} /> : props.tabs.includes(props.activeTab) && activeKind === "reviews" ? props.branchReview && !activePath ? <BranchComparison environment={props.branchEnvironment} loading={props.comparisonLoading} onRefresh={props.onCompareBranch} onShowTurnReview={props.onShowTurnReview} /> : <WorkspaceReviewsView changes={props.fileChanges} agents={props.agents} activePath={activePath} onOpenFile={(filePath) => props.onAdd("files", filePath)} onOpenReview={(filePath) => props.onAdd("reviews", filePath)} onFeedback={props.onFeedback} /> : null}
    </div>
  </aside>;
}

function BranchComparison(props: { environment?: DashboardWorkspaceEnvironment; loading: boolean; onRefresh: () => void; onShowTurnReview: () => void }) {
  const diff = props.environment?.branchDiff;
  return <div class="cli-reviews-view cli-branch-comparison"><header><ReviewIcon /><span><strong>Compare branch</strong><small>{props.environment?.branchDiffBase ? `Against ${props.environment.branchDiffBase}` : "Git comparison"}</small></span><IconButton label="Show turn changes" onClick={props.onShowTurnReview}><ReviewIcon /></IconButton><IconButton label="Refresh comparison" disabled={props.loading} onClick={props.onRefresh}><RefreshIcon /></IconButton></header>{props.loading ? <div class="cli-context-empty" role="status"><span class="cli-live-spinner" />Comparing branch…</div> : diff !== undefined ? <>{props.environment?.branchDiffTruncated ? <p role="status">Preview limited. Open the repository in VS Code for the full diff.</p> : null}{diff.trim() ? <DiffPreview diff={diff} /> : <div class="cli-context-empty" role="status">No tracked differences from {props.environment?.branchDiffBase ?? "the comparison base"}.</div>}</> : <div class="cli-context-empty" role="status">Comparison unavailable. Use Refresh comparison to retry.</div>}</div>;
}

export function AgentWorkspace(props: { connected?: boolean; sessions: DashboardCliSessionSummary[]; data: Record<string, { messages?: DashboardCliSessionMessage[]; error?: string; loading?: boolean }>; activeId?: string; onRefresh?: (agent: DashboardCliSessionSummary, automatic?: boolean) => void; onFeedback: (notice: DashboardNotice) => void }) {
  const [activeId, setActiveId] = useState(props.activeId);
  useEffect(() => setActiveId(props.activeId), [props.activeId]);
  const agent = props.sessions.find(item => item.id === activeId);
  const state = agent ? props.data[cliSessionTargetKey(agent)] : undefined;
  const name = (item: DashboardCliSessionSummary) => item.agentName || item.model || 'Agent';
  useEffect(() => {
    if (agent && props.connected !== false && document.visibilityState === 'visible' && navigator.onLine) props.onRefresh?.(agent, true);
  }, [agent?.id, agent?.deviceId, agent?.status, agent?.updatedAt, props.connected]);
  return <div class="cli-agent-workspace">
    <div class="cli-agent-tabs" role="tablist" aria-label="Agent views" onKeyDown={handleTabKeyDown}>
      <button type="button" role="tab" aria-selected={!activeId} onClick={() => setActiveId(undefined)}>All agents <small>{props.sessions.length}</small></button>
      {agent ? <button type="button" role="tab" aria-selected="true" title={name(agent)}>{name(agent)}</button> : null}
    </div>
    {activeId ? agent ? <>
      <header><span class={`cli-state-pill ${agent.status === 'running' ? 'is-running' : ''}`}>{agent.status === 'running' ? 'Running' : agent.interrupted ? 'Interrupted' : agent.status === 'unknown' ? 'Unverified' : 'Idle'}</span><small>{[agent.model, agent.reasoningEffort].filter(Boolean).join(' · ')}</small>{props.onRefresh ? <button type="button" disabled={state?.loading || props.connected === false} onClick={() => props.onRefresh?.(agent, false)}>Refresh</button> : null}</header>
      {state?.error ? <div role="alert" class="cli-agent-error">{state.error}</div> : null}
      {state?.loading ? <div role="status" class="settings-note">Refreshing agent messages…</div> : null}
      <div class="cli-agent-transcript">{state?.messages?.map(message => <SessionMessage key={message.id} message={message} onActionFeedback={props.onFeedback} />)}{!state?.loading && !state?.error && !state?.messages?.length ? <p class="settings-note">{props.connected === false ? 'Reconnect to load this agent’s messages.' : 'No messages recorded yet.'}</p> : null}</div>
    </> : <p class="settings-note">This agent is no longer in the session list. Refresh sessions to reconnect.</p> : <div class="cli-agent-roster">{props.sessions.length ? props.sessions.map(item => <button type="button" class={`cli-agent-row ${!item.subAgent && !item.parentSessionId ? 'is-main' : ''}`} key={cliSessionTargetKey(item)} title={item.title} onClick={() => setActiveId(item.id)}>
      <ForkIcon /><span><strong>{name(item)}</strong><small>{[!item.subAgent && !item.parentSessionId ? 'Main' : undefined, item.model !== name(item) ? item.model : undefined, item.reasoningEffort].filter(Boolean).join(' · ') || item.title}</small></span><span class="cli-agent-state">{item.status === 'running' ? <span class="cli-session-spinner" aria-label="Running" /> : null}{item.status === 'running' ? 'Running' : item.interrupted ? 'Interrupted' : item.status === 'unknown' ? 'Unverified' : 'Idle'}</span>
    </button>) : <p class="settings-note">No agents recorded for this session.</p>}</div>}
  </div>;
}

function WorkspaceFilesView(props: {
  connected?: boolean;
  drafts: Record<string, WorkspaceFileDraft>;
  notice?: DashboardNotice;
  onDraft: (path: string, text: string) => void;
  files: DashboardWorkspaceFileEntry[];
  file?: DashboardWorkspaceFile;
  activePath?: string;
  loading: boolean;
  fileLoading: boolean;
  saving: boolean;
  onRefresh: () => void;
  onOpenFile: (filePath: string) => void;
  onDeleteFile: (filePath: string) => void;
  onClearFile: () => void;
  onFeedback: (notice: DashboardNotice) => void;
  onSave: (filePath: string, content: string, revision: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [documentModes, setDocumentModes] = useState<Record<string, "edit" | "preview">>({});
  const [imageOpen, setImageOpen] = useState(false);
  const imageAccessibility = useModalAccessibility(imageOpen, () => setImageOpen(false));
  const cutSelectionRef = useRef<(() => Promise<boolean>)>();
  const [canCut, setCanCut] = useState(false);
  const [fileMenu, setFileMenu] = useState<{ entry: DashboardWorkspaceFileEntry; x: number; y: number }>();
  const [deleteTarget, setDeleteTarget] = useState<DashboardWorkspaceFileEntry>();
  useEffect(() => {
    setCollapsed((current) => {
      const next = { ...current };
      for (const entry of props.files) if (entry.type === "directory" && next[entry.path] === undefined) next[entry.path] = true;
      return next;
    });
  }, [props.files]);
  useEffect(() => {
    if (!fileMenu) return;
    const close = (): void => setFileMenu(undefined);
    document.addEventListener("click", close);
    document.addEventListener("scroll", close, true);
    return () => { document.removeEventListener("click", close); document.removeEventListener("scroll", close, true); };
  }, [fileMenu]);
  const hiddenByParent = (entry: DashboardWorkspaceFileEntry): boolean => {
    const segments = entry.path.split("/");
    return segments.slice(0, -1).some((_segment, index) => collapsed[segments.slice(0, index + 1).join("/")]);
  };
  const currentPath = props.activePath;
  const fileReady = Boolean(currentPath && props.file?.path && canonicalWebPath(props.file.path) === canonicalWebPath(currentPath));
  const fileDraft = props.file ? props.drafts[props.file.path] : undefined;
  const draft = fileReady ? fileDraft?.text ?? props.file?.content ?? '' : '';
  const revision = fileDraft?.revision ?? props.file?.revision ?? '';
  const dirty = Boolean(fileReady && currentPath && props.file?.kind === "text" && draft !== props.file.content);
  const markdownPreview = Boolean(fileReady && props.file?.language === "markdown" && (documentModes[props.file.path] ?? "preview") === "preview");
  const openFile = (path: string): void => {
    props.onOpenFile(path);
  };
  return <>{props.notice ? <div class={`cli-inspector-notice is-${props.notice.level}`} role={props.notice.level === "error" ? "alert" : "status"}>{props.notice.message}</div> : null}<div class={currentPath ? "cli-files-workbench is-detail" : "cli-files-workbench is-list"}>
    {currentPath ? null : <div class="cli-file-tree"><header><strong>Project files</strong><IconButton label="Refresh files" disabled={props.loading} onClick={props.onRefresh}><RefreshIcon /></IconButton></header>{props.loading && props.files.length === 0 ? <span class="cli-context-loading">Loading files…</span> : props.files.filter((entry) => !hiddenByParent(entry)).map((entry) => entry.type === "directory" ? <button type="button" class="is-directory" style={`--tree-depth:${entry.depth}`} onContextMenu={(event) => { event.preventDefault(); setFileMenu({ entry, x: event.clientX, y: event.clientY }); }} onClick={() => setCollapsed((current) => ({ ...current, [entry.path]: !current[entry.path] }))}><ChevronIcon /><EmptyFolderIcon /><span>{entry.name}</span></button> : <button type="button" class={currentPath === entry.path ? "is-selected" : ""} style={`--tree-depth:${entry.depth}`} onContextMenu={(event) => { event.preventDefault(); setFileMenu({ entry, x: event.clientX, y: event.clientY }); }} onClick={() => openFile(entry.path)}><FileIcon /><span>{entry.name}</span></button>)}</div>}
    {fileMenu ? <WorkspaceContextMenu x={fileMenu.x} y={fileMenu.y} onClose={() => setFileMenu(undefined)}><strong title={fileMenu.entry.path}>{fileMenu.entry.name}</strong>{fileMenu.entry.type === "file" ? <button type="button" role="menuitem" onClick={() => { setFileMenu(undefined); openFile(fileMenu.entry.path); }}><FileIcon /> Open</button> : <button type="button" role="menuitem" onClick={() => { setFileMenu(undefined); setCollapsed((current) => ({ ...current, [fileMenu.entry.path]: !current[fileMenu.entry.path] })); }}><EmptyFolderIcon /> Expand / collapse</button>}<button type="button" role="menuitem" onClick={() => { const selected = fileMenu.entry.path; setFileMenu(undefined); void navigator.clipboard.writeText(selected).then(() => props.onFeedback({ level: "info", message: "File path copied." }), () => props.onFeedback({ level: "error", message: "File path could not be copied." })); }}><LinkIcon /> Copy path</button>{fileMenu.entry.type === "file" ? <button type="button" role="menuitem" class="is-danger" disabled={props.connected === false} onClick={() => { setDeleteTarget(fileMenu.entry); setFileMenu(undefined); }}><TrashIcon /> Delete</button> : null}</WorkspaceContextMenu> : null}
    {deleteTarget ? <DeleteConfirmation compact title={deleteTarget.name} onCancel={() => setDeleteTarget(undefined)} onDelete={() => { const target = deleteTarget; setDeleteTarget(undefined); props.onDeleteFile(target.path); if (target.path === currentPath) props.onClearFile(); }} /> : null}
    {currentPath ? <div class="cli-file-editor">{fileReady && props.file ? <><header><span><strong>{props.file.path}</strong><small>{dirty ? "Modified" : `${props.file.kind === "text" ? props.file.language : props.file.mimeType} · ${formatFileSize(props.file.size)}`}</small></span><span class="cli-file-actions">{props.file.language === "markdown" ? <button type="button" onClick={() => setDocumentModes((current) => ({ ...current, [props.file!.path]: markdownPreview ? "edit" : "preview" }))}>{markdownPreview ? "Edit" : "Preview"}</button> : null}{props.file.kind === "text" && !markdownPreview ? <button type="button" disabled={!canCut || props.fileLoading || props.saving} onClick={() => void cutSelectionRef.current?.()} title="Cut selected code to the clipboard">Cut</button> : null}{props.file.kind === "text" ? <button type="button" disabled={!dirty || props.saving || props.connected === false} onClick={() => props.onSave(props.file!.path, draft, revision)}>{props.saving ? "Saving…" : "Save"}</button> : null}</span></header>{props.file.kind === "image" && props.file.dataUrl ? <figure class="cli-file-image-preview"><button type="button" aria-label={`Preview ${props.file.path}`} onClick={() => setImageOpen(true)}><img src={props.file.dataUrl} alt={props.file.path} /></button><figcaption>{props.file.mimeType} · {formatFileSize(props.file.size)}</figcaption></figure> : props.file.kind === "audio" && props.file.dataUrl ? <div class="cli-file-media-preview"><FileIcon /><audio controls preload="metadata" src={props.file.dataUrl}>Audio preview is not supported by this browser.</audio><small>{props.file.mimeType} · {formatFileSize(props.file.size)}</small></div> : props.file.kind === "video" && props.file.dataUrl ? <div class="cli-file-media-preview is-video"><FileIcon /><video controls preload="metadata" src={props.file.dataUrl}>Video preview is not supported by this browser.</video><small>{props.file.mimeType} · {formatFileSize(props.file.size)}</small></div> : props.file.kind === "pdf" && props.file.dataUrl ? <iframe class="cli-file-pdf-preview" title={`Preview ${props.file.path}`} src={props.file.dataUrl} /> : props.file.kind === "document" ? <iframe class="cli-file-document-preview" title={`Preview ${props.file.path}`} sandbox="" srcDoc={`<!doctype html><meta charset="utf-8"><style>body{max-width:760px;margin:0 auto;padding:32px;color:#24292f;background:#fff;font:15px/1.65 Georgia,serif}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{padding:6px;border:1px solid #d0d7de}</style>${props.file.content}`} /> : markdownPreview ? <MarkdownPreview content={draft} /> : <WorkspaceCodeEditor path={props.file.path} language={props.file.language} value={draft} disabled={props.fileLoading || props.connected === false} onChange={(value) => props.onDraft(props.file!.path, value)} onSave={() => { if (dirty && !props.saving && props.connected !== false) props.onSave(props.file!.path, draft, revision); }} onCutReady={(cut) => { cutSelectionRef.current = cut; setCanCut(Boolean(cut)); }} onSelectionChange={setCanCut} />}</> : <div class="cli-context-empty" role="status"><FileIcon /><span>{props.fileLoading ? "Opening file…" : "File could not be loaded."}</span>{!props.fileLoading ? <button type="button" onClick={() => props.onOpenFile(currentPath)}>Retry</button> : null}</div>}</div> : null}
  </div>{imageOpen && props.file?.kind === "image" && props.file.dataUrl ? <div ref={imageAccessibility.modalRef} class="cli-image-lightbox" role="dialog" aria-modal="true" aria-label={`Preview ${props.file.path}`} tabIndex={-1} onKeyDown={imageAccessibility.onKeyDown} onPointerDown={imageAccessibility.onBackdropPointerDown} onMouseDown={imageAccessibility.onBackdropMouseDown} onClick={imageAccessibility.onBackdropClick}><div class="cli-image-lightbox-toolbar"><strong>{props.file.path}</strong><button type="button" aria-label="Close image preview" onClick={() => setImageOpen(false)}><CloseIcon /></button></div><img src={props.file.dataUrl} alt={props.file.path} /></div> : null}</>;
}


function MarkdownPreview(props: { content: string }) {
  return <article class="cli-markdown-preview"><MarkdownMessage text={props.content} /></article>;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function WorkspaceContextMenu(props: { x: number; y: number; onClose: () => void; children: preact.ComponentChildren }) {
  const panel = useRef<HTMLDivElement>(null);
  const origin = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const point = useRef({ isConnected: true, getBoundingClientRect: () => new DOMRect(props.x, props.y, 0, 0) });
  point.current = { isConnected: true, getBoundingClientRect: () => new DOMRect(props.x, props.y, 0, 0) };
  useAnchoredPopover(true, point, panel, 'start');
  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) props.onClose(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); origin.current?.focus({ preventScroll: true }); }
      if (['ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
        const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        if (!items.length) return;
        event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key, true); };
  }, []);
  return createPortal(<div ref={panel} class="cli-file-context-menu" role="menu" onClick={event => event.stopPropagation()}>{props.children}</div>, document.body);
}

function WorkspaceReviewsView(props: { changes: Array<{ path: string; diff?: string }>; agents: DashboardCliSessionMessage[]; activePath?: string; onOpenFile: (filePath: string) => void; onOpenReview: (filePath: string) => void; onFeedback: (notice: DashboardNotice) => void }) {
  const reviewPaths = props.changes.map((change) => change.path);
  const activeChange = props.changes.find((change) => change.path === props.activePath);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number }>();
  useEffect(() => { if (!menu) return; const close = (): void => setMenu(undefined); document.addEventListener("click", close); return () => document.removeEventListener("click", close); }, [menu]);
  if (props.activePath) return <div class="cli-reviews-view is-detail">{activeChange ? <ReviewComparator change={activeChange} onOpenFile={() => props.onOpenFile(activeChange.path)} /> : <div class="cli-context-empty"><ReviewIcon /><span>This review is no longer available.</span></div>}</div>;
  return <div class="cli-reviews-view"><header><ReviewIcon /><span><strong>Review changes</strong><small>{props.changes.length} changed files · {props.agents.length} agent activities</small></span></header>{reviewPaths.length > 0 ? <div class="cli-review-file-list" role="list" aria-label="Changed files">{reviewPaths.map((path) => <button type="button" role="listitem" onContextMenu={(event) => { event.preventDefault(); setMenu({ path, x: event.clientX, y: event.clientY }); }} onClick={() => props.onOpenReview(path)} title={`Open review for ${path}`}><FileIcon /><span>{path}</span><ChevronIcon /></button>)}</div> : null}{props.agents.map((agent) => <details key={agent.id}><summary><span><ForkIcon /><strong>{agent.title ?? "Agent activity"}</strong></span><ChevronIcon /></summary><p>{agent.text}</p></details>)}{menu ? <WorkspaceContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(undefined)}><strong title={menu.path}>{menu.path}</strong><button type="button" role="menuitem" onClick={() => { setMenu(undefined); props.onOpenReview(menu.path); }}><ReviewIcon /> Open review</button><button type="button" role="menuitem" onClick={() => { setMenu(undefined); props.onOpenFile(menu.path); }}><FileIcon /> Open in Files</button><button type="button" role="menuitem" onClick={() => { const selected = menu.path; setMenu(undefined); void navigator.clipboard.writeText(selected).then(() => props.onFeedback({ level: "info", message: "Review path copied." }), () => props.onFeedback({ level: "error", message: "Review path could not be copied." })); }}><LinkIcon /> Copy path</button></WorkspaceContextMenu> : null}{props.changes.length === 0 && props.agents.length === 0 ? <div class="cli-context-empty"><ReviewIcon /><span>No recorded changes or agent reviews.</span></div> : null}</div>;
}

type DiffCell = { number?: number; text?: string; kind: "context" | "removed" | "added" | "empty" };
type DiffRow = { old: DiffCell; next: DiffCell; header?: string };

function ReviewComparator(props: { change: { path: string; diff?: string }; onOpenFile: () => void }) {
  const rows = useMemo(() => parseUnifiedDiff(props.change.diff ?? ""), [props.change.diff]);
  const additions = rows.filter((row) => row.next.kind === "added").length;
  const deletions = rows.filter((row) => row.old.kind === "removed").length;
  return <article class="cli-review-detail"><header><span><FileIcon /><strong>{props.change.path}</strong><small><b class="is-added">+{additions}</b><b class="is-removed">−{deletions}</b></small></span><button type="button" onClick={props.onOpenFile}>Open in Files</button></header>{props.change.diff ? <div class="cli-diff-comparator" role="table" aria-label={`Changes in ${props.change.path}`}><div class="cli-diff-heading" role="row"><span role="columnheader">Before</span><span role="columnheader">After</span></div>{rows.map((row, index) => row.header ? <div class="cli-diff-hunk" role="row" key={`${index}:${row.header}`}><code>{row.header}</code></div> : <div class="cli-diff-row" role="row" key={index}><DiffSide cell={row.old} /><DiffSide cell={row.next} /></div>)}</div> : <small>No diff was recorded.</small>}</article>;
}

function DiffSide(props: { cell: DiffCell }) {
  const marker = props.cell.kind === "removed" ? "−" : props.cell.kind === "added" ? "+" : " ";
  return <span class={`cli-diff-cell is-${props.cell.kind}`} role="cell"><span class="cli-diff-line-number">{props.cell.number ?? ""}</span><span class="cli-diff-marker" aria-hidden="true">{marker}</span><code>{props.cell.text ?? ""}</code></span>;
}

function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = parseDiffLines(diff);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.kind === "meta") rows.push({ header: line.text, old: { kind: "empty" }, next: { kind: "empty" } });
    else if (line.kind === "removed") {
      const removed = [];
      const added = [];
      while (lines[index]?.kind === "removed") removed.push(lines[index++]!);
      while (lines[index]?.kind === "added") added.push(lines[index++]!);
      index--;
      for (let pair = 0; pair < Math.max(removed.length, added.length); pair++) {
        const before = removed[pair]; const after = added[pair];
        rows.push({ old: before ? { kind: "removed", number: before.oldLine, text: before.text.slice(1) } : { kind: "empty" }, next: after ? { kind: "added", number: after.newLine, text: after.text.slice(1) } : { kind: "empty" } });
      }
    } else if (line.kind === "added") rows.push({ old: { kind: "empty" }, next: { kind: "added", number: line.newLine, text: line.text.slice(1) } });
    else rows.push({ old: { kind: "context", number: line.oldLine, text: line.text.replace(/^ /, "") }, next: { kind: "context", number: line.newLine, text: line.text.replace(/^ /, "") } });
  }
  return rows;
}

function PanelResizeHandle(props: {
  label: string;
  value: number;
  minimum: number;
  maximum?: number;
  onPointerDown: (event: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => void;
  onReset: () => void;
}) {
  return <div class="cli-panel-resizer" role="separator" aria-label={props.label} aria-orientation="vertical" aria-valuemin={props.minimum} {...(props.maximum ? { "aria-valuemax": props.maximum } : {})} aria-valuenow={Math.round(props.value)} tabIndex={0} onPointerDown={props.onPointerDown} onKeyDown={props.onKeyDown} onDblClick={props.onReset}><span /></div>;
}

function SessionAccountFooter(props: {
  onApi?: () => void;
  account?: DashboardAccountViewModel;
  privacyMode: boolean;
  showLogout?: boolean;
  accounts?: DashboardAccountViewModel[];
  localAccounts?: DashboardAccountViewModel[];
  peers?: Array<{ id: string; name: string; connected: boolean; local?: boolean }>;
  peerAccounts?: Record<string, DashboardAccountViewModel[]>;
  selectedPeerId?: string;
  onPeerChange?: (peerId: string) => void;
  switching: boolean;
  onSwitchAccount: (targetDeviceId?: string, accountId?: string) => void;
  onDashboard: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearchOnOpen = useRef(false);
  const peers = props.peers?.length ? props.peers : [{ id: "local", name: "This PC", connected: true, local: true }];
  const peer = peers.find(item => item.id === props.selectedPeerId) ?? peers.find(item => item.local) ?? peers[0]!;
  const accounts = peer.local ? (props.localAccounts ?? props.accounts ?? (props.account ? [props.account] : [])) : (props.peerAccounts?.[peer.id] ?? []);
  const name = (account: DashboardAccountViewModel | undefined, emailFirst = false): string => {
    const raw = (emailFirst ? account?.email : account?.displayName)?.trim() || account?.email?.trim() || account?.displayName?.trim();
    return raw ? getSensitiveDisplayValue(raw, props.privacyMode, raw.includes("@") ? "email" : "name") : account ? "Unnamed account" : "No active account";
  };
  const metrics = (account: DashboardAccountViewModel | undefined) => (account?.metrics ?? [])
    .filter(metric => metric.visible && typeof metric.percentage === "number" && Number.isFinite(metric.percentage))
    .map(metric => ({ ...metric, value: Math.max(0, Math.min(100, Math.round(metric.percentage!))) }));
  const footerMetrics = metrics(props.account);
  const overall = footerMetrics.length ? Math.min(...footerMetrics.map(metric => metric.value)) : undefined;
  const footerName = name(props.account, true);
  const footerSystem = getSensitiveDisplayValue(peer.name, props.privacyMode, "name");
  const footerTitle = props.account ? `${footerName} (${footerSystem})` : footerSystem;
  const currentAccount = accounts.find(account => account.isCurrentWindowAccount || account.runningOnThisDevice) ?? accounts.find(account => account.isActive);
  const currentMetrics = metrics(currentAccount);
  const currentName = name(currentAccount);
  const enabledAccounts = accounts.filter(account => account.enabled);
  const filtered = enabledAccounts.filter(account => `${account.email} ${account.displayName} ${account.planTypeLabel}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  useEffect(() => {
    setSearch("");
  }, [peer.id]);
  const closeMenu = (restoreFocus = false): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const openMenu = (focusSearch: boolean): void => {
    focusSearchOnOpen.current = focusSearch;
    setSearch("");
    setOpen(true);
  };
  useAnchoredPopover(open, triggerRef, menuRef, 'start');
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event: Event): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu();
    };
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeMenu(true); }
    };
    const frame = window.requestAnimationFrame(() => { if (focusSearchOnOpen.current) searchRef.current?.focus({ preventScroll: true }); });
    window.addEventListener("pointerdown", outside);
    window.addEventListener("focusin", outside);
    window.addEventListener("keydown", keydown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("focusin", outside);
      window.removeEventListener("keydown", keydown, true);
    };
  }, [open]);
  const choose = (accountId?: string): void => { closeMenu(); props.onSwitchAccount(peer.local ? "local" : peer.id, accountId); };
  return <footer class="cli-account-footer" ref={rootRef}>
    <button ref={triggerRef} type="button" aria-label="Open account center" aria-description={footerTitle} aria-haspopup="dialog" aria-expanded={open} onClick={event => open ? closeMenu() : openMenu(event.detail === 0)}>
      <span class="cli-account-avatar" aria-hidden="true">{props.account ? footerName.slice(0, 1).toUpperCase() : "?"}</span>
      <span class="cli-account-footer-copy"><span><strong title={footerTitle}>{footerTitle}</strong>{props.account?.planTypeLabel ? <em>{props.account.planTypeLabel}</em> : null}</span><small>{overall !== undefined ? `${overall}% quota available` : "Manage your accounts"}</small>{overall !== undefined ? <span class="cli-account-quota-track" data-level={overall < 20 ? "low" : "normal"}><i style={{ width: `${overall}%` }} /></span> : null}</span>
      <ChevronIcon />
    </button>
    {open ? createPortal(<div ref={menuRef} class="cli-account-menu cli-account-center" role="dialog" aria-label="Account center" style={{ width: "360px" }}>
      <header class="cli-account-center-header"><span>Account center</span><button type="button" class="cli-icon-button" aria-label="Close account menu" onClick={() => closeMenu(true)}><CloseIcon /></button></header>
      <div class="cli-account-system"><label for="account-center-system">System</label><select id="account-center-system" aria-label="Account system" value={peer.id} onChange={event => { const next = event.currentTarget.value; setSearch(""); props.onPeerChange?.(next); }}>{peers.map(item => <option key={item.id} value={item.id}>{getSensitiveDisplayValue(item.name, props.privacyMode, "name")}{item.local ? " (Local)" : !item.connected ? " (Offline)" : ""}</option>)}</select><span class={peer.connected ? "is-online" : "is-offline"}>{peer.connected ? "Online" : "Offline"}</span></div>
      {!peer.connected ? <p class="cli-account-status" role="status">Saved accounts. Reconnect this system to switch.</p> : null}
      <section class="cli-account-current" aria-label="Current account">
        <span class="cli-account-avatar is-large" aria-hidden="true">{currentAccount ? currentName.slice(0, 1).toUpperCase() : "?"}</span>
        <div><strong title={currentName}>{currentName}</strong><small title={name(currentAccount, true)}>{currentAccount ? name(currentAccount, true) : "Add an account from the dashboard"}</small></div>
        {currentAccount?.planTypeLabel ? <span class="cli-account-plan">{currentAccount.planTypeLabel}</span> : null}
      </section>
      <div class="cli-account-quota-grid" aria-label="Current account quota">
        {currentMetrics.length ? currentMetrics.slice(0, 2).map(metric => <div key={metric.key}><span>{metric.label}<strong>{metric.value}%</strong></span><span class="cli-account-quota-track" data-level={metric.value < 20 ? "low" : "normal"} role="meter" aria-label={`${metric.label} quota remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={metric.value}><i style={{ width: `${metric.value}%` }} /></span></div>) : <small>Quota has not been checked yet.</small>}
      </div>
      <div class="cli-account-list-heading"><strong>Accounts <span>{enabledAccounts.length}</span></strong></div>
      <label class="cli-account-search"><SearchIcon /><input ref={searchRef} type="search" aria-label="Search accounts on selected system" placeholder="Find an account..." value={search} onInput={event => setSearch(event.currentTarget.value)} /></label>
      <div class="cli-account-list" role="group" aria-label="Saved accounts">
        {filtered.map(account => {
          const active = account.isActive || account.isCurrentWindowAccount;
          const accountName = name(account, true);
          const quota = metrics(account);
          return <button type="button" class={`cli-account-choice ${active ? "is-current" : ""}`} key={account.id} aria-label={`Switch to ${accountName}`} aria-current={active ? "true" : undefined} disabled={active || !account.enabled || !peer.connected || props.switching} title={active ? "Current account" : !peer.connected ? "System offline" : !account.enabled ? "Enable this account from the dashboard" : `Choose ${accountName}`} onClick={() => choose(account.id)}>
            <span class="cli-account-choice-avatar" aria-hidden="true">{accountName.slice(0, 1).toUpperCase()}</span><span class="cli-account-choice-copy"><strong title={accountName}>{accountName}</strong><small>{account.planTypeLabel || "Account"} · {quota.length ? quota.slice(0, 2).map(metric => `${metric.label} ${metric.value}%`).join(" · ") : "Quota unavailable"}</small></span><span class={`cli-account-choice-status ${active ? "is-current" : ""}`}>{active ? <><CheckIcon />Active</> : !account.enabled ? "Disabled" : <SwitchAccountIcon />}</span>
          </button>;
        })}
        {!filtered.length ? <div class="cli-account-empty" role="status"><strong>{search.trim() ? "No matching accounts" : accounts.length ? "No enabled accounts" : "No saved accounts"}</strong><small>{search.trim() ? "Try another name or email." : accounts.length ? "Enable an account from the dashboard." : "Add an account from the dashboard to get started."}</small></div> : null}
      </div>
      <button type="button" class="cli-account-switch-action" disabled={!peer.connected || props.switching || !enabledAccounts.length} onClick={() => choose()}><SwitchAccountIcon />{props.switching ? "Switching account..." : "Switch account"}</button>
      <nav class="cli-account-navigation" aria-label="Account shortcuts"><button type="button" onClick={() => { closeMenu(); props.onApi?.(); }}>API</button><button type="button" onClick={() => { closeMenu(); props.onDashboard(); }}><DashboardIcon />Dashboard</button><button type="button" onClick={() => { closeMenu(); props.onSettings(); }}><Icon><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></Icon>Settings</button>{props.showLogout ? <form method="post" action="/logout" class="cli-account-logout-form"><button type="submit" class="cli-account-logout">Sign out</button></form> : null}</nav>
    </div>, document.body) : null}
  </footer>;
}

function SessionShareModal(props: { connected: boolean; title: string; sessionKey: string; messages: DashboardCliSessionMessage[]; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState<"create" | "revoke">();
  const [feedback, setFeedback] = useState<DashboardNotice>();
  const inflight = useRef<AbortController>();
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; inflight.current?.abort(); }; }, []);
  const browser = document.documentElement.dataset["dashboardHost"] === "browser";
  const request = async (action: "create" | "revoke"): Promise<boolean> => {
    if (inflight.current) return false;
    if (!browser || !props.connected) { setFeedback({ level: 'warning', message: 'Reconnect in the browser dashboard to manage public links.' }); return false; }
    const controller = new AbortController(); inflight.current = controller;
    setPending(action); setFeedback(undefined); setUrl("");
    const timer = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/api/share/${action}`, { method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Codex-Dashboard": "1" },
        body: JSON.stringify({ sessionKey: props.sessionKey, ...(action === "create" ? { title: props.title,
          includeActivities: true, ...((JSON.parse(props.sessionKey) as unknown[])[0] === 'local' ? {} : { messages: props.messages }) } : {}) }) });
      const result = await response.json().catch(() => { throw new Error("Sharing returned an unreadable response. Check the connection before retrying."); }) as { token?: string; error?: string; ok?: boolean } | null;
      if (!response.ok) throw new Error(result?.error ?? "Sharing failed. Sign in again or retry when connected.");
      if (action === "create" && (typeof result?.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.token))) throw new Error("Link creation was not confirmed. Create a new link or revoke access before sharing again.");
      if (action === "revoke" && result?.ok !== true) throw new Error("Revocation was not confirmed. Reconnect and revoke access again before assuming the link is closed.");
      if (!mounted.current) return false;
      setUrl(action === "create" ? new URL(`/share/${result!.token}`, window.location.origin).href : "");
      setFeedback({ level: 'info', message: action === "create" ? "Read-only link created. It expires in 30 days." : "Shared link revoked. It can no longer be opened." });
      return true;
    } catch (error) {
      if (mounted.current) setFeedback({ level: 'error', message: error instanceof Error && error.name !== "AbortError" ? error.message : "Sharing was not confirmed. An earlier link may have changed. Reconnect, then create a new link or revoke access." });
      return false;
    } finally { window.clearTimeout(timer); inflight.current = undefined; if (mounted.current) setPending(undefined); }
  };
  return <ModalShell open title="Share session" closeLabel="Close share dialog" className="cli-share-modal share-dialog" closeDisabled={!!pending} onClose={props.onClose}>
    <div class="share-context"><span class="share-context-icon"><ShareIcon /></span><div><strong title={props.title}>{props.title}</strong><small>Conversation and recorded activity</small></div><span class="share-access-badge">Read only</span></div>
    <p class="dialog-description">Anyone with the link can read this conversation. Review its contents before sharing.</p>
    <div class="share-included"><div><strong>Included</strong><span>Messages, tool calls, output and shared files</span></div><div><strong>Access</strong><span>No editing or workspace sidebars</span></div><div><strong>Expires</strong><span>30 days after creation</span></div></div>
    {browser ? <>
      <div class="share-create-row"><p>A new link replaces the previous session link.</p><button type="button" class="modal-primary-btn" disabled={!!pending || !props.connected} onClick={() => void request("create")}>{pending === 'create' ? 'Creating link…' : url ? 'Create replacement link' : 'Create read-only link'}</button></div>
      {url ? <div class="task-share-result"><ShareLinkField url={url} label="Session link" disabled={!!pending} onFeedback={setFeedback}/><div class="share-link-meta"><small>Anyone with the link · Read only</small><a href={url} target="_blank" rel="noopener noreferrer">Open conversation ↗</a></div></div> : null}
    </> : <p class="share-outcome">Open this conversation in the browser dashboard to create a public link using its reachable address.</p>}
    {!props.connected ? <p class="share-outcome" role="status">Reconnect to manage public links.</p> : null}
    {feedback ? <p class={`share-outcome ${feedback.level === 'error' ? 'is-error' : ''}`} role={feedback.level === 'error' ? 'alert' : 'status'}>{feedback.message}</p> : null}
    {browser ? <ShareAccessReview description="End public access to this conversation, including previously created links." label="Revoke shared link" busy={!!pending} disabled={!props.connected} onConfirm={() => request('revoke')}/> : null}
  </ModalShell>;
}

function WorkingMessage() {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Math.max(0, Date.now() - startedAt)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <div class="cli-live-activity" role="status" aria-live="polite"><span class="cli-live-spinner" aria-hidden="true" /><strong>Thinking</strong><span>for {formatElapsed(elapsed)}</span></div>;
}

function activityTitle(kind: DashboardCliSessionMessage["kind"]): string {
  switch (kind) {
    case "reasoning": return "Thinking";
    case "plan": return "Plan";
    case "command": return "Ran commands";
    case "file-change": return "File changes";
    case "tool-call": return "Tool call";
    case "collaboration": return "Agent activity";
    case "web-search": return "Web search";
    case "image": return "Image activity";
    case "review": return "Review";
    case "compaction": return "Context compacted";
    case "error": return "Error";
    default: return "Codex activity";
  }
}

function activityMeta(message: DashboardCliSessionMessage): string {
  const values = [message.subtitle];
  if (message.durationMs !== undefined) values.push(formatDuration(message.durationMs));
  if (message.exitCode) values.push(`exit ${message.exitCode}`);
  return values.filter(Boolean).join(" · ");
}
function DeleteConfirmation(props: { title: string; compact?: boolean; onCancel: () => void; onDelete: () => void }) {
  const accessibility = useModalAccessibility(true, props.onCancel);
  return createPortal(
    <div class="cli-delete-overlay" role="presentation" onPointerDown={accessibility.onBackdropPointerDown} onMouseDown={accessibility.onBackdropMouseDown} onClick={accessibility.onBackdropClick}>
      <section ref={accessibility.modalRef} class="cli-delete-confirm" role="alertdialog" aria-modal="true" aria-label={`Delete ${props.title} permanently`} tabIndex={-1} onKeyDown={accessibility.onKeyDown}>
        <div class="cli-delete-confirm-copy"><TrashIcon /><span><strong>Delete permanently?</strong> {props.title} cannot be recovered.</span></div>
        <div class="cli-delete-confirm-actions"><button type="button" class="cli-secondary-button" onClick={props.onCancel}>Cancel</button><button type="button" class="cli-danger-button" onClick={props.onDelete}>Delete</button></div>
      </section>
    </div>,
    document.body
  );
}
function InlineError(props: { text: string; retry: () => void }) {
  const unavailable = /CLI is not available/i.test(props.text);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyInstall = (): void => {
    void navigator.clipboard.writeText("npm install -g @openai/codex").then(() => setCopied(true), () => setCopyFailed(true));
  };
  return <div class="cli-inline-state is-error" role="alert"><strong>{unavailable ? "Codex CLI not found" : "Something went wrong"}</strong><span>{props.text}</span>{unavailable ? <div class="cli-install-command"><code>npm install -g @openai/codex</code><button type="button" onClick={copyInstall}>{copied ? "Copied" : copyFailed ? "Copy failed; select command" : "Copy"}</button></div> : null}<button type="button" onClick={props.retry}>Try again</button></div>;
}

function activityLabel(message: DashboardCliSessionMessage): string {
  if (message.kind === "reasoning") return "Thinking";
  if (message.kind === "command") return (message.status === "inProgress" ? "Running " : message.status === "failed" ? "Failed " : "Ran ") + (message.command ?? message.text).split("\n")[0];
  return message.title ?? activityTitle(message.kind);
}
function EmptySessions(props: { search: boolean; section: CliSessionSection }) { return <div class="cli-inline-state"><EmptyFolderIcon /><strong>{props.search ? "No matching sessions" : `No ${props.section} sessions`}</strong><span>{props.search ? "Try another title or session ID." : props.section === "active" ? "Start a Codex chat to see it here." : "Archived sessions will appear here."}</span></div>; }
function ConversationEmpty({ archived, logoUri }: { archived: boolean; logoUri?: string }) { return <div class="cli-conversation-empty">{logoUri ? <img src={logoUri} alt="" aria-hidden="true" /> : <CodexSessionIcon />}<h2>No messages yet</h2><p>{archived ? "This archived transcript has no readable messages." : "Send a message below to continue this session."}</p></div>; }
function WorkspaceEmpty(props: { running: number; active: number; archived: number; logoUri?: string; onNewChat: () => void }) { return <div class="cli-workspace-empty"><span class="cli-empty-mark">{props.logoUri ? <img src={props.logoUri} alt="" aria-hidden="true" /> : <CodexSessionIcon />}</span><h1>What should we build?</h1><p>Choose a session from the sidebar, or start a new chat.</p><button type="button" class="cli-empty-new-chat" onClick={props.onNewChat}>Start a new chat</button></div>; }
function UsageBanner(props: { account?: DashboardAccountViewModel; onAction: (message: string) => void }) {
  const metric = props.account?.metrics.find((item) => item.visible && typeof item.percentage === "number");
  if (!metric || (metric.percentage ?? 100) > 5) return null;
  return <div class="cli-usage-banner"><span class="cli-usage-icon"><WarningIcon /></span><div><strong>You’re out of Codex and Work usage</strong><small>Add credits or upgrade your plan — or wait for usage to reset.</small></div><button type="button" class="cli-secondary-button" onClick={() => props.onAction("Upgrade is available from the Codex account dashboard.")}>Upgrade</button><button type="button" class="cli-secondary-button" onClick={() => props.onAction("Add credits is available from the Codex account dashboard.")}>Add credits</button></div>;
}
function SessionRailSkeleton() { return <div class="cli-skeleton-list" aria-label="Loading sessions"><i /><i /><i /><i /></div>; }
function MessageSkeleton() { return <div class="cli-message-skeleton" aria-label="Loading messages"><i /><i /><i /></div>; }
function IconButton(props: { label: string; title?: string; disabled?: boolean; danger?: boolean; className?: string; pressed?: boolean; onClick: () => void; children: preact.ComponentChildren }) { return <button type="button" class={`cli-icon-button ${props.className ?? ""} ${props.danger ? "is-danger" : ""}`} disabled={props.disabled} aria-label={props.label} aria-pressed={props.pressed} title={props.title ?? props.label} onClick={props.onClick}>{props.children}</button>; }

function formatTime(value: string | undefined): string { if (!value) return ""; const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : ""; }
function formatDuration(durationMs: number): string { if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))} ms`; if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`; return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`; }
export function formatElapsed(durationMs: number): string { if (durationMs < 60_000) return `${Math.floor(Math.max(0, durationMs) / 1000)}s`; return `${Math.floor(durationMs / 60_000)}m ${Math.floor((durationMs % 60_000) / 1000)}s`; }
function relativeTime(value: string | undefined): string { if (!value) return "Unknown"; const parsed = Date.parse(value); if (!Number.isFinite(parsed)) return "Unknown"; const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60_000)); if (minutes < 1) return "Just now"; if (minutes < 60) return `${minutes}m`; const hours = Math.round(minutes / 60); return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`; }
function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
export function projectDisplayName(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || value;
}
function sessionMeta(session: DashboardCliSessionSummary): string {
  const project = session.projectPath ? projectDisplayName(session.projectPath) : "Workspace";
  return project;
}
function workspaceRelativePath(filePath: string, projectPath: string | undefined): string {
  const file = canonicalWebPath(filePath);
  const root = projectPath ? canonicalWebPath(projectPath) : "";
  if (root && file.startsWith(`${root}/`)) return normalizeNativePath(filePath.trim()).replace(/\\/g, '/').slice(root.length + 1);
  return filePath.replace(/\\/g, "/");
}
export function canonicalWebPath(value: string): string {
  const normalized = normalizeNativePath(value.trim()).replace(/\\/g, "/").replace(/\/+$/, "");
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}
function clamp(value: number, minimum: number, maximum = Number.POSITIVE_INFINITY): number { return Math.min(maximum, Math.max(minimum, value)); }
function loadWorkspaceLayout(): WorkspaceLayout {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "{}") as Partial<WorkspaceLayout>;
    return {
      sessionView: parsed.sessionView === "projects" ? "projects" : "compact",
      railWidth: clamp(Number(parsed.railWidth) || DEFAULT_WORKSPACE_LAYOUT.railWidth, 200),
      terminalWidth: clamp(Number(parsed.terminalWidth) || DEFAULT_WORKSPACE_LAYOUT.terminalWidth, 280),
      composerHeight: clamp(Number(parsed.composerHeight) || DEFAULT_WORKSPACE_LAYOUT.composerHeight, 120)
    };
  } catch {
    return DEFAULT_WORKSPACE_LAYOUT;
  }
}
function saveWorkspaceLayout(layout: WorkspaceLayout): void {
  try {
    window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Layout persistence is optional in restricted webviews.
  }
}

function ActivityGlyph({ kind }: { kind: DashboardCliSessionMessage["kind"] }) {
  switch (kind) {
    case "reasoning": return <ReasoningIcon />;
    case "plan": return <SparkIcon />;
    case "command": return <TerminalIcon />;
    case "file-change": return <FileIcon />;
    case "tool-call": return <ToolIcon />;
    case "collaboration": return <ForkIcon />;
    case "web-search": return <SearchIcon />;
    case "image": return <ImageIcon />;
    case "review": return <ReviewIcon />;
    case "compaction": return <ArchiveIcon />;
    case "error": return <WarningIcon />;
    default: return <CodexSessionIcon />;
  }
}

function Icon({ children }: { children: preact.ComponentChildren }) { return <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>; }
function TaskActivityIcon() { return <Icon><path d="M3 12h4l3-7 4 14 3-7h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></Icon>; }
function SessionListIcon() { return <Icon><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></Icon>; }
function SidebarIcon() { return <Icon><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 4v16" fill="none" stroke="currentColor" stroke-width="1.7"/></Icon>; }
function DashboardIcon() { return <Icon><rect x="4" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/></Icon>; }
function CodexSessionIcon() { return <Icon><path d="M8.3 3.2a5 5 0 0 1 8.5 2.1 5 5 0 0 1 2 8.5 5 5 0 0 1-2.1 8.5 5 5 0 0 1-8.5-2.1 5 5 0 0 1-2-8.5 5 5 0 0 1 2.1-8.5Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8.2 12 2.5 2.5 5.2-5.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function CloseIcon() { return <Icon><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></Icon>; }
function SearchIcon() { return <Icon><circle cx="10.8" cy="10.8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m15.5 15.5 4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></Icon>; }
function RefreshIcon() { return <Icon><path d="M20 4v6h-6M4 20v-6h6M5.2 9a7 7 0 0 1 11.6-4.1L20 10M4 14l3.2 5.1A7 7 0 0 0 18.8 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function CopyIcon() { return <Icon><rect x="8" y="8" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="1.6"/></Icon>; }
function ArchiveIcon() { return <Icon><path d="M4 7h16v12H4zM3 4h18v3H3zM9 11h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></Icon>; }
function RestoreIcon() { return <Icon><path d="M4 9a8 8 0 1 1 .8 7M4 4v5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function TrashIcon() { return <Icon><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function SparkIcon() { return <Icon><path d="m12 3 1.2 4.1L17 9l-3.8 1.9L12 15l-1.2-4.1L7 9l3.8-1.9L12 3Zm6 11 .7 2.3L21 17.5l-2.3 1.2L18 21l-.7-2.3-2.3-1.2 2.3-1.2L18 14Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></Icon>; }
function ReasoningIcon() { return <Icon><path d="M9 18h6M10 21h4M8.5 15.5C6.9 14.4 6 12.6 6 10.6a6 6 0 1 1 12 0c0 2-.9 3.8-2.5 4.9-.5.4-.8.9-.8 1.5H9.3c0-.6-.3-1.1-.8-1.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function ShieldIcon() { return <Icon><path d="M12 3 5 6v5c0 4.6 2.9 8.2 7 10 4.1-1.8 7-5.4 7-10V6l-7-3Zm-3 9 2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></Icon>; }
function SendIcon() { return <Icon><path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function StopIcon() { return <Icon><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></Icon>; }
function PlayIcon() { return <Icon><path d="m8 5 11 7-11 7Z" fill="currentColor" /></Icon>; }
export function AutoResumeIcon(props: { enabled: boolean; goal: boolean }) { return <Icon><path d="M20 8V3l-3 3a9 9 0 1 0 3.5 9M20 8h-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>{props.enabled ? <path data-state="enabled" d="m10 8 6 4-6 4V8Z" fill="currentColor" stroke-linejoin="round"/> : <path data-state="paused" d="M10 9v6m4-6v6" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>}</Icon>; }
function SwitchAccountIcon() { return <Icon><path d="M5 8h11l-2.5-2.5M19 16H8l2.5 2.5M16 8l2.5 2.5L16 13M8 16l-2.5-2.5L8 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function EmptyFolderIcon() { return <Icon><path d="M3 7h7l2 2h9v10H3V7Zm0 0V5h7l2 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></Icon>; }
function PlusIcon() { return <Icon><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></Icon>; }
function MoreIcon() { return <Icon><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/></Icon>; }
function PencilIcon() { return <Icon><path d="m4 20 4.2-1 10.4-10.4a2 2 0 0 0-2.8-2.8L5.4 16.2 4 20Zm10.5-12.9 2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></Icon>; }
function ForkIcon() { return <Icon><circle cx="7" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="17" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="19" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 7v2c0 3 2 4 5 4s5-1 5-4V7M12 13v4" fill="none" stroke="currentColor" stroke-width="1.6"/></Icon>; }
function LinkIcon() { return <Icon><path d="m9.5 14.5 5-5M7 16.8l-1 .9a3.3 3.3 0 0 1-4.7-4.7l3.2-3.2a3.3 3.3 0 0 1 4.7 0M17 7.2l1-.9a3.3 3.3 0 0 1 4.7 4.7l-3.2 3.2a3.3 3.3 0 0 1-4.7 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></Icon>; }
function ShareIcon() { return <Icon><circle cx="18" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="19" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8 11 8-5M8 13l8 5" fill="none" stroke="currentColor" stroke-width="1.6"/></Icon>; }
function TerminalIcon() { return <Icon><path d="m5 7 4 4-4 4m6 1h7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function PanelIcon() { return <Icon><rect x="3.5" y="4" width="17" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15 4v16M7 9h4M7 12h4M7 15h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></Icon>; }
function FileIcon() { return <Icon><path d="M6 3h8l4 4v14H6V3Zm8 0v5h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></Icon>; }
function ToolIcon() { return <Icon><path d="M14.5 6.5a4 4 0 0 0-5-5L12 4l-3 3-2.5-2.5a4 4 0 0 0 5 5L18 16a2.1 2.1 0 1 1-3 3l-6.5-6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function ImageIcon() { return <Icon><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m4 17 5-4 3 2 3-3 5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></Icon>; }
function ReviewIcon() { return <Icon><path d="M4 5h16v12H8l-4 4V5Zm4 4h8m-8 4h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function WarningIcon() { return <Icon><path d="M12 3 2.8 20h18.4L12 3Zm0 6v5m0 3h.01" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function CheckIcon() { return <Icon><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function ChevronIcon() { return <Icon><path d="m8 10 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }

function QuoteIcon() { return <Icon><path d="M4 6h6v7H7c0 2-1 3-3 4m10-11h6v7h-3c0 2-1 3-3 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></Icon>; }


