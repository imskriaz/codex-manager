import { createPortal } from "preact/compat";
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
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
  DashboardCodexSessionLiveState,
  DashboardNotice,
  DashboardWorkspaceEnvironment,
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
import { isCliTurnActive } from "./cliSessionLiveState";
import { useModalAccessibility } from "./primitives";
import { getSensitiveDisplayValue } from "./helpers";
import { readCliComposerDraft, writeCliComposerDraft } from "./cliSessionCache";
import { acknowledgeCliComposerDraft, cliComposerDraftKey, resolveCliComposerSettings, type CliComposerDraft, type CliSubmissionResult } from "./cliSessionComposerState";

export type CliSessionFeedback = DashboardNotice & { key: number };
type WorkspaceTab = "terminal" | "files" | "reviews" | "agents" | `agent:${string}` | `file:${string}` | `review:${string}`;
type WorkspaceToolTab = "terminal" | "files" | "reviews" | "agents";
export type CliSessionSection = "active" | "archived";
/** Keep the two state tabs mutually exclusive, treating only an explicit
 * `archived: true` marker as archived. */
export function filterCliSessionsBySection(
  sessions: DashboardCliSessionSummary[],
  section: CliSessionSection
): DashboardCliSessionSummary[] {
  const archived = section === "archived";
  const seen = new Set<string>();
  return sessions.filter((session) => {
    const key = `${session.deviceId ?? "local"}:${session.id}`;
    if (readSubAgentMetadata(session).subAgent || seen.has(key) || (session.archived === true) !== archived) return false;
    seen.add(key);
    return true;
  });
}
export function countPeerSessions(sessions: DashboardCliSessionSummary[], peers: Array<{ id: string; local?: boolean }>) {
  const active = filterCliSessionsBySection(sessions, "active");
  return peers.map((peer) => {
    const rows = active.filter((session) => peer.local ? !session.remote : session.remote && session.deviceId === peer.id);
    return { id: peer.id, total: rows.length, running: rows.filter((session) => session.status === "running").length };
  });
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
  environmentWidth: number;
  environmentHeight: number;
  composerHeight: number;
};

const WORKSPACE_LAYOUT_STORAGE_KEY = "codexManager.workspaceLayout.v2";
const WORKSPACE_TERMINAL_ID = "workspace-terminal";
const markdownRenderer = new MarkdownIt({ html: false, linkify: true, typographer: true });
const renderMarkdownFence = markdownRenderer.renderer.rules["fence"]!;
markdownRenderer.renderer.rules["fence"] = (tokens, index, options, env, renderer) =>
  `<div class="cli-markdown-code-block"><button type="button" class="cli-code-copy" aria-label="Copy code">Copy code</button>${renderMarkdownFence(tokens, index, options, env, renderer)}</div>`;
markdownRenderer.renderer.rules["link_open"] = (tokens, index, options, _env, renderer) => {
  tokens[index]!.attrSet("target", "_blank");
  tokens[index]!.attrSet("rel", "noopener noreferrer");
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
  sessionView: "projects",
  railWidth: 260,
  terminalWidth: 320,
  environmentWidth: 288,
  environmentHeight: 320,
  composerHeight: 136
};
const EMPTY_CHAT_ATTACHMENTS: ChatAttachment[] = [];
type ComposerDraft = CliComposerDraft;

export type CliSessionsPageProps = {
  dashboardMode?: boolean;
  /** Show the remote dashboard sign-out action in the avatar menu. */
  showLogout?: boolean;
  privacyMode: boolean;
  sessions: DashboardCliSessionSummary[];
  selectedSession?: DashboardCliSessionSummary;
  messages: DashboardCliSessionMessage[];
  liveState?: DashboardCodexSessionLiveState;
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
  error?: string;
  messagesError?: string;
  feedback?: CliSessionFeedback;
  environment?: DashboardWorkspaceEnvironment;
  terminalResults: DashboardWorkspaceTerminalResult[];
  terminalLiveOutputs: DashboardWorkspaceTerminalOutput[];
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
  onStart: (input: { text: string; attachments?: ChatAttachment[]; model?: string; reasoningEffort?: string; sandboxMode: DashboardCliSandboxMode; projectPath?: string }) => string | undefined;
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
  onSaveFile: (filePath: string, content: string, revision: string, projectPath?: string) => void;
  onSend: (input: {
    text: string;
    attachments?: ChatAttachment[];
    model?: string;
    reasoningEffort?: string;
    sandboxMode: DashboardCliSandboxMode;
    projectPath?: string;
  }) => string | undefined;
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

export function shouldShowLatestButton(scrollHeight: number, clientHeight: number, scrollTop: number, wasVisible = false): boolean {
  const overflow = scrollHeight - clientHeight;
  if (overflow <= 2) return false;
  const remaining = Math.max(0, overflow - Math.max(0, scrollTop));
  return remaining > (wasVisible ? 16 : 48);
}

export function CliSessionsPage(props: CliSessionsPageProps) {
  const [section, setSection] = useState<CliSessionSection>("active");
  const [search, setSearch] = useState("");
  const [attachmentReading, setAttachmentReading] = useState(false);
  const submittedDrafts = useRef(new Map<string, ComposerDraft & { key: string }>());
  const attachmentReadRef = useRef(false);
  const [projectPath, setProjectPath] = useState<string>();
  const [newChatProject, setNewChatProject] = useState<string>();
  const selectedDevice = props.selectedSession?.deviceId ??
    (props.peers?.some((peer) => peer.id === props.selectedPeerId && peer.local) ? undefined : props.selectedPeerId);
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
  const [contextCollapsed, setContextCollapsed] = useState(() => window.innerWidth < 1180);
  const [contextTabs, setContextTabs] = useState<WorkspaceTab[]>([]);
  const [activeContextTab, setActiveContextTab] = useState<WorkspaceTab>("terminal");
  const [contextAddOpen, setContextAddOpen] = useState(false);
  // Match Codex's quiet workspace default: the Environment inspector is
  // available from the header, but it should not cover the conversation on
  // first render.  Keep the mobile effect below as a safety net when the
  // viewport changes after mount.
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [layout, setLayout] = useState(loadWorkspaceLayout);
  const [terminalDraft, setTerminalDraft] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<DashboardCliSessionSummary>();
  const [localFeedback, setLocalFeedback] = useState<DashboardNotice>();
  const reportLocalFeedback = (notice: DashboardNotice): void => {
    if (notice.level !== "info") setLocalFeedback(notice);
  };
  const [shareOpen, setShareOpen] = useState(false);
  const messageViewportRef = useRef<HTMLElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const [showLatestButton, setShowLatestButton] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previousFeedbackKey = useRef<number>();

  useEffect(() => {
    if (loadedDraftKeys.current.has(draftKey)) return;
    loadedDraftKeys.current.add(draftKey);
    void readCliComposerDraft(draftKey).then((saved) => {
      if (saved) setComposerDrafts((current) => {
        const edited = Object.fromEntries([...(dirtyDraftFields.current.get(draftKey) ?? [])].map((field) => [field, current[draftKey]?.[field]]));
        return { ...current, [draftKey]: { ...saved, ...edited } };
      });
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
      const submitted = submittedDrafts.current.get(result.requestId);
      if (!submitted) continue;
      submittedDrafts.current.delete(result.requestId);
      if (result.status === "completed") setComposerDrafts((current) => current[submitted.key]
        ? { ...current, [submitted.key]: acknowledgeCliComposerDraft(current[submitted.key]!, submitted) } : current);
    }
  }, [props.submissionResults]);

  const draftStorageWarning = draftStorageFailedKeys.has(draftKey) ? <p class="cli-composer-unavailable" role="status">This draft is kept in this tab. Browser storage could not save it; copy it before closing or reloading. <button type="button" onClick={() => { const value = composerDrafts[draftKey]; if (value) void writeCliComposerDraft(draftKey, value).then((saved) => { if (saved) { setDraftStorageFailedKeys((current) => { const next = new Set(current); next.delete(draftKey); return next; }); } }); }}>Retry saving draft</button></p> : null;

  useEffect(() => {
    if (!props.composerConfig) return;
    setProjectPath((current) => current ?? props.composerConfig?.projects?.[0]?.path);
  }, [props.composerConfig]);

  useEffect(() => {
    if (!props.feedback || previousFeedbackKey.current === props.feedback.key) return;
    previousFeedbackKey.current = props.feedback.key;
    reportLocalFeedback(props.feedback);
  }, [props.feedback]);

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
    const mobile = window.matchMedia("(max-width: 760px)");
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
      if (document.querySelector('.overlay.open, [aria-modal="true"]:not(#cli-session-sidebar)')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setRailCollapsed(true);
      } else if (event.key === "Tab") {
        const controls = [sidebarToggleRef.current, ...Array.from(sidebar?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]') ?? []), ...Array.from(document.querySelectorAll<HTMLElement>('.cli-account-menu button:not([disabled]), .cli-account-menu a[href]'))]
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

  const activeSessions = filterCliSessionsBySection(props.sessions, "active");
  const archivedSessions = filterCliSessionsBySection(props.sessions, "archived");
  const runningCount = activeSessions.filter((session) => session.status === "running").length;
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
  const ownedLiveTurn = props.liveState?.status === "starting" || props.liveState?.status === "running";
  const canSteer = Boolean(props.connected !== false && props.liveState?.status === "running" && props.liveState.turnId && props.onSteer);
  const composerBlockedByOwner = Boolean((props.selectedSession?.locked || props.selectedSession?.status === "running") && !props.sending && !ownedLiveTurn);
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
  const retryMessage = (id: string): void => {
    const prompt = getMessagePrompt(props.messages, id);
    if (prompt !== undefined) draftFromMessage(prompt, false);
    else reportLocalFeedback({ level: "warning", message: "No user prompt is available to retry." });
  };
  const turnCopyText = useMemo(() => getCompletedTurnCopyText(props.messages, props.sending || props.selectedSession?.status === "running"), [props.messages, props.sending, props.selectedSession?.status]);
  const currentTurnRunning = Boolean(props.sending || ownedLiveTurn || props.selectedSession?.status === "running");
  const transcriptItems = useMemo(() => groupCompletedTurns(consolidateSessionMessages(props.messages), currentTurnRunning), [props.messages, currentTurnRunning]);
  const goal = useMemo(() => getSessionGoal(props.messages), [props.messages]);
  const turnChanges = useMemo(() => summarizeTurnChanges(props.messages, props.liveState?.turnId), [props.messages, props.liveState?.turnId]);
  const showWorking = currentTurnRunning && !hasInProgressActivity;
  const selectedProjectPath = props.selectedSession?.projectPath ?? newChatProject ?? projectPath;
  const startNewChat = (nextProject?: string): void => {
    if (mobileLayout) setRailCollapsed(true);
    props.onBackToList();
    setNewChatProject(nextProject ?? projectPath ?? projects[0]?.path ?? "");
    setProjectPath(nextProject ?? projectPath ?? projects[0]?.path);
  };
  const localPeerId = props.peers?.find((peer) => peer.local)?.id;
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
    for (const session of [...filterCliSessionsBySection(props.sessions, "active"), ...filterCliSessionsBySection(props.sessions, "archived")]) {
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
    return [...groups.values()];
  }, [props.peers, props.sessions, visibleSessions]);
  const toggleGroup = (id: string, defaultCollapsed = false): void => {
    setCollapsedGroups((current) => ({ ...current, [id]: !(current[id] ?? defaultCollapsed) }));
  };
  const selectContextTab = (tab: WorkspaceTab): void => {
    setActiveContextTab(tab);
    const filePath = workspaceTabPath(tab);
    if (workspaceTabKind(tab) === "agents" && filePath) {
      const agent = props.sessions.find((session) => session.id === filePath && (session.deviceId ?? "local") === (props.selectedSession?.deviceId ?? "local") && readSubAgentMetadata(session).subAgent);
      if (agent) props.onReadAgent?.(agent);
    }
    if (workspaceTabKind(tab) === "files") {
      props.onListFiles(selectedProjectPath);
      if (filePath) props.onReadFile(filePath, selectedProjectPath);
    }
  };
  const openContextTab = (tab: WorkspaceToolTab, filePath?: string): void => {
    const resolvedFilePath = filePath && tab === "files" ? workspaceRelativePath(filePath, selectedProjectPath) : filePath;
    const tabId: WorkspaceTab = resolvedFilePath ? `${tab === "agents" ? "agent" : tab === "files" ? "file" : "review"}:${resolvedFilePath}` : tab;
    setContextTabs((current) => {
      const withBase = current.includes(tab) ? current : [...current, tab];
      return withBase.includes(tabId) ? withBase : [...withBase, tabId];
    });
    selectContextTab(tabId);
    setContextCollapsed(false);
    setContextAddOpen(false);
  };
  const renderSession = (session: DashboardCliSessionSummary): preact.ComponentChildren => session.archived ? (
    <div role="listitem" class="cli-session-row is-archived" key={`${session.deviceId ?? "local"}:${session.id}`}>
        <span class="cli-session-row-main has-project"><strong title={session.title}>{session.title}</strong><small class="cli-session-row-meta"><span>{sessionMeta(session)}</span><span>{relativeTime(session.updatedAt)}</span></small></span>
      <span class="cli-session-row-actions">
        <IconButton label={`Restore ${session.title}`} disabled={props.mutating} onClick={() => props.onUnarchive(session)}><RestoreIcon /></IconButton>
        <IconButton label={`Delete ${session.title}`} disabled={props.mutating} danger onClick={() => setDeleteTarget(session)}><TrashIcon /></IconButton>
      </span>
    </div>
  ) : (
    <div role="listitem" class={`cli-session-row ${(session.status === "running" || (props.liveState?.sessionId === session.id && (props.liveState.deviceId ?? undefined) === (session.deviceId ?? undefined) && isCliTurnActive(props.liveState))) ? "is-running" : ""} ${props.selectedSession?.id === session.id && props.selectedSession?.deviceId === session.deviceId ? "is-selected" : ""}`} key={`${session.deviceId ?? "local"}:${session.id}`}>
      <button type="button" class="cli-session-row-select" onClick={() => { if (mobileLayout) setRailCollapsed(true); setNewChatProject(undefined); setProjectPath(session.projectPath); props.onPeerChange?.(session.deviceId ?? localPeerId ?? "local"); props.onSelect(session); }}>
        <span class="cli-session-row-status" title={session.status === "running" || (props.liveState?.sessionId === session.id && props.liveState.deviceId === session.deviceId && isCliTurnActive(props.liveState)) ? "Running" : session.locked ? "Locked" : "Complete"} aria-label={session.status === "running" || (props.liveState?.sessionId === session.id && props.liveState.deviceId === session.deviceId && isCliTurnActive(props.liveState)) ? "Running" : session.locked ? "Locked" : "Complete"}>
          {session.status === "running" || (props.liveState?.sessionId === session.id && (props.liveState.deviceId ?? undefined) === (session.deviceId ?? undefined) && isCliTurnActive(props.liveState)) ? <span class="cli-session-spinner" aria-hidden="true" /> : session.locked ? <ShieldIcon /> : <CheckIcon />}
        </span>
        <span class="cli-session-row-main has-project"><strong title={session.title}>{session.title}</strong><small class="cli-session-row-meta"><span>{sessionMeta(session)}</span><span>{relativeTime(session.updatedAt)}</span></small></span>
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
    if ((currentTurnRunning && !canSteer) || props.steering || props.starting || attachmentReading || props.connected === false || !draftReadyKeys.has(draftKey)) return;
    const text = draft.trim();
    if (!text && !attachments.length) {
      setLocalFeedback({ level: "warning", message: "Write a message before sending it to Codex." });
      return;
    }
    try { prepareChatInput(text, attachments); }
    catch (error) { setLocalFeedback({ level: "error", message: error instanceof Error ? error.message : String(error) }); return; }
    let requestId: string | undefined;
    if (!props.selectedSession) {
      requestId = props.onStart({ text, attachments, model, reasoningEffort, sandboxMode, projectPath: newChatProject ?? projectPath });
    } else if (canSteer && props.liveState?.turnId) {
      requestId = props.onSteer?.({ text, attachments, expectedTurnId: props.liveState.turnId });
    } else {
      requestId = props.onSend({ text, attachments, model, reasoningEffort, sandboxMode, projectPath: props.selectedSession.projectPath ?? projectPath });
    }
    if (!requestId) { setLocalFeedback({ level: "warning", message: "Your message was not sent. The draft is saved; reconnect or wait for the current request before trying again." }); return; }
    submittedDrafts.current.set(requestId, { ...composerDrafts[draftKey]!, key: draftKey, text: draft, attachments });
    reportLocalFeedback({ level: "info", message: canSteer ? "Sending your follow-up to the running turn…" : props.selectedSession ? "Codex is working on your request…" : "Starting a new Codex chat…" });
  };
  const addAttachments = async (files: File[]): Promise<void> => {
    if (attachmentReadRef.current || props.starting) return;
    if (!files.length) return;
    attachmentReadRef.current = true;
    setAttachmentReading(true);
    try {
      if (files.length + attachments.length > 8) throw new Error("Attach up to 8 files per message.");
      const added: ChatAttachment[] = [];
      for (const file of files) {
        const image = ["image/png", "image/jpeg", "image/webp"].includes(file.type);
        if (file.size > (image ? 1024 * 1024 : 32 * 1024)) throw new Error(`${file.name} is too large. Images: 1 MB; text: 32 KB.`);
        if (!image && !file.type.startsWith("text/") && !/\.(txt|md|json|csv|ts|tsx|js|jsx|py|html|css|xml|yml|yaml|toml|log|rs|go|java|c|cpp|h|sh|sql)$/i.test(file.name)) throw new Error(`${file.name} is unsupported. Attach PNG, JPEG, WebP, or a text/code file.`);
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          const timer = window.setTimeout(() => { reader.abort(); reject(new Error(`Reading ${file.name} timed out. Try attaching it again.`)); }, 10_000);
          reader.onload = () => { clearTimeout(timer); resolve(typeof reader.result === "string" ? reader.result : ""); };
          reader.onerror = reader.onabort = () => { clearTimeout(timer); reject(new Error(`${file.name} could not be read. Try attaching it again.`)); };
          if (image) reader.readAsDataURL(file); else reader.readAsText(file);
        });
        added.push({ id: crypto.randomUUID(), name: file.name, kind: image ? "image" : "text", mimeType: image ? file.type : "text/plain", data, size: file.size });
      }
      const currentAttachments = composerDraftsRef.current[draftKey]?.attachments ?? EMPTY_CHAT_ATTACHMENTS;
      const combined = validateChatAttachments([...currentAttachments, ...added.filter((file) => !currentAttachments.some((item) => item.name === file.name && item.data === file.data))]);
      setAttachments(combined);
      if (currentDraftKey.current !== draftKey) reportLocalFeedback({ level: "warning", message: "Attachments saved in the previous chat draft. Return there to use them." });
    } catch (error) { setLocalFeedback({ level: "error", message: error instanceof Error ? error.message : String(error) }); }
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
    root.style.setProperty("--cli-shell-terminal-width", contextCollapsed ? "0px" : `${layout.terminalWidth}px`);
    root.style.setProperty("--cli-shell-divider-width", "5px");
    return () => {
      root.style.removeProperty("--cli-shell-rail-width");
      root.style.removeProperty("--cli-shell-terminal-width");
      root.style.removeProperty("--cli-shell-divider-width");
    };
  }, [contextCollapsed, layout.railWidth, layout.terminalWidth, railCollapsed]);

  return (
    <div
      ref={workspaceRef}
      class={`cli-workspace ${props.dashboardMode ? "is-dashboard-mode" : ""} ${railCollapsed ? "is-rail-collapsed" : ""} ${contextCollapsed ? "is-terminal-collapsed" : ""}`}
      style={`--cli-rail-width:${layout.railWidth}px;--cli-terminal-width:${layout.terminalWidth}px;--cli-environment-width:${layout.environmentWidth}px;--cli-environment-height:${layout.environmentHeight}px;--cli-composer-height:${layout.composerHeight}px`}
    >
      <button ref={sidebarToggleRef} type="button" class="cli-rail-toggle" aria-expanded={!railCollapsed} aria-controls="cli-session-sidebar" aria-label={railCollapsed ? "Show sessions sidebar" : "Hide sessions sidebar"} title={railCollapsed ? "Show sessions sidebar" : "Hide sessions sidebar"} onClick={() => setRailCollapsed((collapsed) => !collapsed)}><SidebarIcon /></button>
      {!props.selectedSession && contextCollapsed ? <button type="button" class="cli-context-toggle" aria-label="Show workspace tools" title="Show Terminal, Files, and Reviews" onClick={() => setContextCollapsed(false)}><PanelIcon /></button> : null}
      {mobileLayout && !contextCollapsed && railCollapsed ? <button type="button" class="cli-tools-backdrop" aria-label="Close workspace tools" tabIndex={-1} onClick={() => setContextCollapsed(true)} /> : null}
      {mobileLayout && !railCollapsed ? <button type="button" class="cli-sidebar-backdrop" aria-label="Close sessions sidebar" tabIndex={-1} onClick={() => setRailCollapsed(true)} /> : null}
      <div class={`cli-workspace-grid ${props.selectedSession ? "has-context" : ""}`}>
        <aside ref={sidebarRef} id="cli-session-sidebar" class={`cli-session-rail ${props.selectedSession ? "has-selection" : ""}`} role={mobileLayout ? "dialog" : undefined} aria-modal={mobileLayout && !railCollapsed || undefined} aria-hidden={railCollapsed || undefined} inert={railCollapsed || undefined} aria-label="Codex sessions">
          <div class="cli-rail-header">
            <div class="cli-rail-brand">{props.logoUri ? <img src={props.logoUri} alt="" aria-hidden="true" /> : <span class="cli-brand-mark"><CodexSessionIcon /></span>}<strong>Codex</strong></div>
            <div />
          </div>
          <nav class="cli-primary-nav" aria-label="Workspace navigation">
            <button type="button" onClick={() => startNewChat()}><PlusIcon /><span>New chat</span></button>
            <div class="cli-sidebar-toolbar"><button type="button" onClick={() => { if (mobileLayout) setRailCollapsed(true); props.onDashboard(); }}><DashboardIcon /><span>Dashboard</span></button><div class="cli-sidebar-actions" role="group" aria-label="Session list controls"><IconButton label={props.loading ? "Refreshing sessions" : "Refresh sessions"} disabled={props.loading} onClick={props.onRefresh}><RefreshIcon /></IconButton><button type="button" class={`cli-icon-button cli-session-section-toggle ${section === "archived" ? "is-active" : ""}`} aria-pressed={section === "archived"} aria-label={section === "active" ? `Show archived sessions (${archivedSessions.length})` : `Show active sessions (${activeSessions.length})`} title={section === "active" ? `Show archived sessions (${archivedSessions.length})` : `Show active sessions (${activeSessions.length})`} onClick={() => setSection((current) => current === "active" ? "archived" : "active")}><ArchiveIcon /></button><button type="button" class="cli-icon-button cli-session-view-toggle" aria-pressed={layout.sessionView === "compact"} aria-label={layout.sessionView === "projects" ? "Show compact session list" : "Show projects and sessions"} title={layout.sessionView === "projects" ? "Show compact session list" : "Show projects and sessions"} onClick={() => setLayout((current) => ({ ...current, sessionView: current.sessionView === "projects" ? "compact" : "projects" }))}>{layout.sessionView === "projects" ? <SessionListIcon /> : <EmptyFolderIcon />}</button></div></div>
          </nav>
          <div class="cli-session-filters">
            <div class="cli-session-search-line"><div class="cli-session-search-wrap"><SearchIcon /><input class="cli-session-search" name="session-search" type="search" autoComplete="off" value={search} placeholder="Search sessions…" aria-label="Search sessions" onInput={(event) => setSearch(event.currentTarget.value)} /></div></div>

          </div>

          <div class="cli-session-list-region">
          {layout.sessionView === "compact" || Boolean(search.trim()) ? <div class="cli-compact-session-list" role="list" aria-label="Sessions">{visibleSessions.map(renderSession)}</div> : <div class="cli-project-list cli-pc-project-list" aria-label="PCs, projects, and sessions">
            {pcGroups.map((pc) => {
              const pcCollapsed = Boolean(collapsedGroups[`pc:${pc.id}`]);
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
                 <div class="cli-pc-group-heading">
                     <button type="button" class={`cli-pc-group-toggle ${props.selectedPeerId === pc.id ? "is-selected" : ""}`} aria-expanded={!pcCollapsed} onClick={() => { props.onPeerChange?.(pc.id); toggleGroup(`pc:${pc.id}`); }}>
                     <ChevronIcon /><span><strong>{getSensitiveDisplayValue(pc.name, props.privacyMode, "name")}</strong><small>{`${pc.sessions.length} session${pc.sessions.length === 1 ? "" : "s"} · ${pc.connected ? "online" : "offline"}`}</small></span>
                   </button>
                   <button type="button" class="cli-pc-switch" aria-label={`Switch account on ${getSensitiveDisplayValue(pc.name, props.privacyMode, "name")}`} title={`Switch account on ${getSensitiveDisplayValue(pc.name, props.privacyMode, "name")}`} onClick={(event) => { event.stopPropagation(); if (pc.local) props.onSwitchAccount(); else props.onSwitchAccount(pc.id); }}><SwitchAccountIcon /></button>
                 </div>
                {!pcCollapsed ? <div class="cli-pc-group-children">
                  {projectGroups.map(({ project, sessions }) => {
                    const groupId = `project:${pc.id}:${project.id}`;
                    const projectCollapsed = collapsedGroups[groupId] ?? true;
                    const runningSessions = sessions.filter((session) => session.status === "running").length;
                    return <section class="cli-project-group" key={groupId}>
                       <div class={`cli-project-row ${newChatProject === project.path ? "is-selected" : ""}`}>
                         <button type="button" class="cli-project-select" aria-expanded={!projectCollapsed} onClick={() => toggleGroup(groupId, true)}>
                           <EmptyFolderIcon /><span><strong title={project.path || undefined}>{project.label}</strong></span>{runningSessions ? <span class="cli-project-running" aria-label={`${runningSessions} running session${runningSessions === 1 ? "" : "s"}`} title={`${runningSessions} running session${runningSessions === 1 ? "" : "s"}`}><span class="cli-session-spinner" aria-hidden="true" />{runningSessions}</span> : null}
                         </button>
                         <span class="cli-project-actions">
                           <button type="button" class="cli-project-collapse" aria-label={`${projectCollapsed ? "Expand" : "Collapse"} ${project.label}`} aria-expanded={!projectCollapsed} onClick={() => toggleGroup(groupId, true)}><ChevronIcon /></button>
                           {pc.local ? <button type="button" class="cli-project-new" aria-label={`New chat in ${project.label}`} title={`New chat in ${project.label}`} onClick={() => startNewChat(project.path)}><PlusIcon /></button> : null}
                         </span>
                      </div>
                      {!projectCollapsed ? <div class="cli-project-sessions" role="list">{sessions.map(renderSession)}</div> : null}
                    </section>;
                  })}
                </div> : null}
              </section>;
            })}
          </div>}
          {props.loading && props.sessions.length === 0 ? <SessionRailSkeleton /> : null}
          {props.error ? <InlineError text={props.error} retry={props.onRefresh} /> : null}
          {!props.loading && !props.error && visibleSessions.length === 0 ? <EmptySessions search={Boolean(search)} section={section} /> : null}
          {deleteTarget && deleteTarget.archived ? <DeleteConfirmation compact title={deleteTarget.title} onCancel={() => { setDeleteTarget(undefined); reportLocalFeedback({ level: "info", message: "Session deletion cancelled." }); }} onDelete={() => { const target = deleteTarget; setDeleteTarget(undefined); props.onDelete(target); }} /> : null}
          </div>
          <SessionAccountFooter
            account={props.account}
            privacyMode={props.privacyMode}
            showLogout={props.showLogout}
            accounts={props.selectedPeerId && props.selectedPeerId !== localPeerId ? (props.peerAccounts?.[props.selectedPeerId] ?? []) : undefined}
            localAccounts={props.localAccounts}
            peers={props.peers}
            peerAccounts={props.peerAccounts}
            selectedPeerId={props.selectedPeerId}
            onSwitchAccount={(peerId) => { if (mobileLayout) setRailCollapsed(true); props.onSwitchAccount(peerId); }}
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
                onRenameCancelled={() => reportLocalFeedback({ level: "info", message: "Rename cancelled." })}
                environmentOpen={environmentOpen}
                terminalCollapsed={contextCollapsed}
                onToggleEnvironment={() => setEnvironmentOpen((open) => !open)}
                onAgents={() => openContextTab("agents")}
                agentCount={props.sessions.map((session) => ({ ...session, ...readSubAgentMetadata(session) })).filter((session) => session.subAgent && session.parentSessionId === props.selectedSession?.id && (session.deviceId ?? "local") === (props.selectedSession?.deviceId ?? "local")).length}
                onToggleTerminal={() => openContextTab(contextTabs[0] ? workspaceTabKind(contextTabs[0]) : "terminal")}
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
              {deleteTarget && !deleteTarget.archived ? <DeleteConfirmation title={deleteTarget.title} onCancel={() => { setDeleteTarget(undefined); reportLocalFeedback({ level: "info", message: "Session deletion cancelled." }); }} onDelete={() => { const target = deleteTarget; setDeleteTarget(undefined); props.onDelete(target); }} /> : null}
              <div class="cli-message-region"><section ref={messageViewportRef} class="cli-message-viewport" aria-live="polite" aria-busy={props.messagesLoading} onScroll={updateMessageScrollState}>
                {props.messagesLoading && props.messages.length === 0 ? <MessageSkeleton /> : null}
                {props.messagesError ? <InlineError text={props.messagesError} retry={props.onRefreshMessages} /> : null}
                {!props.messagesLoading && !props.messagesError && props.messages.length === 0 ? <ConversationEmpty archived={selectedArchived} logoUri={props.logoUri} /> : null}
                <div ref={messagesContentRef} class="cli-session-messages" onPointerDownCapture={(event) => { if ((event.target as Element).closest("summary,button,img")) followLatestRef.current = false; }} onClick={(event) => { if ((event.target as Element).closest("summary,button,img")) followLatestRef.current = false; }}>
                  {transcriptItems.map((item) => "items" in item
                    ? <CompletedTurn key={item.id} turn={item} logoUri={props.logoUri} onActionFeedback={reportLocalFeedback} onRetryPrompt={!props.sending && !currentTurnRunning && !props.selectedSession?.archived ? () => retryMessage(item.answer.id) : undefined} onDraftMessage={!props.sending && !currentTurnRunning && !props.selectedSession?.archived ? draftFromMessage : undefined} onOpenFile={(filePath) => openContextTab("files", filePath)} onOpenReviews={(filePath) => openContextTab("reviews", filePath)} />
                    : "messages" in item
                    ? <ActivityGroup key={item.id} messages={item.messages} onOpenFile={(filePath) => openContextTab("files", filePath)} onOpenReviews={(filePath) => openContextTab("reviews", filePath)} />
                    : <SessionMessage key={item.id} message={item} logoUri={props.logoUri} turnCopyText={turnCopyText.get(item.id)} onActionFeedback={reportLocalFeedback} onRetryPrompt={!props.sending && !currentTurnRunning && !props.selectedSession?.archived ? () => retryMessage(item.id) : undefined} onDraftMessage={!props.sending && !currentTurnRunning && !props.selectedSession?.archived ? draftFromMessage : undefined} onOpenFile={(filePath) => openContextTab("files", filePath)} onOpenReviews={(filePath) => openContextTab("reviews", filePath)} />)}
                  {showWorking ? <WorkingMessage /> : null}
                  <LiveTurnDetails state={props.liveState} />
                  <div />
                </div>
              </section>
              {showLatestButton ? <button type="button" class="cli-scroll-latest" aria-label="Scroll to latest message" title="Scroll to latest message" onClick={scrollToLatest}><ChevronIcon /> Latest</button> : null}</div>
              {draftStorageWarning}
              {goal ? <details class={"cli-goal-strip is-" + goal.status}><summary><span aria-hidden="true">◎</span><span title={goal.objective}>{goal.status === "active" ? "Pursuing goal" : goal.status === "complete" ? "Goal completed" : "Goal " + goal.status} <strong>{goal.objective}</strong></span><small>{goal.elapsedMs !== undefined ? formatDuration(goal.elapsedMs) : ""}</small><ChevronIcon /></summary><div><p>{goal.objective}</p><small>{goal.detail || "Recorded goal state. Progress updates when Codex reports it."}</small></div></details> : null}
              {turnChanges ? <div class="cli-turn-change-bar" role="group" aria-label="Turn changes"><span>{turnChanges.files} file{turnChanges.files === 1 ? "" : "s"} changed <b class="is-added">+{turnChanges.additions}</b> <b class="is-removed">−{turnChanges.deletions}</b></span><button type="button" onClick={() => openContextTab("reviews")}>View changes</button></div> : null}
              {selectedArchived ? (
                <div class="cli-archived-lock"><ArchiveIcon /><span><strong>This session is archived.</strong> Restore it to open or continue the conversation.</span><button type="button" class="cli-primary-button" disabled={props.mutating} onClick={() => props.onUnarchive(props.selectedSession!)}>Restore session</button></div>
              ) : composerBlockedByOwner || props.connected === false ? (
                <div class={`cli-composer-unavailable is-running ${props.connected === false ? "is-reconnecting" : ""}`} role="status" title={props.connected === false ? "The live connection is unavailable. Sending resumes after reconnect." : `${props.selectedSession.status === "running" ? `Running in ${props.selectedSession.runningBy ?? "another Codex process"}. Wait for that run to finish.` : "Session locked. Wait for Codex to release the lock."} Next turn: ${selectedModel?.label ?? model ?? "Default"} · ${reasoningEffort ?? "Default"} · ${sandboxMode}`}>
                  {props.connected === false ? <span class="cli-live-spinner" aria-hidden="true" /> : props.selectedSession.status === "running" ? <span class="cli-live-spinner" aria-hidden="true" /> : <ShieldIcon />}<span><strong>{props.connected === false ? "Reconnecting · live updates paused" : props.selectedSession.status === "running" ? "Running elsewhere · wait to send" : "Session locked · wait to send"}</strong><small class="cli-locked-turn-settings"> - {selectedModel?.label ?? model ?? "Default"} · {reasoningEffort ?? "Default"} · {sandboxMode === "danger-full-access" ? "Full access" : sandboxMode === "read-only" ? "Read only" : "Workspace write"}</small></span>
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
            </>
          ) : newChatProject !== undefined ? (
            <>
              <section class="cli-message-viewport cli-new-chat-viewport"><div class="cli-new-chat-copy"><span class="cli-empty-mark">{props.logoUri ? <img src={props.logoUri} alt="" aria-hidden="true" /> : <CodexSessionIcon />}</span><h2>What should we build in {projects.find((project) => project.path === newChatProject)?.label ?? "your workspace"}?</h2><p>Describe the task and Codex will work directly in this project.</p></div></section>
              <UsageBanner account={props.account} onAction={(message) => reportLocalFeedback({ level: "info", message })} />
              {draftStorageWarning}
              {props.starting ? <div class="cli-composer-unavailable is-running" role="status"><span class="cli-live-spinner" aria-hidden="true" />Starting your Codex session…</div> : <Composer attachments={attachments} attachmentReading={attachmentReading} onAttach={(files) => void addAttachments(files)} onRemoveAttachment={(id) => setAttachments((current) => current.filter((file) => file.id !== id))} draft={draft} model={model} reasoningEffort={reasoningEffort} sandboxMode={sandboxMode} projectPath={newChatProject} projects={composerProjects} models={props.composerConfig?.models ?? []} reasoningOptions={reasoningOptions} sending={false} stopping={false} submitDisabled={props.connected === false || !draftReadyKeys.has(draftKey)} onDraft={setDraft} onModel={(nextModel) => { setModel(nextModel); const option = props.composerConfig?.models.find((item) => item.id === nextModel); setReasoningEffort(option?.defaultReasoningEffort ?? option?.reasoningEfforts[0]); }} onReasoning={setReasoningEffort} onSandbox={setSandboxMode} onProject={(next) => { setProjectPath(next); setNewChatProject(next); }} onSubmit={submit} composerHeight={layout.composerHeight} onResize={beginComposerResize} onResizeKeyDown={(event) => adjustComposerWithKeyboard(event.key, event.shiftKey)} onStop={() => undefined} />}
            </>
          ) : <WorkspaceEmpty logoUri={props.logoUri} running={runningCount} active={activeSessions.length} archived={archivedSessions.length} />}
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
          liveOutputs={props.terminalLiveOutputs}
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
          agentSessions={props.sessions.map((session) => ({ ...session, ...readSubAgentMetadata(session) })).filter((session) => session.subAgent && session.parentSessionId === props.selectedSession?.id && (session.deviceId ?? "local") === (props.selectedSession?.deviceId ?? "local"))}
          agentMessages={props.agentMessages ?? {}}
          onReadAgent={props.onReadAgent}
          filesLoading={props.workspaceFilesLoading}
          fileLoading={props.workspaceFileLoading}
          fileSaving={props.workspaceFileSaving}
          onDraft={setTerminalDraft}
          onRun={(command, terminalId) => { props.onRunTerminal(command, props.selectedSession?.projectPath ?? newChatProject ?? projectPath, terminalId); setTerminalDraft(""); }}
          onListTerminals={props.onListTerminals}
          onCreateTerminal={(profile) => props.onCreateTerminal(profile, selectedProjectPath)}
          onFocusTerminal={props.onFocusTerminal}
          onFeedback={reportLocalFeedback}
          onStop={() => props.onCancelTerminal(props.workspaceTerminals.find((terminal) => terminal.isActive)?.id ?? WORKSPACE_TERMINAL_ID)}
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
          onSaveFile={(filePath, content) =>
            props.onSaveFile(filePath, content, props.workspaceFilesByPath[filePath]?.revision ?? "", selectedProjectPath)
          }
          onResizePointerDown={(event) => beginPanelResize("terminal", event)}
          onResizeKeyDown={(event) => adjustPanelWithKeyboard("terminal", event.key, event.shiftKey)}
          onResizeReset={() => setLayout((current) => ({ ...current, terminalWidth: DEFAULT_WORKSPACE_LAYOUT.terminalWidth }))}
        />
      </div>
      {localFeedback ? <div class={`cli-workspace-feedback is-${localFeedback.level}`} role={localFeedback.level === "error" ? "alert" : "status"}><span>{localFeedback.message}</span><button type="button" aria-label="Dismiss message" onClick={() => setLocalFeedback(undefined)}>×</button></div> : null}
      {shareOpen && props.selectedSession ? <SessionShareModal title={props.selectedSession.title} url={window.location.href} onClose={() => setShareOpen(false)} onFeedback={reportLocalFeedback} /> : null}
    </div>
  );
}

function ConversationHeader(props: {
  session: DashboardCliSessionSummary; archived: boolean; busy: boolean; sending: boolean;
  onBack: () => void; onRefresh: () => void;
  onRename: (name: string) => void; onFork: () => void; onCopyLink: () => void; onShare: () => void;
  onArchive: () => void; onRestore: () => void; onDelete: () => void; onRenameCancelled: () => void;
  onAgents: () => void; agentCount: number;
  environmentOpen: boolean; terminalCollapsed: boolean; onToggleEnvironment: () => void; onToggleTerminal: () => void;
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
  return <header class="cli-conversation-header">
    <button type="button" class="cli-mobile-back" onClick={props.onBack}><ArrowLeftIcon /> Sessions</button>
    <div class="cli-conversation-title"><div class="cli-conversation-title-line"><h1>{props.session.title}</h1><span class={`cli-state-pill ${props.archived ? "is-archived" : props.session.status === "running" ? "is-running" : ""}`}>{props.archived ? "Archived" : props.session.status === "running" ? "Running" : "Ready"}</span></div>{props.session.projectPath ? <div class="cli-conversation-project" title={props.session.projectPath}><EmptyFolderIcon /><strong>{projectDisplayName(props.session.projectPath)}</strong><span>{props.session.projectPath}</span></div> : null}</div>
    <div class="cli-conversation-actions">
      {!props.archived ? <><IconButton label="Refresh conversation" disabled={props.busy} onClick={props.onRefresh}><RefreshIcon /></IconButton><button type="button" class="cli-secondary-button" disabled={props.busy || props.sending} onClick={props.onShare}><ShareIcon /> Share</button></> : <button type="button" class="cli-secondary-button" disabled={props.busy} onClick={props.onRestore}><RestoreIcon /> Restore</button>}
      <button type="button" class="cli-secondary-button cli-agents-button" onClick={props.onAgents}><ForkIcon /> Agents{props.agentCount ? ` (${props.agentCount})` : ""}</button>
      <IconButton label={props.environmentOpen ? "Hide Environment" : "Show Environment"} onClick={props.onToggleEnvironment}><ChangesIcon /></IconButton>
      {props.terminalCollapsed ? <IconButton label="Show workspace tools" title="Show Terminal, Files, and Reviews" onClick={props.onToggleTerminal}><PanelIcon /></IconButton> : null}
      <div class="cli-session-menu-wrap" ref={menuRef}>
        <button type="button" class="cli-icon-button" aria-label="Session actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreIcon /></button>
        {menuOpen ? <div class="cli-session-menu" role="menu">
          {!props.archived ? <>
            <button type="button" role="menuitem" disabled={props.busy || props.sending} onClick={() => { setMenuOpen(false); setRenaming(true); }}><PencilIcon /> Rename</button>
            <button type="button" role="menuitem" disabled={props.busy || props.sending} onClick={() => { setMenuOpen(false); props.onFork(); }}><ForkIcon /> Fork session</button>
            <button type="button" role="menuitem" disabled={props.busy || props.sending} onClick={() => { setMenuOpen(false); props.onArchive(); }}><ArchiveIcon /> Archive</button>
            <span />
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onShare(); }}><ShareIcon /> Share</button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onCopyLink(); }}><LinkIcon /> Copy link</button>
            <span />
          </> : null}
          <button type="button" role="menuitem" class="is-danger" disabled={props.busy || props.sending} onClick={() => { setMenuOpen(false); props.onDelete(); }}><TrashIcon /> Delete</button>
        </div> : null}
      </div>
    </div>
    {renaming ? <form class="cli-rename-form" onSubmit={(event) => { event.preventDefault(); const normalized = name.trim(); if (normalized) { props.onRename(normalized); setRenaming(false); } }}><PencilIcon /><input value={name} maxLength={160} autoFocus aria-label="Session name" onInput={(event) => setName(event.currentTarget.value)} /><button type="button" onClick={() => { setName(props.session.title); setRenaming(false); props.onRenameCancelled(); }}>Cancel</button><button type="submit" disabled={!name.trim()}>Save</button></form> : null}
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

  return <><form class="cli-composer" style={`--cli-composer-text-limit:${props.composerHeight}px`} onDragOver={(event) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { if (!event.dataTransfer?.files.length) return; event.preventDefault(); props.onAttach(Array.from(event.dataTransfer.files)); }} onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
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
      <span>{props.draft.length > 60_000 ? `${64_000 - props.draft.length} left` : null}</span>{props.sending ? <button type="button" class="cli-stop-button" disabled={props.stopping} aria-busy={props.stopping} onClick={props.onStop}><StopIcon /> {props.stopping ? "Stopping" : "Stop"}</button> : null}{!props.sending || props.canSteer ? <button type="submit" class="cli-send-button" disabled={props.submitDisabled || props.attachmentReading || (!props.draft.trim() && !props.attachments.length)} aria-label={props.canSteer ? "Send follow-up" : "Send message"} title={props.canSteer ? "Send follow-up to the running turn" : "Send message"}><SendIcon /></button> : null}</div></div>
  </form><div class="cli-composer-location"><EmptyFolderIcon /><select name="project-path" value={props.projectPath ?? ""} aria-label="Project" title={props.projectPath ?? "Work locally"} disabled={props.projectLocked} onChange={(event) => props.onProject(event.currentTarget.value)}>{props.projects.map((project) => <option value={project.path} key={project.id}>{project.label}</option>)}</select></div></>;
}

function LiveTurnDetails({ state }: { state?: DashboardCodexSessionLiveState }) {
  const tokens = state?.tokenUsage;
  const counts = tokens ? [["Input", tokens.input], ["Cached", tokens.cachedInput], ["Output", tokens.output], ["Reasoning", tokens.reasoningOutput], ["Total", tokens.total], ["Context", tokens.contextWindow]].filter((entry) => typeof entry[1] === "number") : [];
  return <div class="cli-turn-details">
    {state?.error ? <p class="cli-composer-unavailable" role="alert">{state.error}</p> : null}
    {state?.truncated ? <p role="status">Live activity reached its display limit. Refresh the conversation after the turn ends to load its saved history.</p> : null}
    {state?.plan?.steps.length ? <details class="cli-activity is-plan"><summary><strong>Current plan</strong></summary><div class="cli-activity-body">{state.plan.explanation ? <p>{state.plan.explanation}</p> : null}<ol>{state.plan.steps.map((step, index) => <li key={index}>{step.status === "completed" ? "✓ " : step.status === "inProgress" ? "In progress · " : "Pending · "}{step.step}</li>)}</ol></div></details> : null}
    {state?.diff ? <details class="cli-activity is-file-change"><summary><strong>Turn changes</strong></summary><DiffPreview diff={state.diff} /></details> : null}
    {counts.length || state?.rateLimits ? <details class="cli-activity"><summary><strong>Turn usage</strong></summary><div class="cli-activity-body">{counts.map(([label, count]) => <span key={String(label)}>{label}: {Number(count).toLocaleString()} · </span>)}{state?.rateLimits ? Object.entries(state.rateLimits).map(([window, limit]) => limit ? <p key={window}>{window === "primary" ? "Primary" : "Secondary"} window: {Math.round(limit.usedPercent)}% used{limit.resetsAt ? ` · resets ${new Date(limit.resetsAt * 1000).toLocaleString()}` : ""}</p> : null) : null}</div></details> : null}
  </div>;
}

function SessionMessage({ message, logoUri, turnCopyText, onActionFeedback, onDraftMessage, onRetryPrompt, onOpenFile, onOpenReviews }: { message: DashboardCliSessionMessage; logoUri?: string; turnCopyText?: string; onActionFeedback?: (notice: DashboardNotice) => void; onDraftMessage?: (text: string, quote: boolean) => void; onRetryPrompt?: () => void; onOpenFile?: (filePath: string) => void; onOpenReviews?: (filePath?: string) => void }) {
  const renderedText = useMemo(() => (!message.kind || message.kind === "message") && message.role !== "user" ? renderMessageText(message.text) : message.text, [message.text, message.kind, message.role]);
  const questionReplies = useMemo(() => message.role === "user" ? parseQuestionReply(message.text) : undefined, [message.text, message.role]);
  if (!message.kind || message.kind === "message") {
    const isUser = message.role === "user";
    return <article tabIndex={0} onPointerDown={(event) => { if (event.pointerType === "touch" && !(event.target as Element).closest("button,a,input,textarea,select")) event.currentTarget.focus({ preventScroll: true }); }} aria-label={`${isUser ? "Your" : "Codex"} message; focus for actions`} class={`cli-session-message is-${message.role ?? "assistant"} ${turnCopyText ? "has-turn-copy" : ""}`}><div class="cli-session-avatar">{isUser ? "Y" : logoUri ? <img src={logoUri} alt="" aria-hidden="true" /> : <CodexSessionIcon />}</div><div class="cli-session-message-body"><div class="cli-session-message-head"><strong>{isUser ? "You" : "Codex"}</strong><time>{formatTime(message.timestamp)}</time></div>{questionReplies ? <div class="cli-question-replies" aria-label="Answered questions">{questionReplies.map((reply, index) => <div class="cli-question-reply" key={`${index}-${reply.question}`}><small>Answered question</small><strong>{reply.question}</strong><span>{reply.answer}</span></div>)}</div> : message.text ? <div class="cli-session-message-text">{renderedText}</div> : null}{message.images?.length ? <div class="cli-session-images">{message.images.map((image, index) => <ImagePreview key={`${image.src}-${index}`} image={image} index={index} />)}</div> : null}<div class="cli-message-actions" role="group" aria-label="Message actions"><TurnCopyButton text={message.text} label="Copy message" onActionFeedback={onActionFeedback} />{turnCopyText && turnCopyText !== message.text ? <TurnCopyButton text={turnCopyText} onActionFeedback={onActionFeedback} /> : null}{onDraftMessage ? <><button type="button" aria-label="Quote" title="Quote" onClick={() => onDraftMessage(message.text, true)}><QuoteIcon /></button>{isUser ? <button type="button" aria-label="Edit and resend" title="Edit and resend" onClick={() => onDraftMessage(message.text, false)}><PencilIcon /></button> : turnCopyText && onRetryPrompt ? <button type="button" aria-label="Retry prompt" title="Retry prompt" onClick={onRetryPrompt}><RefreshIcon /></button> : null}</> : null}</div></div></article>;
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
      <div ref={accessibility.modalRef} class="cli-image-lightbox" role="dialog" aria-modal="true" aria-label={alt} tabIndex={-1} onKeyDown={accessibility.onKeyDown} onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}>
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

function renderMessageText(text: string): preact.ComponentChildren {
  // Use one Markdown renderer for the full assistant surface: paragraphs, headings,
  // lists, tables, blockquotes, links, images, inline code, and fenced code.
  return <MarkdownMessage text={text} />;
}

function MarkdownMessage({ text }: { text: string }) {
  const html = useMemo(() => markdownRenderer.render(text), [text]);
  const [feedback, setFeedback] = useState<string>();
  const [preview, setPreview] = useState<{ src: string; alt?: string }>();
  const copyCode = async (event: JSX.TargetedMouseEvent<HTMLDivElement>): Promise<void> => {
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
      await navigator.clipboard.writeText(code.textContent ?? "");
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

function TurnCopyButton({ text, label = "Copy assistant turn", onActionFeedback }: { text: string; label?: string; onActionFeedback?: (notice: DashboardNotice) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
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
      await navigator.clipboard.writeText(text);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1200);
    } catch {
      setState("failed");
    }
  };
  return <button type="button" class="cli-code-copy cli-code-copy-float" aria-label={state === "failed" ? `${label} failed. Select and copy manually, or retry.` : label} title={state === "failed" ? "Copy failed. Select and copy manually, or retry." : label} onClick={() => void copy()}>{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</button>;
}

function ActivityMessage({ message, onOpenFile, onOpenReviews }: { message: DashboardCliSessionMessage; onOpenFile?: (filePath: string) => void; onOpenReviews?: (filePath?: string) => void }) {
  const running = message.status === "inProgress";
  const failed = message.status === "failed" || message.kind === "error";
  return <details class={`cli-activity is-${message.kind} ${running ? "is-running" : ""} ${failed ? "is-failed" : ""}`} open={message.kind === "reasoning"}>
    <summary title={[message.command ?? message.title, message.cwd, formatTime(message.timestamp)].filter(Boolean).join(" · ")}>
      <span class="cli-activity-icon"><ActivityGlyph kind={message.kind} /></span>
      <span class="cli-activity-heading"><strong>{activityLabel(message)}</strong><small>{activityMeta(message)}</small></span>
      <span class={`cli-activity-status is-${message.status ?? "completed"}`}>{running ? <i /> : failed ? "Failed" : message.status === "declined" ? "Declined" : message.status === "interrupted" ? "Interrupted" : message.status === "unknown" ? "Unknown" : <CheckIcon />}</span>
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
      return <div class="cli-activity-copy cli-activity-detail cli-activity-compaction"><strong>Context compacted</strong><span>{message.text || "Codex condensed earlier context to continue working."}</span></div>;
    case "error":
      return <div class="cli-activity-copy cli-activity-detail cli-activity-error"><strong>Error</strong><span>{message.text || "Codex reported an error."}</span>{message.debug ? <div class="cli-code-surface"><CopySnippet text={message.debug} label="Copy debug details" /><pre><code>{message.debug}</code></pre></div> : null}</div>;
    default:
      return <div class="cli-activity-copy cli-activity-detail"><span>{message.text}</span></div>;
  }
}

function FileChangeDetails({ changes, onOpenFile, onOpenReviews }: { changes: NonNullable<DashboardCliSessionMessage["changes"]>; onOpenFile?: (filePath: string) => void; onOpenReviews?: (filePath?: string) => void }) {
  if (changes.length === 0) return <div class="cli-activity-copy">File changes are being prepared…</div>;
  return <div class="cli-file-change-list"><button type="button" class="cli-open-reviews" onClick={() => onOpenReviews?.()}><ReviewIcon /> Open all in Reviews</button>{changes.map((change) => <details key={`${change.path}-${change.kind}`}>
    <summary><span><FileIcon /><strong>{change.path}</strong></span><button type="button" onClick={(event) => { event.preventDefault(); onOpenFile?.(change.path); }}>Open</button><button type="button" onClick={(event) => { event.preventDefault(); onOpenReviews?.(change.path); }}>Review</button><small>{capitalize(change.kind)}</small><ChevronIcon /></summary>
    {change.diff ? <DiffPreview diff={change.diff} /> : <div class="cli-activity-copy">No diff details were recorded.</div>}
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
  const turnStart = turnId ? messages.findIndex((message) => message.turnId === turnId) : messages.length - 1 - [...messages].reverse().findIndex((message) => message.role === "user" && (!message.kind || message.kind === "message"));
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

function CompletedTurn({ turn, logoUri, onActionFeedback, onDraftMessage, onRetryPrompt, onOpenFile, onOpenReviews }: { turn: CompletedTranscriptTurn; onRetryPrompt?: () => void; logoUri?: string; onActionFeedback: (notice: DashboardNotice) => void; onDraftMessage?: (text: string, quote: boolean) => void; onOpenFile: (path: string) => void; onOpenReviews: (path?: string) => void }) {
  const messages = turn.items.flatMap((item) => "messages" in item ? item.messages : [item]);
  const start = Date.parse(turn.startedAt ?? messages.find((message) => message.timestamp)?.timestamp ?? "");
  const end = Date.parse(turn.answer.timestamp ?? messages.filter((message) => message.timestamp).at(-1)?.timestamp ?? "");
  const duration = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
  const turnCopy = [...messages, turn.answer].filter((message) => message.role === "assistant" && (!message.kind || message.kind === "message")).map((message) => message.text).join("\n\n");
  return <div class="cli-completed-turn">
    <details class="cli-completed-work"><summary><span>{duration !== undefined ? `Worked for ${formatDuration(duration)}` : "Worked"}</span><ChevronIcon /></summary><div class="cli-completed-work-body">{turn.items.map((item) => "messages" in item ? <ActivityGroup key={item.id} messages={item.messages} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} /> : <SessionMessage key={item.id} message={item} logoUri={logoUri} onActionFeedback={onActionFeedback} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} />)}</div></details>
    <SessionMessage message={turn.answer} logoUri={logoUri} turnCopyText={turnCopy} onRetryPrompt={onRetryPrompt} onActionFeedback={onActionFeedback} onDraftMessage={onDraftMessage} onOpenFile={onOpenFile} onOpenReviews={onOpenReviews} />
    <CompletedTurnChanges messages={messages} onOpenReviews={onOpenReviews} />
  </div>;
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
  const summary = activitySummary(messages);
  const incomplete = messages.find((message) => message.status && !["completed", "inProgress", "failed"].includes(message.status))?.status;
  return <div class={`cli-activity-group ${running ? "is-running" : ""}`}>
    <details class="cli-activity-group-details" open={running}>
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
  projectPath?: string;
  terminalWidth: number;
  draft: string;
  results: DashboardWorkspaceTerminalResult[];
  liveOutputs: DashboardWorkspaceTerminalOutput[];
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
  const outputRef = useRef<HTMLDivElement>(null);
  const [followOutput, setFollowOutput] = useState(true);
  const tabsRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!props.addOpen || props.collapsed) return;
    const outside = (event: PointerEvent): void => { if (!addMenuRef.current?.contains(event.target as Node)) props.onAddToggle(); };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") { props.onAddToggle(); addMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [props.addOpen, props.collapsed]);
  useEffect(() => {
    if (followOutput && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [followOutput, props.results.length, props.liveOutputs, props.running]);
  useEffect(() => {
    const activeTab = tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    activeTab?.closest("span")?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [props.activeTab, props.tabs.length]);
  if (props.collapsed) return <aside class="cli-terminal-panel is-collapsed" aria-hidden="true" />;
  const activeKind = workspaceTabKind(props.activeTab);
  const activePath = workspaceTabPath(props.activeTab);
  return <aside class="cli-terminal-panel cli-context-panel-v3" aria-label="Workspace tools">
    <div class="cli-context-edge-resizer" role="separator" aria-label="Resize terminal panel" aria-orientation="vertical" aria-valuemin={280} aria-valuenow={Math.round(props.terminalWidth)} tabIndex={0} onPointerDown={props.onResizePointerDown} onKeyDown={props.onResizeKeyDown} onDblClick={props.onResizeReset}><span /></div>
    <header class="cli-context-tabbar"><div class="cli-context-tabs-v3" role="tablist" aria-label="Workspace tools"><div ref={tabsRef} class="cli-context-tab-scroll" onWheel={(event) => { const target = event.currentTarget; if (target.scrollWidth <= target.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return; event.preventDefault(); target.scrollLeft += event.deltaY; }}>{props.tabs.map((tab) => { const kind = workspaceTabKind(tab); const path = workspaceTabPath(tab); const label = kind === "agents" && path ? `Agent: ${props.agentSessions.find((agent) => agent.id === path)?.agentName ?? path.slice(0, 8)}` : path ? path.split(/[\\/]/).pop() ?? path : capitalize(kind); return <span class={props.activeTab === tab ? "is-active" : ""} key={tab}><button type="button" role="tab" aria-selected={props.activeTab === tab} onClick={() => props.onTab(tab)} title={path ?? kind}>{kind === "terminal" ? <TerminalIcon /> : kind === "files" ? <FileIcon /> : kind === "agents" ? <ForkIcon /> : <ReviewIcon />}<span class="cli-context-tab-label">{label}</span></button><button type="button" aria-label={`Close ${label}`} onClick={() => props.onCloseTab(tab)}>×</button></span>; })}</div><span ref={addMenuRef} class="cli-context-add-wrap"><button type="button" class="cli-context-add" aria-label="Add workspace tool or terminal" title="Add a tool or create a terminal" aria-expanded={props.addOpen} onClick={props.onAddToggle}><PlusIcon /></button>{props.addOpen ? <div class="cli-context-add-menu" role="menu">{(["terminal", "files", "reviews", "agents"] as const).filter((tab) => !props.tabs.includes(tab)).map((tab) => <button type="button" role="menuitem" onClick={() => props.onAdd(tab)}>{tab === "terminal" ? <TerminalIcon /> : tab === "files" ? <FileIcon /> : tab === "agents" ? <ForkIcon /> : <ReviewIcon />}{capitalize(tab)}</button>)}{activeKind === "terminal" ? <><span>New terminal</span>{(["default", "powershell", "cmd", "bash"] as const).map((profile) => <button type="button" role="menuitem" onClick={() => { props.onAddToggle(); props.onCreateTerminal(profile); }}><TerminalIcon />{profile === "default" ? "Default terminal" : profile === "powershell" ? "PowerShell terminal" : `${profile.toUpperCase()} terminal`}</button>)}</> : null}{activeKind !== "terminal" && (["terminal", "files", "reviews", "agents"] as const).every((tab) => props.tabs.includes(tab)) ? <span>All tools are open</span> : null}</div> : null}</span></div><span class="cli-terminal-header-actions"><IconButton label="Hide workspace tools" onClick={props.onCollapse}><CloseIcon /></IconButton></span></header>
    {props.tabs.includes(props.activeTab) && activeKind === "agents" ? <AgentWorkspace sessions={props.agentSessions} data={props.agentMessages} activeId={activePath} onOpen={(id) => props.onAdd("agents", id)} onRefresh={props.onReadAgent} onFeedback={props.onFeedback} /> : props.tabs.includes(props.activeTab) && props.activeTab === "terminal" ? <>
    <div class="cli-terminal-toolbar"><label>VS Code terminal<select aria-label="Select VS Code terminal" value={props.terminals.find((terminal) => terminal.isActive)?.id ?? ""} onChange={(event) => { const id = event.currentTarget.value; if (id) props.onFocusTerminal(id); }}><option value="">Select terminal…</option>{props.terminals.map((terminal) => <option value={terminal.id}>{terminal.name} · {terminal.state}</option>)}</select></label><button type="button" class="cli-terminal-refresh" onClick={props.onListTerminals} title="Refresh running terminals"><RefreshIcon /></button></div>
    <div ref={outputRef} class="cli-terminal-output" role="log" aria-live="polite" onScroll={(event) => {
      const target = event.currentTarget;
      setFollowOutput(target.scrollHeight - target.scrollTop - target.clientHeight < 48);
    }}>
      {props.results.length === 0 && props.liveOutputs.length === 0 ? <div class="cli-terminal-welcome"><strong>{props.terminals.find((terminal) => terminal.isActive)?.name ?? "Project terminal"}</strong><span>Run a command below or type in the VS Code terminal to stream new output here. Existing scrollback and commands started before monitoring remain in VS Code.</span></div> : null}
      {props.liveOutputs.map((output) => <article class="is-running" key={output.id}><div><span aria-hidden="true">›</span><code>{output.command}</code></div><pre>{output.chunk || "Waiting for terminal output…"}</pre><small>running · live output</small></article>)}
      {props.results.map((result) => <article class={`is-${result.status}`} key={result.id}><div><span aria-hidden="true">›</span><code>{result.command}</code></div><pre>{result.output}</pre><small>{result.status} · {formatTerminalDuration(result.durationMs)}{result.exitCode !== undefined ? ` · exit ${result.exitCode}` : ""}</small></article>)}
      {props.running ? <div class="cli-terminal-running" role="status"><span class="cli-live-spinner" aria-hidden="true" /> Running command…</div> : null}
      {!followOutput ? <button type="button" class="cli-terminal-latest" onClick={() => {
        if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
        setFollowOutput(true);
      }}>Latest output ↓</button> : null}
    </div>
    <form class="cli-terminal-command" onSubmit={(event) => { event.preventDefault(); const command = props.draft.trim(); if (command && !props.running) props.onRun(command, props.terminals.find((terminal) => terminal.isActive)?.id); }}>
      <span aria-hidden="true">$</span><input name="terminal-command" value={props.draft} autoComplete="off" spellcheck={false} aria-label="Terminal command" placeholder="Run a command…" disabled={props.running} onInput={(event) => props.onDraft(event.currentTarget.value)} />
      {props.running ? <button type="button" class="is-stop" disabled={props.stopping} onClick={props.onStop}><StopIcon /> {props.stopping ? "Stopping…" : "Stop"}</button> : <button type="submit" disabled={!props.draft.trim()} aria-label="Run terminal command"><SendIcon /></button>}
    </form>
    </> : props.tabs.includes(props.activeTab) && activeKind === "files" ? <WorkspaceFilesView files={props.files} file={activePath ? props.filesByPath[activePath] : undefined} activePath={activePath} loading={props.filesLoading} fileLoading={props.fileLoading} saving={props.fileSaving} onRefresh={props.onListFiles} onOpenFile={(filePath) => props.onAdd("files", filePath)} onDeleteFile={props.onDeleteFile} onFeedback={props.onFeedback} onSave={props.onSaveFile} /> : props.tabs.includes(props.activeTab) && activeKind === "reviews" ? <WorkspaceReviewsView changes={props.fileChanges} agents={props.agents} activePath={activePath} onOpenFile={(filePath) => props.onAdd("files", filePath)} onOpenReview={(filePath) => props.onAdd("reviews", filePath)} onFeedback={props.onFeedback} /> : <div class="cli-context-empty cli-context-empty-start"><PanelIcon /><strong>Select a tool</strong><span>Use + to open Terminal, Files, or Reviews.</span></div>}
  </aside>;
}

function AgentWorkspace(props: { sessions: DashboardCliSessionSummary[]; data: Record<string, { messages?: DashboardCliSessionMessage[]; error?: string; loading?: boolean }>; activeId?: string; onOpen: (id: string) => void; onRefresh?: (agent: DashboardCliSessionSummary) => void; onFeedback: (notice: DashboardNotice) => void }) {
  const agent = props.sessions.find((item) => item.id === props.activeId);
  const state = agent ? props.data[cliSessionTargetKey(agent)] : undefined;
  useEffect(() => {
    if (!agent) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible" && navigator.onLine && !state?.loading) props.onRefresh?.(agent); }, 5000);
    return () => clearInterval(timer);
  }, [agent?.id, agent?.status, state?.loading]);
  return <div class="cli-agent-workspace">{props.activeId ? agent ? <><header><strong>{agent.agentName ?? "Agent"}</strong><span class={`cli-state-pill ${agent.status === "running" ? "is-running" : ""}`}>{agent.status === "running" ? "Running" : "Ready"}</span><button type="button" disabled={state?.loading} onClick={() => props.onRefresh?.(agent)}>Refresh</button></header>{state?.error ? <div role="alert" class="cli-agent-error">{state.error}</div> : null}{state?.loading ? <div role="status">Refreshing agent messages…</div> : null}<div class="cli-agent-transcript">{state?.messages?.map((message) => <SessionMessage key={message.id} message={message} onActionFeedback={props.onFeedback} />)}{!state?.loading && !state?.error && !state?.messages?.length ? <p>No messages recorded yet.</p> : null}</div></> : <p>This agent is no longer in the session list. Refresh sessions to reconnect.</p> : <><header><strong>Agents</strong><span>{props.sessions.length}</span></header>{props.sessions.length ? props.sessions.map((item) => <button type="button" class="cli-agent-row" key={item.id} onClick={() => props.onOpen(item.id)}><ForkIcon /><span><strong>{item.agentName ?? "Agent"}</strong><small>{item.title}</small></span><span>{item.status === "running" ? <span class="cli-session-spinner" aria-label="Running" /> : <CheckIcon />}</span></button>) : <p>No sub-agents recorded for this session.</p>}</>}</div>;
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
  return <article class="cli-markdown-preview"><MarkdownMessage text={props.content} /></article>;
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
  account?: DashboardAccountViewModel;
  privacyMode: boolean;
  showLogout?: boolean;
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
  const rawAccountLabel = props.account?.displayName?.trim() || props.account?.email?.trim();
  const accountLabel = rawAccountLabel
    ? getSensitiveDisplayValue(rawAccountLabel, props.privacyMode, rawAccountLabel.includes("@") ? "email" : "name")
    : "No active account";
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
              aria-label={`Switch account on ${getSensitiveDisplayValue(peer.name, props.privacyMode, "name")}`}
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
              <span><strong>{getSensitiveDisplayValue(peer.name, props.privacyMode, "name")}</strong><small>{enabledCount} enabled · {runningAccount ? `Running ${quotaDescription(runningAccount)}` : "No running account"}</small></span><ChevronIcon />
            </button>
            {hasChildren && expanded ? <div class="cli-account-submenu" role="menu" aria-label={`Accounts on ${getSensitiveDisplayValue(peer.name, props.privacyMode, "name")}`} onMouseEnter={openMenu} onFocus={openMenu}>
              {accounts.map((account) => { const selected = account.isActive || account.isCurrentWindowAccount; return <button type="button" role="menuitem" aria-current={selected ? "true" : undefined} class={`cli-account-entry ${selected ? "is-active" : ""}`} key={account.id} onClick={() => { closeMenu(); props.onSwitchAccount(peer.local ? undefined : peer.id); }}>
                <span><strong>{getSensitiveDisplayValue(account.email || account.displayName, props.privacyMode, account.email ? "email" : "name", "Unnamed account")}</strong><small>{accountDescription(account)}</small></span>
              </button>})}
    </div> : null}
          </div>;
        })}
        {props.showLogout ? (
          <form method="post" action="/logout" class="cli-account-logout-form" role="none">
            <button type="submit" role="menuitem" class="cli-account-logout">Sign out</button>
          </form>
        ) : null}
      </nav>,
      document.body
    ) : null}
  </footer>;
}

function SessionShareModal(props: { title: string; url: string; onClose: () => void; onFeedback: (notice: DashboardNotice) => void }) {
  const accessibility = useModalAccessibility(true, props.onClose);
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
  return <div ref={accessibility.modalRef} onKeyDown={accessibility.onKeyDown} class="cli-share-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) props.onClose(); }}><section class="cli-share-modal" role="dialog" aria-modal="true" aria-labelledby="cli-share-title"><header><span><ShareIcon /><strong id="cli-share-title">Share session</strong></span><IconButton label="Close share dialog" onClick={props.onClose}><CloseIcon /></IconButton></header><p>Anyone with access to this dashboard can open <strong>{props.title}</strong> from this link.</p><div class="cli-share-link-row"><input value={props.url} readOnly aria-label="Session link" onFocus={(event) => event.currentTarget.select()} /><button type="button" onClick={() => void copy()}><CopyIcon /> {copied ? "Copied" : "Copy"}</button></div></section></div>;
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
  if (message.exitCode) values.push(`exit ${message.exitCode}`);
  return values.filter(Boolean).join(" · ");
}
function DeleteConfirmation(props: { title: string; compact?: boolean; onCancel: () => void; onDelete: () => void }) { return <div class={`cli-delete-confirm ${props.compact ? "is-compact" : ""}`} role="alertdialog" aria-label={`Delete ${props.title} permanently`}><span><TrashIcon /><span><strong>Delete permanently?</strong> {props.title} cannot be recovered.</span></span><div><button type="button" class="cli-secondary-button" onClick={props.onCancel}>Cancel</button><button type="button" class="cli-danger-button" onClick={props.onDelete}>Delete</button></div></div>; }
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
function sessionMeta(session: DashboardCliSessionSummary): string {
  const project = session.projectPath ? projectDisplayName(session.projectPath) : "Workspace";
  const surface = session.sessionSurface === "vscode" ? "VS Code" : session.sessionSurface === "cli" ? "CLI" : "Compute";
  return `${project} - ${surface}`;
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
      sessionView: parsed.sessionView === "compact" ? "compact" : "projects",
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
function SessionListIcon() { return <Icon><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></Icon>; }
function SidebarIcon() { return <Icon><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 4v16" fill="none" stroke="currentColor" stroke-width="1.7"/></Icon>; }
function DashboardIcon() { return <Icon><rect x="4" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/></Icon>; }
function CodexSessionIcon() { return <Icon><path d="M8.3 3.2a5 5 0 0 1 8.5 2.1 5 5 0 0 1 2 8.5 5 5 0 0 1-2.1 8.5 5 5 0 0 1-8.5-2.1 5 5 0 0 1-2-8.5 5 5 0 0 1 2.1-8.5Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8.2 12 2.5 2.5 5.2-5.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
function ArrowLeftIcon() { return <Icon><path d="m14.5 5-7 7 7 7M8 12h11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></Icon>; }
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

function QuoteIcon() { return <Icon><path d="M4 6h6v7H7c0 2-1 3-3 4m10-11h6v7h-3c0 2-1 3-3 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></Icon>; }
