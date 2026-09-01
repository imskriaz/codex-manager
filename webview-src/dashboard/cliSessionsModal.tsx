import { createPortal } from "preact/compat";
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import MarkdownIt from "markdown-it";
import type {
  DashboardCliComposerConfig,
  DashboardCliSandboxMode,
  DashboardCliSessionMessage,
  DashboardCliSessionSummary,
  DashboardNotice,
  DashboardWorkspaceEnvironment,
  DashboardWorkspaceFile,
  DashboardWorkspaceFileEntry,
  DashboardWorkspaceTerminalInfo,
  DashboardWorkspaceTerminalResult
} from "../../src/domain/dashboard/types";
import type { DashboardAccountViewModel } from "../../src/domain/dashboard/types";

export type CliSessionFeedback = DashboardNotice & { key: number };
type WorkspaceTab = "terminal" | "files" | "reviews" | `file:${string}` | `review:${string}`;
type WorkspaceToolTab = "terminal" | "files" | "reviews";
export type CliSessionSection = "active" | "archived";
/** Keep the two state tabs mutually exclusive, treating only an explicit
 * `archived: true` marker as archived. */
export function filterCliSessionsBySection(
  sessions: DashboardCliSessionSummary[],
  section: CliSessionSection
): DashboardCliSessionSummary[] {
  const archived = section === "archived";
  return sessions.filter((session) => (session.archived === true) === archived);
}
const workspaceTabKind = (tab: WorkspaceTab): WorkspaceToolTab => tab.startsWith("file:") ? "files" : tab.startsWith("review:") ? "reviews" : tab as WorkspaceToolTab;
const workspaceTabPath = (tab: WorkspaceTab): string | undefined => tab.includes(":") ? tab.slice(tab.indexOf(":") + 1) : undefined;

type WorkspaceLayout = {
  railWidth: number;
  terminalWidth: number;
  environmentWidth: number;
  environmentHeight: number;
  composerHeight: number;
};

const WORKSPACE_LAYOUT_STORAGE_KEY = "codexManager.workspaceLayout.v2";
const WORKSPACE_TERMINAL_ID = "workspace-terminal";
const markdownRenderer = new MarkdownIt({ html: false, linkify: true, typographer: true });
const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  railWidth: 224,
  terminalWidth: 320,
  environmentWidth: 288,
  environmentHeight: 320,
  composerHeight: 136
};

export type CliSessionsPageProps = {
  sessions: DashboardCliSessionSummary[];
  selectedSession?: DashboardCliSessionSummary;
  messages: DashboardCliSessionMessage[];
  composerConfig?: DashboardCliComposerConfig;
  loading: boolean;
  starting: boolean;
  messagesLoading: boolean;
  sending: boolean;
  stopping: boolean;
  mutating: boolean;
  error?: string;
  messagesError?: string;
  feedback?: CliSessionFeedback;
  environment?: DashboardWorkspaceEnvironment;
  terminalResults: DashboardWorkspaceTerminalResult[];
  workspaceTerminals: DashboardWorkspaceTerminalInfo[];
  environmentLoading: boolean;
  terminalRunning: boolean;
  terminalStopping: boolean;
  workspaceFiles: DashboardWorkspaceFileEntry[];
  workspaceFilesByPath: Record<string, DashboardWorkspaceFile>;
  workspaceFilesLoading: boolean;
  workspaceFileLoading: boolean;
  workspaceFileSaving: boolean;
  logoUri?: string;
  onDashboard: () => void;
  account?: DashboardAccountViewModel;
  localAccounts?: DashboardAccountViewModel[];
  onSwitchAccount: (targetDeviceId?: string) => void;
  peers?: Array<{ id: string; name: string; connected: boolean; local?: boolean }>;
  selectedPeerId?: string;
  peerAccounts?: Record<string, DashboardAccountViewModel[]>;
  onPeerChange?: (peerId: string) => void;
  onRefresh: () => void;
  onStart: (input: { text: string; model?: string; reasoningEffort?: string; sandboxMode: DashboardCliSandboxMode; projectPath?: string }) => void;
  onSelect: (session: DashboardCliSessionSummary) => void;
  onBackToList: () => void;
  onRefreshMessages: () => void;
  onRefreshEnvironment: (projectPath?: string) => void;
  onRunTerminal: (command: string, projectPath?: string, terminalId?: string) => void;
  onListTerminals: () => void;
  onCreateTerminal: (profile: "default" | "powershell" | "cmd" | "bash", projectPath?: string) => void;
  onFocusTerminal: (terminalId: string) => void;
  onCancelTerminal: (terminalId?: string) => void;
  onCommitWorkspace: (commitMessage: string, projectPath?: string) => void;
  onPushWorkspace: (projectPath?: string) => void;
  onClearTerminal: () => void;
  onListFiles: (projectPath?: string) => void;
  onReadFile: (filePath: string, projectPath?: string) => void;
  onClearFile: () => void;
  onDeleteFile: (filePath: string, projectPath?: string) => void;
  onSaveFile: (filePath: string, content: string, projectPath?: string) => void;
  onSend: (input: {
    text: string;
    model?: string;
    reasoningEffort?: string;
    sandboxMode: DashboardCliSandboxMode;
    projectPath?: string;
  }) => void;
  onStop: (session: DashboardCliSessionSummary) => void;
  onRename: (name: string) => void;
  onFork: () => void;
  onCopyLink: () => void;
  onShare: () => void;
  onArchive: (session: DashboardCliSessionSummary) => void;
  onOpenInCodex: (session: DashboardCliSessionSummary) => void;
  onUnarchive: (session: DashboardCliSessionSummary) => void;
  onDelete: (session: DashboardCliSessionSummary) => void;
};

export function CliSessionsPage(props: CliSessionsPageProps) {
  const [section, setSection] = useState<CliSessionSection>("active");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState<string>();
  const [reasoningEffort, setReasoningEffort] = useState<string>();
  const [sandboxMode, setSandboxMode] = useState<DashboardCliSandboxMode>("workspace-write");
  const [projectPath, setProjectPath] = useState<string>();
  const [newChatProject, setNewChatProject] = useState<string>();
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [contextCollapsed, setContextCollapsed] = useState(() => window.innerWidth < 1180);
  const [contextTabs, setContextTabs] = useState<WorkspaceTab[]>([]);
  const [activeContextTab, setActiveContextTab] = useState<WorkspaceTab>("terminal");
  const [contextAddOpen, setContextAddOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(() => window.innerWidth >= 760);
  const [layout, setLayout] = useState(loadWorkspaceLayout);
  const [terminalDraft, setTerminalDraft] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<DashboardCliSessionSummary>();
  const [localFeedback, setLocalFeedback] = useState<DashboardNotice>();
  const [shareOpen, setShareOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageViewportRef = useRef<HTMLElement>(null);
  const [isNearMessageBottom, setIsNearMessageBottom] = useState(true);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previousFeedbackKey = useRef<number>();

  useEffect(() => {
    if (!props.composerConfig) return;
    const defaultModel = props.composerConfig.defaultModel ?? props.composerConfig.models[0]?.id;
    const modelOption = props.composerConfig.models.find((option) => option.id === defaultModel);
    setModel((current) => current ?? defaultModel);
    setReasoningEffort((current) => current ?? props.composerConfig?.defaultReasoningEffort ?? modelOption?.defaultReasoningEffort ?? modelOption?.reasoningEfforts[0] ?? "medium");
    setSandboxMode(props.composerConfig.defaultSandboxMode);
    setProjectPath((current) => current ?? props.composerConfig?.projects?.[0]?.path);
  }, [props.composerConfig]);

  useEffect(() => {
    if (!props.feedback || previousFeedbackKey.current === props.feedback.key) return;
    previousFeedbackKey.current = props.feedback.key;
    setLocalFeedback(props.feedback);
    if (props.feedback.level === "info" && props.feedback.message.includes("completed")) setDraft("");
  }, [props.feedback]);

  useEffect(() => saveWorkspaceLayout(layout), [layout]);

  useEffect(() => {
    // A session deep link should open in its matching state tab, but returning
    // to the workspace list (including after archive/delete) must restore the
    // default Active view instead of leaving the rail on Archive.
    setSection(props.selectedSession?.archived ? "archived" : "active");
    setDeleteTarget(undefined);
  }, [props.selectedSession?.id, props.selectedSession?.archived]);

   useEffect(() => {
     if (isNearMessageBottom) messagesEndRef.current?.scrollIntoView({ block: "end" });
   }, [props.messages.length, props.sending, isNearMessageBottom]);
   const updateMessageScrollState = (): void => {
     const viewport = messageViewportRef.current;
     if (!viewport) return;
     setIsNearMessageBottom(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 56);
   };
   const scrollToLatest = (): void => {
     const viewport = messageViewportRef.current;
     if (!viewport) return;
     viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
     setIsNearMessageBottom(true);
   };

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 1179px)");
    const mobile = window.matchMedia("(max-width: 759px)");
    const apply = (): void => {
      if (compact.matches) setContextCollapsed(true);
      if (mobile.matches) setEnvironmentOpen(false);
    };
    apply();
    compact.addEventListener("change", apply);
    mobile.addEventListener("change", apply);
    return () => {
      compact.removeEventListener("change", apply);
      mobile.removeEventListener("change", apply);
    };
  }, []);

  const activeSessions = filterCliSessionsBySection(props.sessions, "active");
  const archivedSessions = filterCliSessionsBySection(props.sessions, "archived");
  const runningCount = activeSessions.filter((session) => session.status === "running").length;
  const visibleSessions = useMemo(() => {
    const source = section === "active" ? activeSessions : archivedSessions;
    const query = search.trim().toLocaleLowerCase();
    return query
      ? source.filter((session) => `${session.title} ${session.id}`.toLocaleLowerCase().includes(query))
      : source;
  }, [activeSessions, archivedSessions, search, section]);
  const selectedModel = props.composerConfig?.models.find((option) => option.id === model);
  const reasoningOptions = selectedModel?.reasoningEfforts.length
    ? selectedModel.reasoningEfforts
    : ["low", "medium", "high", "xhigh"];
  const selectedArchived = props.selectedSession?.archived === true;
  const composerBlockedByOwner = props.selectedSession?.status === "running" && !props.sending;
  const hasInProgressActivity = props.messages.some((message) => message.status === "inProgress");
  const projects = props.composerConfig?.projects ?? [];
  const composerProjects = useMemo(() => {
    const known = new Set(projects.map((project) => project.path.toLocaleLowerCase()));
    const extraPaths = [props.selectedSession?.projectPath, newChatProject, ...props.sessions.map((session) => session.projectPath)]
      .filter((projectPath): projectPath is string => typeof projectPath === "string" && projectPath.length > 0 && !known.has(projectPath.toLocaleLowerCase()));
    const uniqueExtraPaths = extraPaths.filter((projectPath, index, all) => all.findIndex((candidate) => canonicalWebPath(candidate) === canonicalWebPath(projectPath)) === index);
    return [...projects, ...uniqueExtraPaths.map((projectPath) => ({
      id: `session-project:${projectPath}`,
      label: projectDisplayName(projectPath),
      path: projectPath
    }))];
  }, [newChatProject, projects, props.selectedSession?.projectPath, props.sessions]);
  const railFiles = useMemo(() => props.messages.flatMap((message) => message.changes ?? []).filter((change, index, all) => all.findIndex((item) => item.path === change.path) === index), [props.messages]);
  const railAgents = useMemo(() => props.messages.filter((message) => message.kind === "collaboration"), [props.messages]);
  const selectedProjectPath = props.selectedSession?.projectPath ?? newChatProject ?? projectPath;
  const localPeerId = props.peers?.find((peer) => peer.local)?.id;
  const pcGroups = useMemo(() => {
    const localPeer = props.peers?.find((peer) => peer.local);
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
    for (const session of props.sessions) {
      const id = session.deviceId ?? localPeer?.id ?? "local";
      const existing = groups.get(id);
      if (existing) {
        existing.allSessions.push(session);
        if (visibleSessions.some((visible) => visible.id === session.id)) existing.sessions.push(session);
      }
      else groups.set(id, {
        id,
        name: session.deviceName?.trim() || (session.remote ? "Remote PC" : "This PC"),
        local: !session.remote,
        connected: true,
        sessions: visibleSessions.some((visible) => visible.id === session.id) ? [session] : [],
        allSessions: [session]
      });
    }
    if (groups.size === 0) groups.set("local", { id: "local", name: "This PC", local: true, connected: true, sessions: [], allSessions: [] });
    return [...groups.values()];
  }, [props.peers, props.sessions, visibleSessions]);
  const toggleGroup = (id: string): void => {
    setCollapsedGroups((current) => ({ ...current, [id]: !current[id] }));
  };
  const selectContextTab = (tab: WorkspaceTab): void => {
    setActiveContextTab(tab);
    const filePath = workspaceTabPath(tab);
    if (workspaceTabKind(tab) === "files") {
      props.onListFiles(selectedProjectPath);
      if (filePath) props.onReadFile(filePath, selectedProjectPath);
    }
  };
  const openContextTab = (tab: WorkspaceToolTab, filePath?: string): void => {
    const resolvedFilePath = filePath && tab === "files" ? workspaceRelativePath(filePath, selectedProjectPath) : filePath;
    const tabId: WorkspaceTab = resolvedFilePath ? `${tab === "files" ? "file" : "review"}:${resolvedFilePath}` : tab;
    setContextTabs((current) => {
      const withBase = current.includes(tab) ? current : [...current, tab];
      return withBase.includes(tabId) ? withBase : [...withBase, tabId];
    });
    selectContextTab(tabId);
    setContextCollapsed(false);
    setContextAddOpen(false);
  };
  const renderSession = (session: DashboardCliSessionSummary): preact.ComponentChildren => session.archived ? (
    <div role="listitem" class="cli-session-row is-archived" key={session.id}>
      <span class="cli-session-row-main"><strong>{session.title}</strong><small>{session.remote ? session.deviceName ?? "Remote" : "Archived"} · {relativeTime(session.updatedAt)}</small></span>
      <span class="cli-session-row-actions">
        <IconButton label={`Restore ${session.title}`} disabled={props.mutating} onClick={() => props.onUnarchive(session)}><RestoreIcon /></IconButton>
        <IconButton label={`Delete ${session.title}`} disabled={props.mutating} danger onClick={() => setDeleteTarget(session)}><TrashIcon /></IconButton>
      </span>
    </div>
  ) : (
    <div role="listitem" class={`cli-session-row ${props.selectedSession?.id === session.id ? "is-selected" : ""}`} key={session.id}>
      <button type="button" class="cli-session-row-select" onClick={() => { setNewChatProject(undefined); setProjectPath(session.projectPath); props.onPeerChange?.(session.deviceId ?? localPeerId ?? "local"); props.onSelect(session); }}>
        <span class="cli-session-row-status" title={session.status === "running" ? "Running" : "Complete"} aria-label={session.status === "running" ? "Running" : "Complete"}>
          {session.status === "running" ? <span class="cli-session-spinner" aria-hidden="true" /> : <CheckIcon />}
        </span>
        <span class={`cli-session-row-main ${session.projectPath ? "has-project" : ""}`}><strong>{session.title}</strong><small class="cli-session-row-meta">{session.projectPath ? <span class="cli-session-project" title={session.projectPath}><EmptyFolderIcon />{projectDisplayName(session.projectPath)}</span> : null}<span>{session.remote ? `${session.deviceName ?? "Remote"} · ` : ""}{relativeTime(session.updatedAt)}</span></small></span>
      </button>
      <span class="cli-session-row-actions">
        {session.status === "running" ? (session.canStop ? <IconButton label={`Stop ${session.title}`} disabled={props.mutating} onClick={() => props.onStop(session)}><StopIcon /></IconButton> : null) : <>
          <IconButton label={`Open ${session.title} in Codex`} disabled={props.mutating} onClick={() => props.onOpenInCodex(session)}><RestoreIcon /></IconButton>
        </>}
      </span>
    </div>
  );
  const returnToSessionList = (): void => {
    setNewChatProject(undefined);
    props.onBackToList();
  };

  const submit = (): void => {
    const text = draft.trim();
    if (!text) {
      setLocalFeedback({ level: "warning", message: "Write a message before sending it to Codex." });
      return;
    }
    setLocalFeedback({ level: "info", message: "Codex is working on your request…" });
    if (!props.selectedSession) {
      setLocalFeedback({ level: "info", message: "Starting a new Codex chat…" });
      props.onStart({ text, model, reasoningEffort, sandboxMode, projectPath: newChatProject ?? projectPath });
    } else {
      props.onSend({ text, model, reasoningEffort, sandboxMode, projectPath });
    }
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
    const root = document.documentElement;
    root.style.setProperty("--cli-shell-rail-width", railCollapsed ? "0px" : `${layout.railWidth}px`);
    root.style.setProperty("--cli-shell-terminal-width", contextCollapsed ? "0px" : `${layout.terminalWidth}px`);
    return () => {
      root.style.removeProperty("--cli-shell-rail-width");
      root.style.removeProperty("--cli-shell-terminal-width");
    };
  }, [contextCollapsed, layout.railWidth, layout.terminalWidth, railCollapsed]);

  return (
    <div
      ref={workspaceRef}
      class={`cli-workspace ${railCollapsed ? "is-rail-collapsed" : ""} ${contextCollapsed ? "is-terminal-collapsed" : ""}`}
      style={`--cli-rail-width:${layout.railWidth}px;--cli-terminal-width:${layout.terminalWidth}px;--cli-environment-width:${layout.environmentWidth}px;--cli-environment-height:${layout.environmentHeight}px;--cli-composer-height:${layout.composerHeight}px`}
    >
      <button type="button" class="cli-rail-toggle" aria-label={railCollapsed ? "Show sessions sidebar" : "Hide sessions sidebar"} title={railCollapsed ? "Show sessions sidebar" : "Hide sessions sidebar"} onClick={() => setRailCollapsed((collapsed) => !collapsed)}><SidebarIcon /></button>
      {!props.selectedSession && contextCollapsed ? <button type="button" class="cli-context-toggle" aria-label="Show workspace tools" title="Show Terminal, Files, and Reviews" onClick={() => setContextCollapsed(false)}><PanelIcon /></button> : null}
      <div class={`cli-workspace-grid ${props.selectedSession ? "has-context" : ""}`}>
        <aside class={`cli-session-rail ${props.selectedSession ? "has-selection" : ""}`} aria-label="Codex sessions">
          <div class="cli-rail-header">
            <div class="cli-rail-brand">{props.logoUri ? <img src={props.logoUri} alt="" aria-hidden="true" /> : <span class="cli-brand-mark"><CodexSessionIcon /></span>}<strong>Codex</strong></div>
            <div />
          </div>
          <nav class="cli-primary-nav" aria-label="Workspace navigation">
            <button type="button" onClick={() => { const nextProject = projectPath ?? projects[0]?.path ?? ""; setNewChatProject(nextProject); setProjectPath(nextProject); props.onBackToList(); }}><PlusIcon /><span>New chat</span></button>
            <button type="button" onClick={props.onDashboard}><DashboardIcon /><span>Dashboard</span></button>
          </nav>
          <div class="cli-session-filters">
            <div class="cli-session-search-line"><div class="cli-session-search-wrap"><SearchIcon /><input class="cli-session-search" name="session-search" type="search" autoComplete="off" value={search} placeholder="Search sessions…" aria-label="Search sessions" onInput={(event) => setSearch(event.currentTarget.value)} /></div><IconButton label={props.loading ? "Refreshing sessions" : "Refresh sessions"} disabled={props.loading} onClick={props.onRefresh}><RefreshIcon /></IconButton></div>
            <div class="cli-session-tabs cli-session-state-toggle" role="tablist" aria-label="Session state"><button type="button" role="tab" aria-selected={section === "active"} class={section === "active" ? "is-active" : ""} aria-label={`Active sessions (${activeSessions.length})`} title="Active sessions" onClick={() => setSection("active")}><CheckIcon /><span class="cli-session-state-label">Active</span><span class="cli-session-state-count">{activeSessions.length}</span></button><button type="button" role="tab" aria-selected={section === "archived"} class={section === "archived" ? "is-active" : ""} aria-label={`Archived sessions (${archivedSessions.length})`} title="Archived sessions" onClick={() => setSection("archived")}><ArchiveIcon /><span class="cli-session-state-label">Archive</span><span class="cli-session-state-count">{archivedSessions.length}</span></button></div>
          </div>
          <div class="cli-project-heading"><span>PCs · Projects</span><small>New chat</small></div>
          <div class="cli-project-list cli-pc-project-list" aria-label="PCs, projects, and sessions">
            {pcGroups.map((pc) => {
              const pcCollapsed = Boolean(collapsedGroups[`pc:${pc.id}`]);
              const knownProjectPaths = new Set((pc.local ? projects : []).map((project) => canonicalWebPath(project.path)));
              const sessionProjects = [...new Map(pc.allSessions
                .filter((session) => session.projectPath && !knownProjectPaths.has(canonicalWebPath(session.projectPath)))
                .map((session) => [session.projectPath!, {
                  id: `${pc.id}:${session.projectPath}`,
                  label: projectDisplayName(session.projectPath!),
                  path: session.projectPath!
                }])).values()];
              const pcProjects = pc.local ? [...projects, ...sessionProjects] : sessionProjects;
              const assigned = new Set<string>();
              const projectGroups = pcProjects.map((project) => {
                const sessions = pc.sessions.filter((session) => {
                  const projectPath = session.projectPath;
                  const matches = Boolean(projectPath && project.path && canonicalWebPath(projectPath) === canonicalWebPath(project.path));
                  if (matches) assigned.add(session.id);
                  return matches;
                });
                return { project, sessions };
              });
              const unassigned = pc.sessions.filter((session) => !assigned.has(session.id));
               if (unassigned.length > 0) projectGroups.unshift({ project: { id: `${pc.id}:recents`, label: "Recent", path: "" }, sessions: unassigned });
               return <section class="cli-pc-group" key={pc.id}>
                 <div class="cli-pc-group-heading">
                   <button type="button" class={`cli-pc-group-toggle ${props.selectedPeerId === pc.id ? "is-selected" : ""}`} aria-expanded={!pcCollapsed} onClick={() => { props.onPeerChange?.(pc.id); toggleGroup(`pc:${pc.id}`); }}>
                     <ChevronIcon /><span><strong>{pc.name}</strong><small>{`${pc.sessions.length} session${pc.sessions.length === 1 ? "" : "s"} · ${pc.connected ? "online" : "offline"}`}</small></span>
                   </button>
                   <button type="button" class="cli-pc-switch" aria-label={`Switch account on ${pc.name}`} title={`Switch account on ${pc.name}`} onClick={(event) => { event.stopPropagation(); if (pc.local) props.onSwitchAccount(); else props.onSwitchAccount(pc.id); }}><SwitchAccountIcon /></button>
                 </div>
                {!pcCollapsed ? <div class="cli-pc-group-children">
                  {projectGroups.map(({ project, sessions }) => {
                    const groupId = `project:${pc.id}:${project.id}`;
                    const projectCollapsed = Boolean(collapsedGroups[groupId]);
                    return <section class="cli-project-group" key={groupId}>
                       <div class={`cli-project-row ${newChatProject === project.path ? "is-selected" : ""}`}>
                         <button type="button" class="cli-project-select" aria-expanded={!projectCollapsed} onClick={() => toggleGroup(groupId)}>
                           <EmptyFolderIcon /><span><strong title={project.path || undefined}>{project.label}</strong>{project.path ? <small title={project.path}>{project.path}</small> : null}</span>
                         </button>
                         <span class="cli-project-actions">
                           <button type="button" class="cli-project-collapse" aria-label={`${projectCollapsed ? "Expand" : "Collapse"} ${project.label}`} aria-expanded={!projectCollapsed} onClick={() => toggleGroup(groupId)}><ChevronIcon /></button>
                           {pc.local ? <button type="button" class="cli-project-new" aria-label={`New chat in ${project.label}`} title={`New chat in ${project.label}`} onClick={() => { props.onBackToList(); setNewChatProject(project.path); setProjectPath(project.path); }}><PlusIcon /></button> : null}
                         </span>
                      </div>
                      {!projectCollapsed ? <div class="cli-project-sessions" role="list">{sessions.map(renderSession)}{sessions.length === 0 ? <small class="cli-project-empty">No sessions yet</small> : null}</div> : null}
                    </section>;
                  })}
                </div> : null}
              </section>;
            })}
          </div>
          {props.loading && props.sessions.length === 0 ? <SessionRailSkeleton /> : null}
          {props.error ? <InlineError text={props.error} retry={props.onRefresh} /> : null}
          {!props.loading && !props.error && visibleSessions.length === 0 ? <EmptySessions search={Boolean(search)} section={section} /> : null}
          {deleteTarget && deleteTarget.archived ? <DeleteConfirmation compact title={deleteTarget.title} onCancel={() => { setDeleteTarget(undefined); setLocalFeedback({ level: "info", message: "Session deletion cancelled." }); }} onDelete={() => { const target = deleteTarget; setDeleteTarget(undefined); props.onDelete(target); }} /> : null}
          <SessionAccountFooter
            account={props.account}
            accounts={props.selectedPeerId && props.selectedPeerId !== localPeerId ? (props.peerAccounts?.[props.selectedPeerId] ?? []) : undefined}
            localAccounts={props.localAccounts}
            peers={props.peers}
            peerAccounts={props.peerAccounts}
            selectedPeerId={props.selectedPeerId}
            onSwitchAccount={props.onSwitchAccount}
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

        <main class={`cli-conversation ${props.selectedSession ? "has-session" : newChatProject !== undefined ? "has-new-chat" : ""}`}>
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
                onCopyLink={props.onCopyLink}
                onShare={() => setShareOpen(true)}
                onArchive={() => props.onArchive(props.selectedSession!)}
                onRestore={() => props.onUnarchive(props.selectedSession!)}
                onDelete={() => setDeleteTarget(props.selectedSession)}
                onRenameCancelled={() => setLocalFeedback({ level: "info", message: "Rename cancelled." })}
                environmentOpen={environmentOpen}
                terminalCollapsed={contextCollapsed}
                onToggleEnvironment={() => setEnvironmentOpen((open) => !open)}
                onToggleTerminal={() => { setContextCollapsed(false); setActiveContextTab(contextTabs[0] ?? "terminal"); }}
              />
              {environmentOpen ? <EnvironmentPopover
                environment={props.environment}
                loading={props.environmentLoading}
                projectPath={props.selectedSession.projectPath ?? projectPath}
                width={layout.environmentWidth}
                height={layout.environmentHeight}
                onResize={(width, height) => setLayout((current) => ({ ...current, environmentWidth: width, environmentHeight: height }))}
                onClose={() => setEnvironmentOpen(false)}
                onRefresh={props.onRefreshEnvironment}
                onCommit={props.onCommitWorkspace}
                onPush={props.onPushWorkspace}
                onCompare={() => openContextTab("reviews")}
              /> : null}
              {deleteTarget && !deleteTarget.archived ? <DeleteConfirmation title={deleteTarget.title} onCancel={() => { setDeleteTarget(undefined); setLocalFeedback({ level: "info", message: "Session deletion cancelled." }); }} onDelete={() => { const target = deleteTarget; setDeleteTarget(undefined); props.onDelete(target); }} /> : null}
              <section ref={messageViewportRef} class="cli-message-viewport" aria-live="polite" aria-busy={props.messagesLoading} onScroll={updateMessageScrollState}>
                {props.messagesLoading && props.messages.length === 0 ? <MessageSkeleton /> : null}
                {props.messagesError ? <InlineError text={props.messagesError} retry={props.onRefreshMessages} /> : null}
                {!props.messagesLoading && !props.messagesError && props.messages.length === 0 ? <ConversationEmpty archived={selectedArchived} logoUri={props.logoUri} /> : null}
                <div class="cli-session-messages">
                  {consolidateSessionMessages(props.messages).map((item) => "messages" in item
                    ? <ActivityGroup key={item.id} messages={item.messages} onOpenFile={(filePath) => openContextTab("files", filePath)} onOpenReviews={(filePath) => openContextTab("reviews", filePath)} />
                    : <SessionMessage key={item.id} message={item} logoUri={props.logoUri} onActionFeedback={(notice) => setLocalFeedback(notice)} onOpenFile={(filePath) => openContextTab("files", filePath)} onOpenReviews={(filePath) => openContextTab("reviews", filePath)} />)}
                  {props.sending || (props.selectedSession?.status === "running" && !hasInProgressActivity) ? <WorkingMessage /> : null}
                  <div ref={messagesEndRef} />
                </div>
                {!isNearMessageBottom ? <button type="button" class="cli-scroll-latest" aria-label="Scroll to latest message" title="Scroll to latest message" onClick={scrollToLatest}><ChevronIcon /> Latest</button> : null}
              </section>
              {selectedArchived ? (
                <div class="cli-archived-lock"><ArchiveIcon /><span><strong>This session is archived.</strong> Restore it to open or continue the conversation.</span><button type="button" class="cli-primary-button" disabled={props.mutating} onClick={() => props.onUnarchive(props.selectedSession!)}>Restore session</button></div>
              ) : composerBlockedByOwner ? (
                <div class="cli-composer-unavailable is-running" role="status"><span class="cli-live-spinner" aria-hidden="true" /><span><strong>Running in {props.selectedSession.runningBy ?? "another Codex process"}.</strong> Composer disabled here until that run finishes.</span></div>
              ) : (
                <Composer
                  draft={draft}
                  model={model}
                  reasoningEffort={reasoningEffort}
                  sandboxMode={sandboxMode}
                  projectPath={projectPath}
                  projects={composerProjects}
                  models={props.composerConfig?.models ?? []}
                  reasoningOptions={reasoningOptions}
                  sending={props.sending}
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
            </>
          ) : newChatProject !== undefined ? (
            <>
              <section class="cli-message-viewport cli-new-chat-viewport"><div class="cli-new-chat-copy"><span class="cli-empty-mark">{props.logoUri ? <img src={props.logoUri} alt="" aria-hidden="true" /> : <CodexSessionIcon />}</span><h2>What should we build in {projects.find((project) => project.path === newChatProject)?.label ?? "your workspace"}?</h2><p>Describe the task and Codex will work directly in this project.</p></div></section>
              <UsageBanner account={props.account} onAction={(message) => setLocalFeedback({ level: "info", message })} />
              <Composer draft={draft} model={model} reasoningEffort={reasoningEffort} sandboxMode={sandboxMode} projectPath={newChatProject} projects={composerProjects} models={props.composerConfig?.models ?? []} reasoningOptions={reasoningOptions} sending={props.starting} stopping={false} onDraft={setDraft} onModel={(nextModel) => { setModel(nextModel); const option = props.composerConfig?.models.find((item) => item.id === nextModel); setReasoningEffort(option?.defaultReasoningEffort ?? option?.reasoningEfforts[0]); }} onReasoning={setReasoningEffort} onSandbox={setSandboxMode} onProject={(next) => { setProjectPath(next); setNewChatProject(next); }} onSubmit={submit} composerHeight={layout.composerHeight} onResize={beginComposerResize} onResizeKeyDown={(event) => adjustComposerWithKeyboard(event.key, event.shiftKey)} onStop={() => undefined} />
            </>
          ) : <><WorkspaceEmpty logoUri={props.logoUri} running={runningCount} active={activeSessions.length} archived={archivedSessions.length} />{composerProjects.length ? <Composer draft={draft} model={model} reasoningEffort={reasoningEffort} sandboxMode={sandboxMode} projectPath={projectPath} projects={composerProjects} models={props.composerConfig?.models ?? []} reasoningOptions={reasoningOptions} sending={props.starting} stopping={false} onDraft={setDraft} onModel={setModel} onReasoning={setReasoningEffort} onSandbox={setSandboxMode} onProject={setProjectPath} onSubmit={submit} composerHeight={layout.composerHeight} onResize={beginComposerResize} onResizeKeyDown={(event) => adjustComposerWithKeyboard(event.key, event.shiftKey)} onStop={() => undefined} /> : <div class="cli-composer-unavailable" role="status">Composer unavailable until a project is open.</div>}</>}
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
          projectPath={selectedProjectPath}
          terminalWidth={layout.terminalWidth}
          draft={terminalDraft}
          results={props.terminalResults}
          terminals={props.workspaceTerminals}
          running={props.terminalRunning}
          stopping={props.terminalStopping}
          collapsed={contextCollapsed}
          tabs={contextTabs}
          activeTab={activeContextTab}
          addOpen={contextAddOpen}
          files={props.workspaceFiles}
          filesByPath={props.workspaceFilesByPath}
          fileChanges={railFiles}
          agents={railAgents}
          filesLoading={props.workspaceFilesLoading}
          fileLoading={props.workspaceFileLoading}
          fileSaving={props.workspaceFileSaving}
          onDraft={setTerminalDraft}
          onRun={(command) => { props.onRunTerminal(command, props.selectedSession?.projectPath ?? newChatProject ?? projectPath, WORKSPACE_TERMINAL_ID); setTerminalDraft(""); }}
          onListTerminals={props.onListTerminals}
          onCreateTerminal={(profile) => props.onCreateTerminal(profile, selectedProjectPath)}
          onFocusTerminal={props.onFocusTerminal}
          onFeedback={setLocalFeedback}
          onStop={() => props.onCancelTerminal(WORKSPACE_TERMINAL_ID)}
          onClear={props.onClearTerminal}
          onCollapse={() => setContextCollapsed(true)}
          onTab={selectContextTab}
          onAddToggle={() => setContextAddOpen((open) => !open)}
          onAdd={openContextTab}
          onCloseTab={(tab) => { const next = contextTabs.filter((item) => item !== tab); setContextTabs(next); if (activeContextTab === tab) setActiveContextTab(next.at(-1) ?? "terminal"); }}
          onListFiles={() => props.onListFiles(selectedProjectPath)}
          onReadFile={(filePath) => props.onReadFile(filePath, selectedProjectPath)}
          onClearFile={props.onClearFile}
          onDeleteFile={(filePath) => props.onDeleteFile(filePath, selectedProjectPath)}
          onSaveFile={(filePath, content) => props.onSaveFile(filePath, content, selectedProjectPath)}
          onResizePointerDown={(event) => beginPanelResize("terminal", event)}
          onResizeKeyDown={(event) => adjustPanelWithKeyboard("terminal", event.key, event.shiftKey)}
          onResizeReset={() => setLayout((current) => ({ ...current, terminalWidth: DEFAULT_WORKSPACE_LAYOUT.terminalWidth }))}
        />
      </div>
      {localFeedback ? <div class={`cli-workspace-feedback is-${localFeedback.level}`} role={localFeedback.level === "error" ? "alert" : "status"}><span>{localFeedback.message}</span><button type="button" aria-label="Dismiss message" onClick={() => setLocalFeedback(undefined)}>×</button></div> : null}
      {shareOpen && props.selectedSession ? <SessionShareModal title={props.selectedSession.title} url={window.location.href} onClose={() => setShareOpen(false)} onFeedback={setLocalFeedback} /> : null}
    </div>
  );
}

function ConversationHeader(props: {
  session: DashboardCliSessionSummary; archived: boolean; busy: boolean; sending: boolean;
  onBack: () => void; onRefresh: () => void;
  onRename: (name: string) => void; onFork: () => void; onCopyLink: () => void; onShare: () => void;
  onArchive: () => void; onRestore: () => void; onDelete: () => void; onRenameCancelled: () => void;
  environmentOpen: boolean; terminalCollapsed: boolean; onToggleEnvironment: () => void; onToggleTerminal: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(props.session.title);
  useEffect(() => setName(props.session.title), [props.session.id, props.session.title]);
  return <header class="cli-conversation-header">
    <button type="button" class="cli-mobile-back" onClick={props.onBack}><ArrowLeftIcon /> Sessions</button>
    <div class="cli-conversation-title"><div class="cli-conversation-title-line"><h1>{props.session.title}</h1><span class={`cli-state-pill ${props.archived ? "is-archived" : props.session.status === "running" ? "is-running" : ""}`}>{props.archived ? "Archived" : props.session.status === "running" ? "Running" : "Ready"}</span></div>{props.session.projectPath ? <div class="cli-conversation-project" title={props.session.projectPath}><EmptyFolderIcon /><strong>{projectDisplayName(props.session.projectPath)}</strong><span>{props.session.projectPath}</span></div> : null}</div>
    <div class="cli-conversation-actions">
      {!props.archived ? <><IconButton label="Refresh conversation" disabled={props.busy} onClick={props.onRefresh}><RefreshIcon /></IconButton><button type="button" class="cli-secondary-button" disabled={props.busy || props.sending} onClick={props.onShare}><ShareIcon /> Share</button></> : <button type="button" class="cli-secondary-button" disabled={props.busy} onClick={props.onRestore}><RestoreIcon /> Restore</button>}
      <IconButton label={props.environmentOpen ? "Hide Environment" : "Show Environment"} onClick={props.onToggleEnvironment}><ChangesIcon /></IconButton>
      {props.terminalCollapsed ? <IconButton label="Show workspace tools" title="Show Terminal, Files, and Reviews" onClick={props.onToggleTerminal}><PanelIcon /></IconButton> : null}
      <div class="cli-session-menu-wrap">
        <IconButton label="Session actions" disabled={props.busy || props.sending} onClick={() => setMenuOpen((open) => !open)}><MoreIcon /></IconButton>
        {menuOpen ? <div class="cli-session-menu" role="menu">
          {!props.archived ? <>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setRenaming(true); }}><PencilIcon /> Rename</button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onFork(); }}><ForkIcon /> Fork session</button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onArchive(); }}><ArchiveIcon /> Archive</button>
            <span />
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onShare(); }}><ShareIcon /> Share</button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onCopyLink(); }}><LinkIcon /> Copy link</button>
            <span />
          </> : null}
          <button type="button" role="menuitem" class="is-danger" onClick={() => { setMenuOpen(false); props.onDelete(); }}><TrashIcon /> Delete</button>
        </div> : null}
      </div>
    </div>
    {renaming ? <form class="cli-rename-form" onSubmit={(event) => { event.preventDefault(); const normalized = name.trim(); if (normalized) { props.onRename(normalized); setRenaming(false); } }}><PencilIcon /><input value={name} maxLength={160} autoFocus aria-label="Session name" onInput={(event) => setName(event.currentTarget.value)} /><button type="button" onClick={() => { setName(props.session.title); setRenaming(false); props.onRenameCancelled(); }}>Cancel</button><button type="submit" disabled={!name.trim()}>Save</button></form> : null}
  </header>;
}

function Composer(props: {
  draft: string; model?: string; reasoningEffort?: string; sandboxMode: DashboardCliSandboxMode;
  projectPath?: string; projects: Array<{ id: string; label: string; path: string }>;
  models: DashboardCliComposerConfig["models"]; reasoningOptions: string[]; sending: boolean; stopping: boolean;
  composerHeight: number;
  onDraft: (value: string) => void; onModel: (value: string) => void; onReasoning: (value: string) => void;
  onSandbox: (value: DashboardCliSandboxMode) => void; onProject: (value: string) => void; onSubmit: () => void; onStop: () => void;
  onResize: (event: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => void;
}) {
  const modelChoices = props.models.length > 0
    ? props.models
    : [{ id: "", label: "Default model", reasoningEfforts: props.reasoningOptions }];
  const modelReasoningOptions = modelChoices.flatMap((option) => {
    const efforts = option.reasoningEfforts.length > 0 ? option.reasoningEfforts : props.reasoningOptions;
    return (efforts.length > 0 ? efforts : ["medium"]).map((effort) => ({
      key: `${option.id}\u0000${effort}`,
      model: option.id,
      reasoning: effort,
      label: `${option.label} · ${effort === "xhigh" ? "Extra high" : capitalize(effort)}`
    }));
  });
  const selectedModelReasoning = modelReasoningOptions.find((option) => option.model === (props.model ?? "") && option.reasoning === (props.reasoningEffort ?? ""))
    ?? modelReasoningOptions.find((option) => option.model === (props.model ?? ""))
    ?? modelReasoningOptions[0];

  return <form class="cli-composer" style={`height:${props.composerHeight}px`} onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
    <div class="cli-composer-resizer" role="separator" aria-label="Resize message composer" aria-orientation="horizontal" aria-valuemin={120} aria-valuenow={Math.round(props.composerHeight)} tabIndex={0} onPointerDown={props.onResize} onKeyDown={props.onResizeKeyDown}><span /></div>
    <textarea name="codex-message" value={props.draft} rows={3} maxLength={64_000} placeholder="Message Codex…" aria-label="Message Codex" disabled={props.sending} onInput={(event) => props.onDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); props.onSubmit(); } }} />
    <div class="cli-composer-toolbar"><div class="cli-composer-selectors">
      <label class="cli-composer-control" title="Project"><EmptyFolderIcon /><select name="project-path" value={props.projectPath ?? ""} aria-label="Project" onChange={(event) => props.onProject(event.currentTarget.value)}>{props.projects.map((project) => <option value={project.path} key={project.id}>{project.label}</option>)}</select></label>
      <label class="cli-composer-control" title="Filesystem access"><ShieldIcon /><select name="sandbox-mode" value={props.sandboxMode} aria-label="Access mode" onChange={(event) => props.onSandbox(event.currentTarget.value as DashboardCliSandboxMode)}><option value="read-only">Read only</option><option value="workspace-write">Workspace</option><option value="danger-full-access">Full access</option></select></label>
    </div><div class="cli-composer-submit">
      <label class="cli-composer-control cli-composer-model-picker" title="Model and reasoning"><select name="model-reasoning" value={selectedModelReasoning?.key ?? ""} aria-label="Model and reasoning" onChange={(event) => { const selection = modelReasoningOptions.find((option) => option.key === event.currentTarget.value); if (selection) { props.onModel(selection.model); props.onReasoning(selection.reasoning); } }}>{modelReasoningOptions.map((option) => <option value={option.key} key={option.key}>{option.label}</option>)}</select></label>
      <span>{props.draft.length > 60_000 ? `${64_000 - props.draft.length} left` : null}</span>{props.sending ? <button type="button" class="cli-stop-button" disabled={props.stopping} aria-busy={props.stopping} onClick={props.onStop}><StopIcon /> {props.stopping ? "Stopping" : "Stop"}</button> : <button type="submit" class="cli-send-button" disabled={!props.draft.trim()} aria-label="Send message" title="Send message"><SendIcon /></button>}</div></div>
  </form>;
}

function SessionMessage({ message, logoUri, onActionFeedback, onOpenFile, onOpenReviews }: { message: DashboardCliSessionMessage; logoUri?: string; onActionFeedback?: (notice: DashboardNotice) => void; onOpenFile?: (filePath: string) => void; onOpenReviews?: (filePath?: string) => void }) {
  if (!message.kind || message.kind === "message") {
    const isUser = message.role === "user";
    return <article class={`cli-session-message is-${message.role ?? "assistant"}`}><div class="cli-session-avatar">{isUser ? "Y" : logoUri ? <img src={logoUri} alt="" aria-hidden="true" /> : <CodexSessionIcon />}</div><div class="cli-session-message-body"><div class="cli-session-message-head"><strong>{isUser ? "You" : "Codex"}</strong><time>{formatTime(message.timestamp)}</time></div>{message.text ? <div class="cli-session-message-text">{isUser ? message.text : renderMessageText(message.text)}</div> : null}{message.images?.length ? <div class="cli-session-images">{message.images.map((image, index) => <a href={image.src} target="_blank" rel="noreferrer" aria-label={`Open ${image.alt ?? "attached image"}`}><img src={image.src} alt={image.alt ?? `Attached image ${index + 1}`} loading="lazy" /></a>)}</div> : null}{!isUser && message.text.trim() ? <MessageActions text={message.text} onActionFeedback={onActionFeedback} /> : null}</div></article>;
  }
  return <ActivityMessage message={message} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} />;
}

function renderMessageText(text: string): preact.ComponentChildren {
  const blocks = text.split(/(```[\s\S]*?```)/g);
  return blocks.map((block, index) => {
    if (!block.startsWith("```")) {
      return splitMessageParagraphs(block).map((paragraph, paragraphIndex) => (
        <span class="cli-message-paragraph" key={`text-${index}-${paragraphIndex}`}>
          {renderInlineText(paragraph, `text-${index}-${paragraphIndex}`)}
        </span>
      ));
    }
    const match = block.match(/^```([^\n]*)\n?([\s\S]*?)```$/);
    const language = match?.[1]?.trim();
    const code = match?.[2] ?? block.slice(3, -3);
    return <pre class="cli-message-code" key={`code-${index}`} data-language={language || undefined}><code>{code.replace(/\n$/, "")}</code></pre>;
  });
}

export function splitMessageParagraphs(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split(/\n{2,}/).filter((paragraph) => paragraph.length > 0);
}

function renderInlineText(text: string, keyPrefix: string): preact.ComponentChildren {
  return text.split(/(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[[^\]]+\]\([^\s)]+\))/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code class="cli-inline-code" key={`${keyPrefix}-code-${index}`}>{part.slice(1, -1)}</code>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
    if (link) {
      const href = link[2]!.match(/^(https?:\/\/|mailto:|\/)/i) ? link[2]! : undefined;
      return href ? <a class="cli-message-link" href={href} target="_blank" rel="noreferrer" key={`${keyPrefix}-link-${index}`}>{link[1]}</a> : part;
    }
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      return <strong key={`${keyPrefix}-strong-${index}`}>{part.slice(2, -2)}</strong>;
    }
    if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) {
      return <em key={`${keyPrefix}-em-${index}`}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

function MessageActions({ text, onActionFeedback }: { text: string; onActionFeedback?: (notice: DashboardNotice) => void }) {
  const run = async (action: "copy" | "like" | "dislike"): Promise<void> => {
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(text);
        onActionFeedback?.({ level: "info", message: "Response copied." });
      } catch {
        onActionFeedback?.({ level: "error", message: "Response could not be copied." });
      }
      return;
    }
    onActionFeedback?.({ level: "info", message: action === "like" ? "Thanks for the feedback." : "Feedback noted." });
  };
  return <div class="cli-message-actions" aria-label="Response actions"><button type="button" aria-label="Copy response" title="Copy response" onClick={() => void run("copy")}><CopyIcon /></button><button type="button" aria-label="Good response" title="Good response" onClick={() => void run("like")}><ThumbsUpIcon /></button><button type="button" aria-label="Needs improvement" title="Needs improvement" onClick={() => void run("dislike")}><ThumbsDownIcon /></button></div>;
}

function ActivityMessage({ message, onOpenFile, onOpenReviews }: { message: DashboardCliSessionMessage; onOpenFile?: (filePath: string) => void; onOpenReviews?: (filePath?: string) => void }) {
  const running = message.status === "inProgress";
  const failed = message.status === "failed" || message.kind === "error";
  return <details class={`cli-activity is-${message.kind} ${running ? "is-running" : ""} ${failed ? "is-failed" : ""}`} open={running}>
    <summary>
      <span class="cli-activity-icon"><ActivityGlyph kind={message.kind} /></span>
      <span class="cli-activity-heading"><strong>{activityLabel(message)}</strong><small>{activityMeta(message)}</small></span>
      <span class={`cli-activity-status is-${message.status ?? "completed"}`}>{running ? <i /> : failed ? "Failed" : message.status === "declined" ? "Declined" : <CheckIcon />}</span>
      <ChevronIcon />
    </summary>
    <div class="cli-activity-body">
      {message.kind === "command" ? <>
        <pre class="cli-activity-code"><code>{message.command ?? message.text}</code></pre>
        {message.cwd ? <div class="cli-activity-path">in {message.cwd}</div> : null}
        {message.output ? <pre class="cli-activity-output"><code>{message.output}</code></pre> : <div class="cli-activity-copy">{running ? "Waiting for command output…" : "No command output."}</div>}
      </> : message.kind === "file-change" ? <FileChangeDetails changes={message.changes ?? []} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} /> : message.kind === "tool-call" ? <>
        <div class="cli-activity-copy cli-human-summary">{message.text}</div>
        {message.result && message.result !== message.text ? <div class={`cli-activity-result ${failed ? "is-error" : ""}`}><strong>{failed ? "Error" : "Result"}</strong><span>{message.result}</span></div> : null}
        {message.debug ? <details class="cli-debug-details"><summary>Debug details</summary><pre><code>{message.debug}</code></pre></details> : null}
      </> : message.kind === "image" ? <><div class="cli-activity-copy">{message.text}</div>{message.images?.length ? <div class="cli-session-images cli-activity-images">{message.images.map((image, index) => <a href={image.src} target="_blank" rel="noreferrer" aria-label={`Open ${image.alt ?? "image"}`}><img src={image.src} alt={image.alt ?? `Image ${index + 1}`} loading="lazy" /></a>)}</div> : null}</> : <div class="cli-activity-copy">{message.text}</div>}
    </div>
  </details>;
}

function FileChangeDetails({ changes, onOpenFile, onOpenReviews }: { changes: NonNullable<DashboardCliSessionMessage["changes"]>; onOpenFile?: (filePath: string) => void; onOpenReviews?: (filePath?: string) => void }) {
  if (changes.length === 0) return <div class="cli-activity-copy">File changes are being prepared…</div>;
  return <div class="cli-file-change-list"><button type="button" class="cli-open-reviews" onClick={() => onOpenReviews?.()}><ReviewIcon /> Open all in Reviews</button>{changes.map((change) => <details key={`${change.path}-${change.kind}`}>
    <summary><span><FileIcon /><strong>{change.path}</strong></span><button type="button" onClick={(event) => { event.preventDefault(); onOpenFile?.(change.path); }}>Open</button><button type="button" onClick={(event) => { event.preventDefault(); onOpenReviews?.(change.path); }}>Review</button><small>{capitalize(change.kind)}</small><ChevronIcon /></summary>
    {change.diff ? <pre class="cli-activity-output is-diff"><code>{change.diff}</code></pre> : <div class="cli-activity-copy">No diff details were recorded.</div>}
  </details>)}</div>;
}

function EnvironmentPopover(props: {
  environment?: DashboardWorkspaceEnvironment;
  loading: boolean;
  projectPath?: string;
  width: number;
  height: number;
  onResize: (width: number, height: number) => void;
  onClose: () => void;
  onRefresh: (projectPath?: string) => void;
  onCommit: (message: string, projectPath?: string) => void;
  onPush: (projectPath?: string) => void;
  onCompare: () => void;
}) {
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [pushConfirm, setPushConfirm] = useState(false);
  const environment = props.environment;
  const beginResize = (event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent): void => props.onResize(
      clamp(props.width + moveEvent.clientX - startX, 280),
      clamp(props.height + moveEvent.clientY - startY, 220)
    );
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };
  return <aside class="cli-environment-popover" aria-label="Environment" aria-busy={props.loading}>
    <header><strong>Environment</strong><span><IconButton label="Refresh Environment" disabled={props.loading} onClick={() => props.onRefresh(props.projectPath)}><RefreshIcon /></IconButton><IconButton label="Close Environment" onClick={props.onClose}><CloseIcon /></IconButton></span></header>
    <div class="cli-environment-list">
      <div class="cli-environment-row"><ChangesIcon /><span><strong>Changes</strong><small>{environment?.isGitRepository === false ? "Not a Git repository" : `${environment?.changes ?? 0} files`}</small></span><b><i>+{environment?.additions ?? 0}</i><em>−{environment?.deletions ?? 0}</em></b></div>
      <div class="cli-environment-row"><EmptyFolderIcon /><span><strong>{environment?.projectName ?? (projectDisplayName(props.projectPath ?? "") || "Local")}</strong><small title={environment?.projectPath ?? props.projectPath}>{environment?.projectPath ?? props.projectPath ?? "No project selected"}</small></span></div>
      <div class="cli-environment-row"><ForkIcon /><span><strong>{environment?.branch ?? "No branch"}</strong><small>{environment?.upstream ?? (environment?.isGitRepository ? "Local branch" : "Git unavailable")}{environment?.ahead ? ` · ${environment.ahead} ahead` : ""}{environment?.behind ? ` · ${environment.behind} behind` : ""}</small></span></div>
    </div>
    <div class="cli-environment-actions">
      {!commitOpen ? <button type="button" disabled={!environment?.isGitRepository || !environment.changes} onClick={() => setCommitOpen(true)}><ChangesIcon /> Commit changes</button> : <form onSubmit={(event) => { event.preventDefault(); const message = commitMessage.trim(); if (!message) return; props.onCommit(message, props.projectPath); setCommitMessage(""); setCommitOpen(false); }}><label htmlFor="workspace-commit-message">Commit message</label><input id="workspace-commit-message" name="commit-message" value={commitMessage} maxLength={200} autoComplete="off" placeholder="Describe this change…" onInput={(event) => setCommitMessage(event.currentTarget.value)} /><span><button type="button" onClick={() => { setCommitOpen(false); setCommitMessage(""); }}>Cancel</button><button type="submit" disabled={!commitMessage.trim()}>Commit all</button></span></form>}
      {!pushConfirm ? <button type="button" disabled={!environment?.isGitRepository || !environment.hasRemote} onClick={() => setPushConfirm(true)}><SendIcon /> Push branch</button> : <div class="cli-environment-confirm"><span>Push {environment?.branch ?? "this branch"} to its remote?</span><div><button type="button" onClick={() => setPushConfirm(false)}>Cancel</button><button type="button" onClick={() => { setPushConfirm(false); props.onPush(props.projectPath); }}>Push</button></div></div>}
      <button type="button" disabled={!environment?.isGitRepository} onClick={props.onCompare}><ReviewIcon /> Compare branch</button>
    </div>
    {props.loading ? <div class="cli-environment-loading" role="status">Refreshing Environment…</div> : null}
    <div class="cli-environment-resize" role="separator" aria-label="Resize Environment panel" aria-orientation="horizontal" aria-valuemin={220} aria-valuenow={Math.round(props.height)} tabIndex={0} onPointerDown={beginResize} onKeyDown={(event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.shiftKey ? 40 : 10;
      const width = event.key === "ArrowLeft" ? props.width - step : event.key === "ArrowRight" ? props.width + step : props.width;
      const height = event.key === "ArrowUp" ? props.height + step : event.key === "ArrowDown" ? props.height - step : props.height;
      props.onResize(clamp(width, 280), clamp(height, 220));
    }} />
  </aside>;
}

export type ConsolidatedSessionItem = DashboardCliSessionMessage | {
  id: string;
  messages: DashboardCliSessionMessage[];
};

export function consolidateSessionMessages(messages: DashboardCliSessionMessage[]): ConsolidatedSessionItem[] {
  const result: ConsolidatedSessionItem[] = [];
  let turn: DashboardCliSessionMessage[] = [];
  const flushTurn = (): void => {
    let liveReasoningIndex = -1;
    for (let index = turn.length - 1; index >= 0; index -= 1) {
      if (turn[index]!.kind === "reasoning" && turn[index]!.status === "inProgress") {
        liveReasoningIndex = index;
        break;
      }
    }
    const liveActivityIndexes = new Set(turn.flatMap((message, index) =>
      isGroupableTurnActivity(message) && message.status === "inProgress" ? [index] : []
    ));

    const completed = turn.flatMap((message, index) => {
      if (!isGroupableTurnActivity(message) || liveActivityIndexes.has(index)) return [];
      return [message];
    });
    let groupInserted = false;
    for (const message of turn) {
      if (isGroupableTurnActivity(message)) {
        if (!groupInserted && completed.length > 0) {
          result.push({ id: `activity-group-${completed[0]!.id}`, messages: completed });
          groupInserted = true;
        }
        continue;
      }
      if (message.kind === "image") {
        if (message.status !== "inProgress") result.push(message);
        continue;
      }
      if (isTurnActivity(message)) continue;
      result.push(message);
    }
    // Keep every live tool visible. Multiple tools can run concurrently; the
    // former single-index approach silently converted all but the newest one
    // into completed activity. Reasoning remains a single rolling live item.
    for (const [index, message] of turn.entries()) {
      if (liveActivityIndexes.has(index) || index === liveReasoningIndex || (message.kind === "image" && message.status === "inProgress")) {
        result.push(message);
      }
    }
    turn = [];
  };
  for (const message of messages) {
    if (message.kind === "message" && message.role === "user") {
      flushTurn();
      result.push(message);
    } else {
      turn.push(message);
    }
  }
  flushTurn();
  return result;
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
  return isTurnActivity(message) && message.kind !== "reasoning" && message.kind !== "image";
}

function ActivityGroup({ messages, onOpenFile, onOpenReviews }: { messages: DashboardCliSessionMessage[]; onOpenFile?: (filePath: string) => void; onOpenReviews?: (filePath?: string) => void }) {
  const running = messages.some((message) => message.status === "inProgress");
  const failed = messages.some((message) => message.status === "failed" || message.kind === "error");
  return <details class={`cli-activity-group ${running ? "is-running" : ""} ${failed ? "is-failed" : ""}`} open={running}>
    <summary>
      <span class="cli-activity-icon"><ToolIcon /></span>
      <span class="cli-activity-heading"><strong>{consolidatedActivityLabel(messages)}</strong></span>
      <span class={`cli-activity-status ${running ? "is-inProgress" : failed ? "is-failed" : "is-completed"}`}>{running ? <i /> : failed ? "Failed" : <CheckIcon />}</span>
      <ChevronIcon />
    </summary>
    <div class="cli-activity-group-body">{messages.map((message) => <ActivityMessage key={message.id} message={message} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} />)}</div>
  </details>;
}

export function consolidatedActivityLabel(messages: DashboardCliSessionMessage[]): string {
  const counts = new Map<DashboardCliSessionMessage["kind"], number>();
  for (const message of messages) counts.set(message.kind, (counts.get(message.kind) ?? 0) + 1);
  const labels = [...counts].map(([kind, count]) => {
    switch (kind) {
      case "plan": return count === 1 ? "updated the plan" : `updated ${count} plans`;
      case "file-change": return count === 1 ? "edited a file" : `edited ${count} files`;
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
  projectPath?: string;
  terminalWidth: number;
  draft: string;
  results: DashboardWorkspaceTerminalResult[];
  terminals: DashboardWorkspaceTerminalInfo[];
  running: boolean;
  stopping: boolean;
  collapsed: boolean;
  tabs: WorkspaceTab[];
  activeTab: WorkspaceTab;
  addOpen: boolean;
  files: DashboardWorkspaceFileEntry[];
  filesByPath: Record<string, DashboardWorkspaceFile>;
  fileChanges: Array<{ path: string; diff?: string }>;
  agents: DashboardCliSessionMessage[];
  filesLoading: boolean;
  fileLoading: boolean;
  fileSaving: boolean;
  onDraft: (value: string) => void;
  onRun: (command: string) => void;
  onListTerminals: () => void;
  onCreateTerminal: (profile: "default" | "powershell" | "cmd" | "bash") => void;
  onFocusTerminal: (terminalId: string) => void;
  onFeedback: (notice: DashboardNotice) => void;
  onStop: () => void;
  onClear: () => void;
  onCollapse: () => void;
  onTab: (tab: WorkspaceTab) => void;
  onAddToggle: () => void;
  onAdd: (tab: WorkspaceToolTab, filePath?: string) => void;
  onCloseTab: (tab: WorkspaceTab) => void;
  onListFiles: () => void;
  onReadFile: (filePath: string) => void;
  onClearFile: () => void;
  onDeleteFile: (filePath: string) => void;
  onSaveFile: (filePath: string, content: string) => void;
  onResizePointerDown: (event: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => void;
  onResizeReset: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [props.results.length, props.running]);
  useEffect(() => {
    const activeTab = tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    activeTab?.closest("span")?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [props.activeTab, props.tabs.length]);
  if (props.collapsed) return <aside class="cli-terminal-panel is-collapsed" aria-hidden="true" />;
  const activeKind = workspaceTabKind(props.activeTab);
  const activePath = workspaceTabPath(props.activeTab);
  return <aside class="cli-terminal-panel cli-context-panel-v3" aria-label="Workspace tools">
    <div class="cli-context-edge-resizer" role="separator" aria-label="Resize terminal panel" aria-orientation="vertical" aria-valuemin={280} aria-valuenow={Math.round(props.terminalWidth)} tabIndex={0} onPointerDown={props.onResizePointerDown} onKeyDown={props.onResizeKeyDown} onDblClick={props.onResizeReset}><span /></div>
    <header class="cli-context-tabbar"><div class="cli-context-tabs-v3" role="tablist" aria-label="Workspace tools"><div ref={tabsRef} class="cli-context-tab-scroll" onWheel={(event) => { const target = event.currentTarget; if (target.scrollWidth <= target.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return; event.preventDefault(); target.scrollLeft += event.deltaY; }}>{props.tabs.map((tab) => { const kind = workspaceTabKind(tab); const path = workspaceTabPath(tab); const label = path ? path.split(/[\\/]/).pop() ?? path : capitalize(kind); return <span class={props.activeTab === tab ? "is-active" : ""} key={tab}><button type="button" role="tab" aria-selected={props.activeTab === tab} onClick={() => props.onTab(tab)} title={path ?? kind}>{kind === "terminal" ? <TerminalIcon /> : kind === "files" ? <FileIcon /> : <ReviewIcon />}<span class="cli-context-tab-label">{label}</span></button><button type="button" aria-label={`Close ${label}`} onClick={() => props.onCloseTab(tab)}>×</button></span>; })}</div><span class="cli-context-add-wrap"><button type="button" class="cli-context-add" aria-label="Add workspace tab" aria-expanded={props.addOpen} onClick={props.onAddToggle}><PlusIcon /></button>{props.addOpen ? <div class="cli-context-add-menu" role="menu">{(["terminal", "files", "reviews"] as const).filter((tab) => !props.tabs.includes(tab)).map((tab) => <button type="button" role="menuitem" onClick={() => props.onAdd(tab)}>{tab === "terminal" ? <TerminalIcon /> : tab === "files" ? <FileIcon /> : <ReviewIcon />}{capitalize(tab)}</button>)}{(["terminal", "files", "reviews"] as const).every((tab) => props.tabs.includes(tab)) ? <span>All tools are open</span> : null}</div> : null}</span></div><span class="cli-terminal-header-actions">{activeKind === "terminal" ? <TerminalProfileMenu onCreate={props.onCreateTerminal} /> : null}<IconButton label="Hide workspace tools" onClick={props.onCollapse}><CloseIcon /></IconButton></span></header>
    {props.tabs.includes(props.activeTab) && props.activeTab === "terminal" ? <>
    <div class="cli-terminal-toolbar"><label>VS Code terminal<select aria-label="Select VS Code terminal" value={props.terminals.find((terminal) => terminal.isActive)?.id ?? ""} onChange={(event) => { const id = event.currentTarget.value; if (id) props.onFocusTerminal(id); }}><option value="">Select terminal…</option>{props.terminals.map((terminal) => <option value={terminal.id}>{terminal.name} · {terminal.state}</option>)}</select></label><button type="button" class="cli-terminal-refresh" onClick={props.onListTerminals} title="Refresh running terminals"><RefreshIcon /></button></div>
    <div class="cli-terminal-output" role="log" aria-live="polite">
      {props.results.length === 0 ? <div class="cli-terminal-welcome"><strong>Project terminal</strong><span>Commands run in the selected workspace and report their final status here.</span></div> : null}
      {props.results.map((result) => <article class={`is-${result.status}`} key={result.id}><div><span aria-hidden="true">›</span><code>{result.command}</code></div><pre>{result.output}</pre><small>{result.status} · {formatTerminalDuration(result.durationMs)}{result.exitCode !== undefined ? ` · exit ${result.exitCode}` : ""}</small></article>)}
      {props.running ? <div class="cli-terminal-running" role="status"><span class="cli-live-spinner" aria-hidden="true" /> Running command…</div> : null}
      <div ref={endRef} />
    </div>
    <form class="cli-terminal-command" onSubmit={(event) => { event.preventDefault(); const command = props.draft.trim(); if (command && !props.running) props.onRun(command); }}>
      <span aria-hidden="true">$</span><input name="terminal-command" value={props.draft} autoComplete="off" spellcheck={false} aria-label="Terminal command" placeholder="Run a command…" disabled={props.running} onInput={(event) => props.onDraft(event.currentTarget.value)} />
      {props.running ? <button type="button" class="is-stop" disabled={props.stopping} onClick={props.onStop}><StopIcon /> {props.stopping ? "Stopping…" : "Stop"}</button> : <button type="submit" disabled={!props.draft.trim()} aria-label="Run terminal command"><SendIcon /></button>}
    </form>
    </> : props.tabs.includes(props.activeTab) && activeKind === "files" ? <WorkspaceFilesView files={props.files} file={activePath ? props.filesByPath[activePath] : undefined} activePath={activePath} loading={props.filesLoading} fileLoading={props.fileLoading} saving={props.fileSaving} onRefresh={props.onListFiles} onOpenFile={(filePath) => props.onAdd("files", filePath)} onDeleteFile={props.onDeleteFile} onFeedback={props.onFeedback} onSave={props.onSaveFile} /> : props.tabs.includes(props.activeTab) && activeKind === "reviews" ? <WorkspaceReviewsView changes={props.fileChanges} agents={props.agents} activePath={activePath} onOpenFile={(filePath) => props.onAdd("files", filePath)} onOpenReview={(filePath) => props.onAdd("reviews", filePath)} onFeedback={props.onFeedback} /> : <div class="cli-context-empty cli-context-empty-start"><PanelIcon /><strong>Select a tool</strong><span>Use + to open Terminal, Files, or Reviews.</span></div>}
  </aside>;
}

function TerminalProfileMenu(props: { onCreate: (profile: "default" | "powershell" | "cmd" | "bash") => void }) {
  const [open, setOpen] = useState(false);
  return <span class="cli-terminal-profile-wrap"><button type="button" class="cli-terminal-new" aria-label="New VS Code terminal" aria-expanded={open} onClick={() => setOpen((value) => !value)}><PlusIcon /> New</button>{open ? <div class="cli-terminal-profile-menu" role="menu"><strong>New terminal</strong>{(["default", "powershell", "cmd", "bash"] as const).map((profile) => <button type="button" role="menuitem" onClick={() => { setOpen(false); props.onCreate(profile); }}>{profile === "default" ? "VS Code default" : profile === "powershell" ? "PowerShell" : profile.toUpperCase()}</button>)}</div> : null}</span>;
}

function WorkspaceFilesView(props: {
  files: DashboardWorkspaceFileEntry[];
  file?: DashboardWorkspaceFile;
  activePath?: string;
  loading: boolean;
  fileLoading: boolean;
  saving: boolean;
  onRefresh: () => void;
  onOpenFile: (filePath: string) => void;
  onDeleteFile: (filePath: string) => void;
  onFeedback: (notice: DashboardNotice) => void;
  onSave: (filePath: string, content: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [documentModes, setDocumentModes] = useState<Record<string, "edit" | "preview">>({});
  const cutSelectionRef = useRef<(() => Promise<boolean>)>();
  const [canCut, setCanCut] = useState(false);
  const [fileMenu, setFileMenu] = useState<{ entry: DashboardWorkspaceFileEntry; x: number; y: number }>();
  const [deleteTarget, setDeleteTarget] = useState<DashboardWorkspaceFileEntry>();
  useEffect(() => {
    if (!fileMenu) return;
    const close = (): void => setFileMenu(undefined);
    document.addEventListener("click", close);
    document.addEventListener("scroll", close, true);
    return () => { document.removeEventListener("click", close); document.removeEventListener("scroll", close, true); };
  }, [fileMenu]);
  useEffect(() => {
    if (!props.file?.path) return;
    setDrafts((current) => current[props.file!.path] === undefined ? { ...current, [props.file!.path]: props.file!.content } : current);
  }, [props.file?.path, props.file?.content]);
  const hiddenByParent = (entry: DashboardWorkspaceFileEntry): boolean => {
    const segments = entry.path.split("/");
    return segments.slice(0, -1).some((_segment, index) => collapsed[segments.slice(0, index + 1).join("/")]);
  };
  const currentPath = props.activePath;
  const fileReady = Boolean(currentPath && props.file?.path === currentPath);
  const draft = fileReady && currentPath ? drafts[currentPath] ?? props.file?.content ?? "" : "";
  const dirty = Boolean(fileReady && currentPath && props.file?.kind === "text" && draft !== props.file.content);
  const markdownPreview = Boolean(fileReady && props.file?.language === "markdown" && (documentModes[props.file.path] ?? "preview") === "preview");
  const openFile = (path: string): void => {
    props.onOpenFile(path);
  };
  return <div class={currentPath ? "cli-files-workbench is-detail" : "cli-files-workbench is-list"}>
    {currentPath ? null : <div class="cli-file-tree"><header><strong>Project files</strong><IconButton label="Refresh files" disabled={props.loading} onClick={props.onRefresh}><RefreshIcon /></IconButton></header>{props.loading && props.files.length === 0 ? <span class="cli-context-loading">Loading files…</span> : props.files.filter((entry) => !hiddenByParent(entry)).map((entry) => entry.type === "directory" ? <button type="button" class="is-directory" style={`--tree-depth:${entry.depth}`} onContextMenu={(event) => { event.preventDefault(); setFileMenu({ entry, x: event.clientX, y: event.clientY }); }} onClick={() => setCollapsed((current) => ({ ...current, [entry.path]: !current[entry.path] }))}><ChevronIcon /><EmptyFolderIcon /><span>{entry.name}</span></button> : <button type="button" class={currentPath === entry.path ? "is-selected" : ""} style={`--tree-depth:${entry.depth}`} onContextMenu={(event) => { event.preventDefault(); setFileMenu({ entry, x: event.clientX, y: event.clientY }); }} onClick={() => openFile(entry.path)}><FileIcon /><span>{entry.name}</span></button>)}</div>}
    {fileMenu ? createPortal(<div class="cli-file-context-menu" role="menu" style={{ left: `${Math.min(fileMenu.x, Math.max(8, window.innerWidth - 190))}px`, top: `${Math.min(fileMenu.y, Math.max(8, window.innerHeight - 150))}px` }} onClick={(event) => event.stopPropagation()}><strong title={fileMenu.entry.path}>{fileMenu.entry.name}</strong>{fileMenu.entry.type === "file" ? <button type="button" role="menuitem" onClick={() => { setFileMenu(undefined); openFile(fileMenu.entry.path); }}><FileIcon /> Open</button> : <button type="button" role="menuitem" onClick={() => { setFileMenu(undefined); setCollapsed((current) => ({ ...current, [fileMenu.entry.path]: !current[fileMenu.entry.path] })); }}><EmptyFolderIcon /> Expand / collapse</button>}<button type="button" role="menuitem" onClick={() => { const selected = fileMenu.entry.path; setFileMenu(undefined); void navigator.clipboard.writeText(selected).then(() => props.onFeedback({ level: "info", message: "File path copied." }), () => props.onFeedback({ level: "error", message: "File path could not be copied." })); }}><LinkIcon /> Copy path</button>{fileMenu.entry.type === "file" ? <button type="button" role="menuitem" class="is-danger" onClick={() => { setDeleteTarget(fileMenu.entry); setFileMenu(undefined); }}><TrashIcon /> Delete</button> : null}</div>, document.body) : null}
    {deleteTarget ? <DeleteConfirmation compact title={deleteTarget.name} onCancel={() => setDeleteTarget(undefined)} onDelete={() => { const target = deleteTarget; setDeleteTarget(undefined); props.onDeleteFile(target.path); }} /> : null}
    {currentPath ? <div class="cli-file-editor">{fileReady && props.file ? <><header><span><strong>{props.file.path}</strong><small>{dirty ? "Modified" : `${props.file.kind === "text" ? props.file.language : props.file.mimeType} · ${formatFileSize(props.file.size)}`}</small></span><span class="cli-file-actions">{props.file.language === "markdown" ? <button type="button" onClick={() => setDocumentModes((current) => ({ ...current, [props.file!.path]: markdownPreview ? "edit" : "preview" }))}>{markdownPreview ? "Edit" : "Preview"}</button> : null}{props.file.kind === "text" && !markdownPreview ? <button type="button" disabled={!canCut || props.fileLoading || props.saving} onClick={() => void cutSelectionRef.current?.()} title="Cut selected code to the clipboard">Cut</button> : null}{props.file.kind === "text" ? <button type="button" disabled={!dirty || props.saving} onClick={() => props.onSave(props.file!.path, draft)}>{props.saving ? "Saving…" : "Save"}</button> : null}</span></header>{props.file.kind === "image" && props.file.dataUrl ? <figure class="cli-file-image-preview"><img src={props.file.dataUrl} alt={props.file.path} /><figcaption>{props.file.mimeType} · {formatFileSize(props.file.size)}</figcaption></figure> : props.file.kind === "audio" && props.file.dataUrl ? <div class="cli-file-media-preview"><FileIcon /><audio controls preload="metadata" src={props.file.dataUrl}>Audio preview is not supported by this browser.</audio><small>{props.file.mimeType} · {formatFileSize(props.file.size)}</small></div> : props.file.kind === "video" && props.file.dataUrl ? <div class="cli-file-media-preview is-video"><FileIcon /><video controls preload="metadata" src={props.file.dataUrl}>Video preview is not supported by this browser.</video><small>{props.file.mimeType} · {formatFileSize(props.file.size)}</small></div> : props.file.kind === "pdf" && props.file.dataUrl ? <iframe class="cli-file-pdf-preview" title={`Preview ${props.file.path}`} src={props.file.dataUrl} /> : props.file.kind === "document" ? <iframe class="cli-file-document-preview" title={`Preview ${props.file.path}`} sandbox="" srcDoc={`<!doctype html><meta charset="utf-8"><style>body{max-width:760px;margin:0 auto;padding:32px;color:#24292f;background:#fff;font:15px/1.65 Georgia,serif}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{padding:6px;border:1px solid #d0d7de}</style>${props.file.content}`} /> : markdownPreview ? <MarkdownPreview content={draft} /> : <WorkspaceCodeEditor path={props.file.path} language={props.file.language} value={draft} disabled={props.fileLoading || props.saving} onChange={(value) => setDrafts((current) => ({ ...current, [props.file!.path]: value }))} onSave={() => { if (dirty && !props.saving) props.onSave(props.file!.path, draft); }} onCutReady={(cut) => { cutSelectionRef.current = cut; setCanCut(Boolean(cut)); }} onSelectionChange={setCanCut} />}</> : <div class="cli-context-empty"><FileIcon /><span>Opening file…</span></div>}</div> : null}
  </div>;
}

function WorkspaceCodeEditor(props: { path: string; language: string; value: string; disabled: boolean; onChange: (value: string) => void; onSave: () => void; onCutReady?: (cut: (() => Promise<boolean>) | undefined) => void; onSelectionChange?: (canCut: boolean) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const editable = useRef(new Compartment());
  const onChangeRef = useRef(props.onChange);
  const onSaveRef = useRef(props.onSave);
  onChangeRef.current = props.onChange;
  onSaveRef.current = props.onSave;
  const cutSelection = async (): Promise<boolean> => {
    const view = viewRef.current;
    const selection = view?.state.selection.main;
    if (!view || !selection || selection.empty) return false;
    try {
      await navigator.clipboard.writeText(view.state.sliceDoc(selection.from, selection.to));
    } catch {
      return false;
    }
    view.dispatch({ changes: { from: selection.from, to: selection.to } });
    return true;
  };
  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          indentUnit.of("  "),
          editorLanguage(props.language),
          editable.current.of(EditorView.editable.of(!props.disabled)),
          keymap.of([indentWithTab, { key: "Mod-s", preventDefault: true, run: () => { onSaveRef.current(); return true; } }]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
            if (update.selectionSet || update.focusChanged) props.onSelectionChange?.(!update.state.selection.main.empty);
          }),
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "var(--bg-base)", color: "var(--text-primary)" },
            ".cm-scroller": { fontFamily: "var(--vscode-editor-font-family, Consolas, monospace)", fontSize: "11px", lineHeight: "1.55" },
            ".cm-gutters": { backgroundColor: "var(--bg-elevated)", color: "var(--text-muted)", borderRight: "1px solid var(--border-default)" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--bg-hover)" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--bg-selected) !important" },
            ".cm-cursor": { borderLeftColor: "var(--text-primary)" }
          }, { dark: true })
        ]
      })
    });
    viewRef.current = view;
    props.onCutReady?.(cutSelection);
    return () => { view.destroy(); viewRef.current = undefined; props.onCutReady?.(undefined); props.onSelectionChange?.(false); };
  }, [props.path, props.language]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!props.disabled)) });
  }, [props.disabled]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === props.value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } });
  }, [props.value]);
  return <div class="cli-code-editor" ref={containerRef} aria-label={`Edit ${props.path}`} />;
}

function editorLanguage(language: string): Extension {
  switch (language) {
    case "ts": case "typescript": return javascript({ typescript: true });
    case "tsx": case "typescriptreact": return javascript({ typescript: true, jsx: true });
    case "js": case "javascript": return javascript();
    case "jsx": case "javascriptreact": return javascript({ jsx: true });
    case "json": return json();
    case "css": case "scss": case "less": return css();
    case "html": case "htm": return html();
    case "md": case "markdown": return markdown();
    case "py": case "python": return python();
    case "java": return java();
    case "c": case "cc": case "cpp": case "cxx": case "h": case "hpp": return cpp();
    case "rs": case "rust": return rust();
    case "sql": return sql();
    case "xml": case "svg": return xml();
    case "yaml": case "yml": return yaml();
    default: return [];
  }
}

function MarkdownPreview(props: { content: string }) {
  return <article class="cli-markdown-preview" dangerouslySetInnerHTML={{ __html: markdownRenderer.render(props.content) }} />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function WorkspaceReviewsView(props: { changes: Array<{ path: string; diff?: string }>; agents: DashboardCliSessionMessage[]; activePath?: string; onOpenFile: (filePath: string) => void; onOpenReview: (filePath: string) => void; onFeedback: (notice: DashboardNotice) => void }) {
  const reviewPaths = props.changes.map((change) => change.path);
  const activeChange = props.changes.find((change) => change.path === props.activePath);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number }>();
  useEffect(() => { if (!menu) return; const close = (): void => setMenu(undefined); document.addEventListener("click", close); return () => document.removeEventListener("click", close); }, [menu]);
  if (props.activePath) return <div class="cli-reviews-view is-detail">{activeChange ? <ReviewComparator change={activeChange} onOpenFile={() => props.onOpenFile(activeChange.path)} /> : <div class="cli-context-empty"><ReviewIcon /><span>This review is no longer available.</span></div>}</div>;
  return <div class="cli-reviews-view"><header><ReviewIcon /><span><strong>Review changes</strong><small>{props.changes.length} changed files · {props.agents.length} agent activities</small></span></header>{reviewPaths.length > 0 ? <div class="cli-review-file-list" role="list" aria-label="Changed files">{reviewPaths.map((path) => <button type="button" role="listitem" onContextMenu={(event) => { event.preventDefault(); setMenu({ path, x: event.clientX, y: event.clientY }); }} onClick={() => props.onOpenReview(path)} title={`Open review for ${path}`}><FileIcon /><span>{path}</span><ChevronIcon /></button>)}</div> : null}{props.agents.map((agent) => <details key={agent.id}><summary><span><ForkIcon /><strong>{agent.title ?? "Agent activity"}</strong></span><ChevronIcon /></summary><p>{agent.text}</p></details>)}{menu ? createPortal(<div class="cli-file-context-menu" role="menu" style={{ left: `${Math.min(menu.x, Math.max(8, window.innerWidth - 190))}px`, top: `${Math.min(menu.y, Math.max(8, window.innerHeight - 120))}px` }} onClick={(event) => event.stopPropagation()}><strong title={menu.path}>{menu.path}</strong><button type="button" role="menuitem" onClick={() => { setMenu(undefined); props.onOpenReview(menu.path); }}><ReviewIcon /> Open review</button><button type="button" role="menuitem" onClick={() => { setMenu(undefined); props.onOpenFile(menu.path); }}><FileIcon /> Open in Files</button><button type="button" role="menuitem" onClick={() => { const selected = menu.path; setMenu(undefined); void navigator.clipboard.writeText(selected).then(() => props.onFeedback({ level: "info", message: "Review path copied." }), () => props.onFeedback({ level: "error", message: "Review path could not be copied." })); }}><LinkIcon /> Copy path</button></div>, document.body) : null}{props.changes.length === 0 && props.agents.length === 0 ? <div class="cli-context-empty"><ReviewIcon /><span>No recorded changes or agent reviews.</span></div> : null}</div>;
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
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ header: line, old: { kind: "empty" }, next: { kind: "empty" } });
      continue;
    }
    if (!inHunk) {
      if (line && !line.startsWith("diff --git") && !line.startsWith("index ") && !line.startsWith("--- ") && !line.startsWith("+++ ")) rows.push({ header: line, old: { kind: "empty" }, next: { kind: "empty" } });
      continue;
    }
    if (line.startsWith("-")) {
      const removed: Array<{ number: number; text: string }> = [];
      const added: Array<{ number: number; text: string }> = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("-")) {
        removed.push({ number: oldLine, text: (lines[index] ?? "").slice(1) });
        oldLine += 1;
        index += 1;
      }
      while (index < lines.length && (lines[index] ?? "").startsWith("+")) {
        added.push({ number: newLine, text: (lines[index] ?? "").slice(1) });
        newLine += 1;
        index += 1;
      }
      index -= 1;
      for (let pair = 0; pair < Math.max(removed.length, added.length); pair += 1) {
        const before = removed[pair];
        const after = added[pair];
        rows.push({ old: before ? { kind: "removed", number: before.number, text: before.text } : { kind: "empty" }, next: after ? { kind: "added", number: after.number, text: after.text } : { kind: "empty" } });
      }
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ old: { kind: "empty" }, next: { kind: "added", number: newLine, text: line.slice(1) } });
      newLine += 1;
      continue;
    }
    if (line.startsWith("\\ No newline")) {
      rows.push({ header: line, old: { kind: "empty" }, next: { kind: "empty" } });
      continue;
    }
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({ old: { kind: "context", number: oldLine, text }, next: { kind: "context", number: newLine, text } });
    oldLine += 1;
    newLine += 1;
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
  account?: DashboardAccountViewModel;
  accounts?: DashboardAccountViewModel[];
  localAccounts?: DashboardAccountViewModel[];
  peers?: Array<{ id: string; name: string; connected: boolean; local?: boolean }>;
  peerAccounts?: Record<string, DashboardAccountViewModel[]>;
  selectedPeerId?: string;
  onSwitchAccount: (targetDeviceId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hoveredPeerId, setHoveredPeerId] = useState<string>();
  const [popoverPosition, setPopoverPosition] = useState({ left: 8, bottom: 8 });
  const rootRef = useRef<HTMLElement>(null);
  const closeTimer = useRef<number>();
  const accountLabel = props.account?.displayName?.trim() || props.account?.email?.trim() || "No active account";
  const quotaMetrics = props.account?.metrics.filter((item) => item.visible && typeof item.percentage === "number") ?? [];
  const overall = quotaMetrics.length ? Math.min(...quotaMetrics.map((metric) => metric.percentage ?? 100)) : undefined;
  const fallbackPeer = { id: "local", name: "This PC", connected: true, local: true };
  const peers = props.peers?.length ? props.peers : [fallbackPeer];
  const accountGroups = peers.map((peer) => ({
    peer,
    accounts: peer.local ? (props.localAccounts ?? props.accounts ?? (props.account ? [props.account] : [])) : (props.peerAccounts?.[peer.id] ?? [])
  }));
  const quotaDescription = (account: DashboardAccountViewModel): string => {
    const metric = account.metrics.find((item) => item.visible && item.period === "hourly")
      ?? account.metrics.find((item) => item.visible && typeof item.percentage === "number")
      ?? account.metrics.find((item) => item.visible);
    if (!metric) return "Quota unavailable";
    return `${metric.label} ${metric.percentage != null ? `${Math.round(metric.percentage)}%` : "—"}`;
  };
  const accountDescription = (account: DashboardAccountViewModel): string => {
    const accountType = account.planTypeLabel?.trim() || account.accountStructureLabel?.trim() || "Account";
    return `${account.enabled ? "Enabled" : "Disabled"} · ${accountType} · ${quotaDescription(account)}`;
  };
  const clearCloseTimer = (): void => {
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  };
  const updatePopoverPosition = (): void => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = Math.min(360, Math.max(228, window.innerWidth - 16));
    setPopoverPosition({
      left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.left)),
      bottom: Math.max(8, window.innerHeight - rect.top + 8)
    });
  };
  const openMenu = (): void => {
    clearCloseTimer();
    updatePopoverPosition();
    setOpen(true);
  };
  const closeMenu = (): void => {
    clearCloseTimer();
    setOpen(false);
    setHoveredPeerId(undefined);
  };
  const scheduleClose = (): void => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(closeMenu, 140);
  };

  useEffect(() => {
    if (!open) return;
    updatePopoverPosition();
    const reposition = (): void => updatePopoverPosition();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => () => clearCloseTimer(), []);

  return <footer class="cli-account-footer" ref={rootRef} onMouseEnter={openMenu} onMouseLeave={scheduleClose} onFocus={openMenu} onBlur={scheduleClose}>
    <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={openMenu}>
      <span class="cli-account-avatar">{accountLabel.slice(0, 1).toUpperCase()}</span>
      <span><strong>{accountLabel}</strong><small>{overall != null ? `${Math.round(overall)}% overall quota available` : "Account details"}</small></span>
      <ChevronIcon />
    </button>
    {open ? createPortal(
      <nav
        class="cli-account-popover cli-account-popover-wide cli-account-menu"
        role="menu"
        aria-label="Accounts by PC"
        style={{ left: `${popoverPosition.left}px`, bottom: `${popoverPosition.bottom}px` }}
        onMouseEnter={openMenu}
        onMouseLeave={scheduleClose}
        onFocus={openMenu}
        onBlur={scheduleClose}
      >
        {accountGroups.map(({ peer, accounts }) => {
          const hasChildren = accounts.length > 0;
          const expanded = hoveredPeerId === peer.id;
          const enabledCount = accounts.filter((account) => account.enabled).length;
          const runningAccount = accounts.find((account) => account.runningOnThisDevice || account.isActive || account.isCurrentWindowAccount);
          return <div class={`cli-account-parent ${expanded ? "is-expanded" : ""}`} key={peer.id} onMouseEnter={() => { openMenu(); setHoveredPeerId(peer.id); }} onFocus={() => { openMenu(); setHoveredPeerId(peer.id); }}>
            <button
              type="button"
              role="menuitem"
              aria-label={`Switch account on ${peer.name}`}
              aria-haspopup={hasChildren ? "menu" : undefined}
              aria-expanded={hasChildren ? expanded : undefined}
              onClick={() => {
                if (hasChildren) {
                  setHoveredPeerId(peer.id);
                  return;
                }
                closeMenu();
                props.onSwitchAccount(peer.local ? undefined : peer.id);
              }}
            >
              <span><strong>{peer.name}</strong><small>{enabledCount} enabled · {runningAccount ? `Running ${quotaDescription(runningAccount)}` : "No running account"}</small></span><ChevronIcon />
            </button>
            {hasChildren && expanded ? <div class="cli-account-submenu" role="menu" aria-label={`Accounts on ${peer.name}`} onMouseEnter={openMenu} onFocus={openMenu}>
              {accounts.map((account) => { const selected = account.isActive || account.isCurrentWindowAccount; return <button type="button" role="menuitem" aria-current={selected ? "true" : undefined} class={`cli-account-entry ${selected ? "is-active" : ""}`} key={account.id} onClick={() => { closeMenu(); props.onSwitchAccount(peer.local ? undefined : peer.id); }}>
                <span><strong>{account.email || account.displayName || "Unnamed account"}</strong><small>{accountDescription(account)}</small></span>
              </button>})}
    </div> : null}
          </div>;
        })}
      </nav>,
      document.body
    ) : null}
  </footer>;
}

function SessionShareModal(props: { title: string; url: string; onClose: () => void; onFeedback: (notice: DashboardNotice) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.url);
      setCopied(true);
      props.onFeedback({ level: "info", message: "Session link copied." });
    } catch {
      props.onFeedback({ level: "error", message: "Session link could not be copied. Select it and copy manually." });
    }
  };
  return <div class="cli-share-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) props.onClose(); }}><section class="cli-share-modal" role="dialog" aria-modal="true" aria-labelledby="cli-share-title"><header><span><ShareIcon /><strong id="cli-share-title">Share session</strong></span><IconButton label="Close share dialog" onClick={props.onClose}><CloseIcon /></IconButton></header><p>Anyone with access to this dashboard can open <strong>{props.title}</strong> from this link.</p><div class="cli-share-link-row"><input value={props.url} readOnly aria-label="Session link" onFocus={(event) => event.currentTarget.select()} /><button type="button" onClick={() => void copy()}><CopyIcon /> {copied ? "Copied" : "Copy"}</button></div></section></div>;
}

export function RailFiles(props: { files: Array<{ path: string; diff?: string }>; projectPath?: string }) {
  return <section class="cli-rail-explorer" aria-label="Workspace file explorer">
    <div class="cli-rail-explorer-heading"><span><EmptyFolderIcon /><strong>Files</strong></span><small>{props.files.length} changed</small></div>
    {props.projectPath ? <div class="cli-rail-root"><EmptyFolderIcon /><span title={props.projectPath}>{projectDisplayName(props.projectPath)}</span></div> : null}
    {props.files.length === 0 ? <div class="cli-context-empty"><EmptyFolderIcon /><span>No file changes recorded.</span></div> : <div class="cli-rail-file-list">{props.files.map((file) => <details key={file.path}><summary><FileIcon /><span title={file.path}>{file.path}</span><ChevronIcon /></summary>{file.diff ? <pre>{file.diff}</pre> : <small>No diff preview recorded.</small>}</details>)}</div>}
  </section>;
}

export function RailAgents(props: { messages: DashboardCliSessionMessage[] }) {
  return <section class="cli-rail-explorer" aria-label="Workspace agents">
    <div class="cli-rail-explorer-heading"><span><ForkIcon /><strong>Agents</strong></span><small>{props.messages.length} active</small></div>
    {props.messages.length === 0 ? <div class="cli-context-empty"><ForkIcon /><span>No agent activity recorded.</span></div> : <div class="cli-rail-agent-list">{props.messages.map((message) => <article key={message.id}><ForkIcon /><div><strong>{message.title ?? "Agent activity"}</strong><span>{message.text}</span></div></article>)}</div>}
  </section>;
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
  if (message.exitCode !== undefined) values.push(`exit ${message.exitCode}`);
  if (message.timestamp) values.push(formatTime(message.timestamp));
  return values.filter(Boolean).join(" · ") || (message.status === "inProgress" ? "In progress" : "Completed");
}
function DeleteConfirmation(props: { title: string; compact?: boolean; onCancel: () => void; onDelete: () => void }) { return <div class={`cli-delete-confirm ${props.compact ? "is-compact" : ""}`} role="alertdialog" aria-label={`Delete ${props.title} permanently`}><span><TrashIcon /><span><strong>Delete permanently?</strong> {props.title} cannot be recovered.</span></span><div><button type="button" class="cli-secondary-button" onClick={props.onCancel}>Cancel</button><button type="button" class="cli-danger-button" onClick={props.onDelete}>Delete</button></div></div>; }
function InlineError(props: { text: string; retry: () => void }) {
  const unavailable = /CLI is not available/i.test(props.text);
  const [copied, setCopied] = useState(false);
  const copyInstall = (): void => {
    void navigator.clipboard?.writeText("npm install -g @openai/codex").then(() => setCopied(true));
  };
  return <div class="cli-inline-state is-error" role="alert"><strong>{unavailable ? "Codex CLI not found" : "Something went wrong"}</strong><span>{props.text}</span>{unavailable ? <div class="cli-install-command"><code>npm install -g @openai/codex</code><button type="button" onClick={copyInstall}>{copied ? "Copied" : "Copy"}</button></div> : null}<button type="button" onClick={props.retry}>Try again</button></div>;
}

function activityLabel(message: DashboardCliSessionMessage): string {
  if (message.kind === "reasoning") return "Thinking";
  if (message.kind === "command") return "Ran commands";
  return message.title ?? activityTitle(message.kind);
}
function EmptySessions(props: { search: boolean; section: CliSessionSection }) { return <div class="cli-inline-state"><EmptyFolderIcon /><strong>{props.search ? "No matching sessions" : `No ${props.section} sessions`}</strong><span>{props.search ? "Try another title or session ID." : props.section === "active" ? "Start a Codex chat to see it here." : "Archived sessions will appear here."}</span></div>; }
function ConversationEmpty({ archived, logoUri }: { archived: boolean; logoUri?: string }) { return <div class="cli-conversation-empty">{logoUri ? <img src={logoUri} alt="" aria-hidden="true" /> : <CodexSessionIcon />}<h2>No messages yet</h2><p>{archived ? "This archived transcript has no readable messages." : "Send a message below to continue this session."}</p></div>; }
function WorkspaceEmpty(props: { running: number; active: number; archived: number; logoUri?: string }) { return <div class="cli-workspace-empty"><span class="cli-empty-mark">{props.logoUri ? <img src={props.logoUri} alt="" aria-hidden="true" /> : <CodexSessionIcon />}</span><h1>What should we build?</h1><p>Select a project below or choose a session from the sidebar.</p></div>; }
function UsageBanner(props: { account?: DashboardAccountViewModel; onAction: (message: string) => void }) {
  const metric = props.account?.metrics.find((item) => item.visible && typeof item.percentage === "number");
  if (!metric || (metric.percentage ?? 100) > 5) return null;
  return <div class="cli-usage-banner"><span class="cli-usage-icon"><WarningIcon /></span><div><strong>You’re out of Codex and Work usage</strong><small>Add credits or upgrade your plan — or wait for usage to reset.</small></div><button type="button" class="cli-secondary-button" onClick={() => props.onAction("Upgrade is available from the Codex account dashboard.")}>Upgrade</button><button type="button" class="cli-secondary-button" onClick={() => props.onAction("Add credits is available from the Codex account dashboard.")}>Add credits</button></div>;
}
function SessionRailSkeleton() { return <div class="cli-skeleton-list" aria-label="Loading sessions"><i /><i /><i /><i /></div>; }
function MessageSkeleton() { return <div class="cli-message-skeleton" aria-label="Loading messages"><i /><i /><i /></div>; }
 function IconButton(props: { label: string; title?: string; disabled?: boolean; danger?: boolean; onClick: () => void; children: preact.ComponentChildren }) { return <button type="button" class={`cli-icon-button ${props.danger ? "is-danger" : ""}`} disabled={props.disabled} aria-label={props.label} title={props.title ?? props.label} onClick={props.onClick}>{props.children}</button>; }

function formatTime(value: string | undefined): string { if (!value) return ""; const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : ""; }
function formatDuration(durationMs: number): string { if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))} ms`; if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`; return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`; }
function formatTerminalDuration(durationMs: number): string { return durationMs < 1000 ? `${Math.max(0, Math.round(durationMs))} ms` : `${(durationMs / 1000).toFixed(1)} s`; }
function formatElapsed(durationMs: number): string { if (durationMs < 60_000) return `${Math.floor(Math.max(0, durationMs) / 1000)}s`; return `${Math.floor(durationMs / 60_000)}m ${Math.floor((durationMs % 60_000) / 1000)}s`; }
function relativeTime(value: string | undefined): string { if (!value) return "Unknown"; const parsed = Date.parse(value); if (!Number.isFinite(parsed)) return "Unknown"; const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60_000)); if (minutes < 1) return "Just now"; if (minutes < 60) return `${minutes}m`; const hours = Math.round(minutes / 60); return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`; }
function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
function projectDisplayName(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || value;
}
function workspaceRelativePath(filePath: string, projectPath: string | undefined): string {
  const file = canonicalWebPath(filePath);
  const root = projectPath ? canonicalWebPath(projectPath) : "";
  if (root && file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}
function canonicalWebPath(value: string): string {
  return value.trim().replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}
function clamp(value: number, minimum: number, maximum = Number.POSITIVE_INFINITY): number { return Math.min(maximum, Math.max(minimum, value)); }
function loadWorkspaceLayout(): WorkspaceLayout {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "{}") as Partial<WorkspaceLayout>;
    return {
      railWidth: clamp(Number(parsed.railWidth) || DEFAULT_WORKSPACE_LAYOUT.railWidth, 200),
      terminalWidth: clamp(Number(parsed.terminalWidth) || DEFAULT_WORKSPACE_LAYOUT.terminalWidth, 280),
      environmentWidth: clamp(Number(parsed.environmentWidth) || DEFAULT_WORKSPACE_LAYOUT.environmentWidth, 280),
      environmentHeight: clamp(Number(parsed.environmentHeight) || DEFAULT_WORKSPACE_LAYOUT.environmentHeight, 220),
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
function SidebarIcon() { return <Icon><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 4v16" fill="none" stroke="currentColor" stroke-width="1.7"/></Icon>; }
function DashboardIcon() { return <Icon><rect x="4" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/></Icon>; }
function CodexSessionIcon() { return <Icon><path d="M8.3 3.2a5 5 0 0 1 8.5 2.1 5 5 0 0 1 2 8.5 5 5 0 0 1-2.1 8.5 5 5 0 0 1-8.5-2.1 5 5 0 0 1-2-8.5 5 5 0 0 1 2.1-8.5Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8.2 12 2.5 2.5 5.2-5.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function ArrowLeftIcon() { return <Icon><path d="m14.5 5-7 7 7 7M8 12h11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function CloseIcon() { return <Icon><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></Icon>; }
function SearchIcon() { return <Icon><circle cx="10.8" cy="10.8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m15.5 15.5 4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></Icon>; }
function RefreshIcon() { return <Icon><path d="M19 7v5h-5M5 17v-5h5M7.1 8.2A6.5 6.5 0 0 1 18.6 12M5.4 12a6.5 6.5 0 0 0 11.5 3.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function CopyIcon() { return <Icon><rect x="8" y="8" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="1.6"/></Icon>; }
function ThumbsUpIcon() { return <Icon><path d="M7 10v10H4V10h3Zm0 10h9.1a2 2 0 0 0 1.9-1.4l2-6A2 2 0 0 0 18.1 10H14l.7-3.2A2.4 2.4 0 0 0 12.4 4L7 10v10Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></Icon>; }
function ThumbsDownIcon() { return <Icon><path d="M7 14V4H4v10h3Zm0-10h9.1a2 2 0 0 1 1.9 1.4l2 6A2 2 0 0 1 18.1 14H14l.7 3.2a2.4 2.4 0 0 1-2.3 2.8L7 14V4Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></Icon>; }
function ArchiveIcon() { return <Icon><path d="M4 7h16v12H4zM3 4h18v3H3zM9 11h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></Icon>; }
function RestoreIcon() { return <Icon><path d="M4 9a8 8 0 1 1 .8 7M4 4v5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function TrashIcon() { return <Icon><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function SparkIcon() { return <Icon><path d="m12 3 1.2 4.1L17 9l-3.8 1.9L12 15l-1.2-4.1L7 9l3.8-1.9L12 3Zm6 11 .7 2.3L21 17.5l-2.3 1.2L18 21l-.7-2.3-2.3-1.2 2.3-1.2L18 14Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></Icon>; }
function ReasoningIcon() { return <Icon><path d="M9 18h6M10 21h4M8.5 15.5C6.9 14.4 6 12.6 6 10.6a6 6 0 1 1 12 0c0 2-.9 3.8-2.5 4.9-.5.4-.8.9-.8 1.5H9.3c0-.6-.3-1.1-.8-1.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function ShieldIcon() { return <Icon><path d="M12 3 5 6v5c0 4.6 2.9 8.2 7 10 4.1-1.8 7-5.4 7-10V6l-7-3Zm-3 9 2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></Icon>; }
function SendIcon() { return <Icon><path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function StopIcon() { return <Icon><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></Icon>; }
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
function ChangesIcon() { return <Icon><rect x="5" y="4" width="14" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 9h6m-6 4h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></Icon>; }
function WarningIcon() { return <Icon><path d="M12 3 2.8 20h18.4L12 3Zm0 6v5m0 3h.01" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function CheckIcon() { return <Icon><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function ChevronIcon() { return <Icon><path d="m8 10 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
