import { render } from "preact";
import { createPortal } from "preact/compat";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import packageJson from "../../package.json";
import type {
  DashboardAccountViewModel,
  DashboardActionName,
  DashboardActionPayload,
  DashboardCliComposerConfig,
  DashboardCliSessionMessage,
  DashboardCliSessionSummary,
  DashboardNotice,
  DashboardPeerView,
  DashboardUsageSample,
  DashboardWorkspaceEnvironment,
  DashboardWorkspaceFile,
  DashboardWorkspaceFileEntry,
  DashboardWorkspaceTerminalInfo,
  DashboardWorkspaceTerminalResult
} from "../../src/domain/dashboard/types";
import type { CodexDailyUsageBreakdown } from "../../src/core/types";
import { AnnouncementCenter } from "./announcementCenter";
import { BatchSelectionBar, OverviewSection, RecoveryPanel } from "./components";
import { postMessageToHost } from "./host";
import {
  compareDashboardAutoQueueAccounts,
  type DashboardAutoQueueCapabilityThresholds,
  hasDashboardAutoQueueCapability,
  sortWithQueuedAccount
} from "./accountSorting";
import {
  countAccountEnablement,
  isAccountAttention,
  isAccountClaimedByAnotherDevice,
  normalizeThresholds,
  resolveBrandSubtitle,
  resolveOverviewAccount
} from "./helpers";
import { useDashboardActions, useDashboardHostSync, useDashboardModals } from "./hooks";
import {
  CodexSessionsIcon,
  DropdownChevronIcon,
  EyeIcon,
  EyeOffIcon,
  GridViewIcon,
  InfoIcon,
  TableViewIcon
} from "./icons";
import {
  AboutModal,
  AccountInfoModal,
  AddAccountModal,
  CliSessionsPage,
  ConfirmCancelOauthModal,
  SettingsOverlay,
  ShareTokenModal
} from "./panels";
import { SavedAccountCard } from "./savedAccountCard";
import { createInitialState, reducer } from "./state";
import { resolveDashboardThemeFromMedia } from "./theme";
import { scheduleDashboardToastDismiss } from "./toast";
import { BrowserActionModal, type BrowserActionRequest } from "./browserActionModal";
import { OnboardingModal, type OnboardingStep } from "./onboardingModal";
import { canRunAccountOnThisPc } from "./accountRunPolicy";
import {
  loadPrivacyMode,
  loadUiPreferences,
  saveUiPreferences,
  savePrivacyMode,
  type AccountFilter,
  type UiPreferences
} from "./preferences";
import type { CliSessionFeedback } from "./cliSessionsModal";
import {
  invalidateCliSessionCache,
  mergeCachedCliSession,
  mergeCachedCliSessions,
  readCliSessionListCache,
  readCliSessionMessagesCache,
  readDashboardStateCache,
  writeDashboardStateCache,
  writeCliSessionListCache,
  writeCliSessionMessagesCache
} from "./cliSessionCache";

const ACCOUNT_SORT_STORAGE_KEY = "codexManager.dashboardAccountSort.v3";
const USAGE_HISTORY_STORAGE_KEY = "codexManager.dashboardUsageHistory.v1";
const DAY_MS = 24 * 60 * 60 * 1000;
type AccountSort =
  | "auto-queue"
  | "quota"
  | "time-left"
  | "login-date"
  | "account-type"
  | "subscription-expiry"
  | "email"
  | "last-refresh"
  | "status";
type MetricPriority = string;

// Reset time is the most useful default for the saved-account cards: accounts
// whose quota window expires sooner are surfaced first. Users can still choose
// Auto queue when they want quota-balance prioritisation.
const DEFAULT_ACCOUNT_SORT: AccountSort = "time-left";

function isCliSessionsPath(pathname: string): boolean {
  // The root URL is the canonical session workspace/home. Keep /workspace as
  // a backwards-compatible alias for existing bookmarks and tunnel links.
  return pathname === "/" || pathname === "/workspace" || /^\/[0-9a-f-]{36}$/i.test(pathname);
}

function getCliSessionIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1];
}

function navigateDashboardPath(path: string, setPath: (value: string) => void): void {
  const url = new URL(path, window.location.origin);
  if (window.location.pathname !== url.pathname || window.location.search !== url.search) {
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
  }
  setPath(url.pathname);
}

function buildCliSessionPath(session: Pick<DashboardCliSessionSummary, "id" | "projectPath">): string {
  const projectPath = typeof session.projectPath === "string" ? session.projectPath.trim() : "";
  return projectPath ? `/${session.id}?project=${encodeURIComponent(projectPath)}` : `/${session.id}`;
}

function isAccountSort(value: string | null): value is AccountSort {
  return (
    value === "auto-queue" ||
    value === "quota" ||
    value === "time-left" ||
    value === "login-date" ||
    value === "account-type" ||
    value === "subscription-expiry" ||
    value === "email" ||
    value === "last-refresh" ||
    value === "status"
  );
}

function App() {
  const isBrowserDashboard = document.documentElement.dataset["dashboardHost"] === "browser";
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    ...createInitialState(),
    privacyMode: loadPrivacyMode()
  }));
  const [aboutOpen, setAboutOpen] = useState(false);
  const [announcementsOpen, setAnnouncementsOpen] = useState(false);
  const [accountSort, setAccountSort] = useState<AccountSort>(() => {
    try {
      const stored = window.localStorage.getItem(ACCOUNT_SORT_STORAGE_KEY);
      if (stored === "balance-desc") return "quota";
      if (stored === "next-reset") return "time-left";
      if (stored === "name") return "email";
      return isAccountSort(stored) ? stored : DEFAULT_ACCOUNT_SORT;
    } catch {
      return DEFAULT_ACCOUNT_SORT;
    }
  });
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(loadUiPreferences);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const [shareExportCount, setShareExportCount] = useState(0);
  const [usageHistory, setUsageHistory] = useState<DashboardUsageSample[]>(loadUsageHistory);
  const [accountInfoAccountId, setAccountInfoAccountId] = useState<string>();
  const [browserPath, setBrowserPath] = useState(() => (isBrowserDashboard ? window.location.pathname : "/"));
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>("agreement");
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string>();
  const [currentAuthEmail, setCurrentAuthEmail] = useState<string>();
  const [currentAuthAlreadyAdded, setCurrentAuthAlreadyAdded] = useState(false);
  const [onboardingImportCompleted, setOnboardingImportCompleted] = useState(false);
  const onboardingPendingRef = useRef<Set<DashboardActionName>>(new Set());
  const onboardingVisibilityResolvedRef = useRef(false);
  const [browserActionRequest, setBrowserActionRequest] = useState<BrowserActionRequest>();
  const [cliSessions, setCliSessions] = useState<DashboardCliSessionSummary[]>([]);
  const [cliSessionMessages, setCliSessionMessages] = useState<DashboardCliSessionMessage[]>([]);
  const [selectedCliSession, setSelectedCliSession] = useState<DashboardCliSessionSummary>();
  const [selectedPeerId, setSelectedPeerId] = useState<string>("local");
  const [pcPickerOpen, setPcPickerOpen] = useState(false);
  const [cliSessionsMenuOpen, setCliSessionsMenuOpen] = useState(false);
  const [cliSessionsError, setCliSessionsError] = useState<string>();
  const [cliSessionMessagesError, setCliSessionMessagesError] = useState<string>();
  const [cliComposerConfig, setCliComposerConfig] = useState<DashboardCliComposerConfig>();
  const [cliSessionFeedback, setCliSessionFeedback] = useState<CliSessionFeedback>();
  const [workspaceEnvironment, setWorkspaceEnvironment] = useState<DashboardWorkspaceEnvironment>();
  const [terminalResults, setTerminalResults] = useState<DashboardWorkspaceTerminalResult[]>([]);
  const [workspaceTerminals, setWorkspaceTerminals] = useState<DashboardWorkspaceTerminalInfo[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<DashboardWorkspaceFileEntry[]>([]);
  const [workspaceFilesByPath, setWorkspaceFilesByPath] = useState<Record<string, DashboardWorkspaceFile>>({});
  const explicitCliRefreshRef = useRef(false);
  const selectedCliSessionRef = useRef<DashboardCliSessionSummary>();
  useEffect(() => {
    selectedCliSessionRef.current = selectedCliSession;
  }, [selectedCliSession]);
  const [dailyUsageByAccount, setDailyUsageByAccount] = useState<Record<string, CodexDailyUsageBreakdown>>({});
  const [dailyUsageErrorByAccount, setDailyUsageErrorByAccount] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Array<DashboardNotice & { id: number }>>([]);
  const nextNoticeIdRef = useRef(0);
  const browserPushPermissionRef = useRef<Promise<NotificationPermission | undefined>>();
  const lastBrowserPushKeyRef = useRef<string>();
  const pushBrowserNotification = useCallback(
    (notice: DashboardNotice) => {
      const major = notice.level !== "info" || Boolean(notice.actions?.length);
      if (!isBrowserDashboard || !major || typeof Notification === "undefined") {
        return;
      }
      const notificationKey = notice.notificationId ?? `${notice.level}:${notice.message}`;
      if (lastBrowserPushKeyRef.current === notificationKey) return;
      lastBrowserPushKeyRef.current = notificationKey;
      const show = () => {
        if (Notification.permission !== "granted") return;
        try {
          const notification = new Notification("Codex Manager", {
            body: notice.message,
            tag: `codex-manager-${notice.notificationId ?? notice.level}`
          });
          notification.onclick = () => window.focus();
        } catch {
          // The dashboard toast remains available when the browser blocks OS notifications.
        }
      };
      if (Notification.permission === "granted") {
        show();
        return;
      }
      if (Notification.permission === "denied") return;
      browserPushPermissionRef.current ??= Notification.requestPermission().catch(() => undefined);
      void browserPushPermissionRef.current.then(show);
    },
    [isBrowserDashboard]
  );
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const showNotice = useCallback(
    (next: DashboardNotice) => {
      const id = ++nextNoticeIdRef.current;
      setNotices((current) => {
        if (current.some((notice) => notice.level === next.level && notice.message === next.message)) return current;
        return [...current, { ...next, id }].slice(-4);
      });
      scheduleDashboardToastDismiss(() => {
        setNotices((current) => current.filter((notice) => notice.id !== id));
      });
      pushBrowserNotification(next);
    },
    [pushBrowserNotification]
  );
  const lastTerminalNoticeAtRef = useRef<number>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { patchSettings, sendAction, sendSetting, isActionPending, hasGlobalPendingAction } = useDashboardActions(
    state,
    dispatch,
    showNotice,
    selectedPeerId
  );
  const snapshot = state.snapshot;
  useEffect(() => {
    if (isBrowserDashboard || !snapshot || onboardingVisibilityResolvedRef.current) {
      return;
    }
    onboardingVisibilityResolvedRef.current = true;
    let legacyComplete = false;
    try {
      legacyComplete = window.localStorage.getItem("codexManager.onboarding.v1") === "complete";
    } catch {
      // Extension globalState remains authoritative when local storage is unavailable.
    }
    if (snapshot.onboardingCompleted || legacyComplete) {
      if (!snapshot.onboardingCompleted && legacyComplete) {
        sendAction("completeOnboarding");
      }
      return;
    }
    setOnboardingOpen(true);
  }, [isBrowserDashboard, sendAction, snapshot]);
  const dashboardCacheHydratedRef = useRef(false);
  useEffect(() => {
    if (!isBrowserDashboard) return;
    let active = true;
    void readDashboardStateCache().then((cached) => {
      if (active && cached && !dashboardCacheHydratedRef.current) dispatch({ type: "snapshot", snapshot: cached });
      dashboardCacheHydratedRef.current = true;
    });
    return () => {
      active = false;
    };
  }, [isBrowserDashboard]);
  useEffect(() => {
    if (isBrowserDashboard && snapshot) void writeDashboardStateCache(snapshot);
  }, [isBrowserDashboard, snapshot]);
  const lastCliListRequestAtRef = useRef(0);
  const lastCliRealtimeRevisionRef = useRef(0);
  const lastCliMessageRequestRef = useRef<{ sessionId: string; at: number }>();
  const requestCliSessions = useCallback(
    (force = false): void => {
      const now = Date.now();
      if (!force && now - lastCliListRequestAtRef.current < 2_000) return;
      lastCliListRequestAtRef.current = now;
      sendAction("listCodexCliSessions");
    },
    [sendAction]
  );
  const requestCliSessionMessages = useCallback(
    (sessionId: string, targetDeviceId?: string, force = false): void => {
      const now = Date.now();
      const previous = lastCliMessageRequestRef.current;
      if (!force && previous?.sessionId === sessionId && now - previous.at < 2_000) return;
      lastCliMessageRequestRef.current = { sessionId, at: now };
      const routeProject =
        getCliSessionIdFromPath(window.location.pathname) === sessionId
          ? new URLSearchParams(window.location.search).get("project")?.trim()
          : undefined;
      const projectPath = cliSessions.find((session) => session.id === sessionId)?.projectPath ?? routeProject;
      sendAction("getCodexCliSessionMessages", undefined, { sessionId, targetDeviceId, projectPath });
    },
    [cliSessions, sendAction]
  );
  const requestWorkspaceEnvironment = useCallback(
    (projectPath?: string): void => sendAction("getWorkspaceEnvironment", undefined, { projectPath }),
    [sendAction]
  );
  const requestWorkspaceTerminals = useCallback(
    (): void => sendAction("listWorkspaceTerminals", undefined, {}),
    [sendAction]
  );
  const lastAutomaticWorkspaceLoadRef = useRef<string>();
  const modals = useDashboardModals({
    dispatch,
    sendAction,
    importJsonFileReadError: snapshot?.copy.importJsonFileReadError ?? "Failed to read JSON file.",
    onNotice: showNotice,
    isBrowserDashboard
  });
  useDashboardHostSync({
    handleHostMessage: (message) => {
      if (message.type === "dashboard:snapshot") dashboardCacheHydratedRef.current = true;
      modals.handleHostMessage(message);
      if (onboardingOpen && message.type === "dashboard:action-result") {
        const onboardingAction = message.action;
        if (onboardingAction === "completeOnboarding" && onboardingPendingRef.current.has(onboardingAction)) {
          onboardingPendingRef.current.delete(onboardingAction);
          setOnboardingBusy(false);
          if (message.status === "completed") {
            try {
              window.localStorage.setItem("codexManager.onboarding.v1", "complete");
            } catch {
              // The durable extension marker is authoritative.
            }
            setOnboardingOpen(false);
          } else {
            setOnboardingError(message.error ?? "Setup completion could not be saved. Try again.");
          }
        }
        if (onboardingAction === "inspectCurrentAuth" && message.status === "completed") {
          setCurrentAuthEmail(message.payload?.currentAuthEmail);
          setCurrentAuthAlreadyAdded(message.payload?.currentAuthAlreadyAdded === true);
        }
        if (onboardingPendingRef.current.has(onboardingAction)) {
          if (message.status === "failed") {
            onboardingPendingRef.current.clear();
            setOnboardingBusy(false);
            setOnboardingError(message.error ?? "Onboarding could not complete this step. Try again.");
          } else if (message.status === "completed") {
            onboardingPendingRef.current.delete(onboardingAction);
            if (onboardingPendingRef.current.size === 0 && onboardingStep === "setup") {
              setOnboardingBusy(false);
              setOnboardingStep("import");
              sendAction("inspectCurrentAuth");
            }
          }
        }
        if (onboardingStep === "import" && onboardingAction === "importCurrent") {
          if (message.status === "completed") {
            setOnboardingBusy(false);
            setOnboardingImportCompleted(true);
          } else if (message.status === "failed") {
            setOnboardingBusy(false);
            setOnboardingError(message.error ?? "The current account could not be imported.");
          }
        }
      }
      if (message.type === "dashboard:connection") {
        setRealtimeConnected(message.connected);
        return;
      }
      if (message.type === "dashboard:notification-dismissed") {
        setBrowserActionRequest((current) =>
          current?.kind === "notification" && current.notificationId === message.notificationId ? undefined : current
        );
        return;
      }
      if (message.type === "dashboard:notice" && message.notificationId && message.actions?.length) {
        setBrowserActionRequest({
          kind: "notification",
          notificationId: message.notificationId,
          level: message.level,
          message: message.message,
          actions: message.actions
        });
      }
      const actionPrompt = message.type === "dashboard:action-result" ? message.payload?.actionPrompts?.[0] : undefined;
      if (actionPrompt?.kind === "quotaWarning") {
        setBrowserActionRequest({
          kind: "quotaWarning",
          action: "switch",
          accountId: actionPrompt.accountId,
          switchAccountId: actionPrompt.switchAccountId,
          switchLabel: actionPrompt.switchLabel,
          resetLabel: actionPrompt.resetLabel,
          selectLabel: actionPrompt.selectLabel,
          laterLabel: actionPrompt.laterLabel,
          title: "Quota warning",
          message: actionPrompt.message
        });
      }
      if (
        isBrowserDashboard &&
        message.type === "dashboard:action-result" &&
        (message.action === "switch" || message.action === "importCurrent") &&
        message.status === "completed" &&
        message.payload?.reloadRequired &&
        message.payload.reloadAccountId
      ) {
        const switchedAccount = state.snapshot?.accounts.find(
          (account) => account.id === message.payload?.reloadAccountId
        );
        setBrowserActionRequest({
          kind: "confirm",
          action: "reloadPrompt",
          accountId: message.payload.reloadAccountId,
          title: "Reload VS Code",
          message: `${message.action === "switch" ? "The account was switched" : "The current account was imported"}${switchedAccount ? ` (${switchedAccount.email})` : ""}. Reload the VS Code extension host now to apply it to this window?`,
          confirmLabel: "Reload"
        });
      }
      if (message.type === "dashboard:action-result" && message.action === "getDailyUsage" && message.accountId) {
        if (message.status === "completed" && message.payload?.dailyUsage) {
          setDailyUsageByAccount((current) => ({ ...current, [message.accountId!]: message.payload!.dailyUsage! }));
          setDailyUsageErrorByAccount((current) => {
            const next = { ...current };
            delete next[message.accountId!];
            return next;
          });
        } else if (message.status === "failed") {
          setDailyUsageErrorByAccount((current) => ({
            ...current,
            [message.accountId!]: message.error ?? "Daily usage could not be loaded."
          }));
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "listCodexCliSessions") {
        const realtimeRevision = message.payload?.realtimeRevision;
        if (typeof realtimeRevision === "number") {
          if (realtimeRevision <= lastCliRealtimeRevisionRef.current) return;
          lastCliRealtimeRevisionRef.current = realtimeRevision;
        }
        const explicitRefresh = explicitCliRefreshRef.current;
        explicitCliRefreshRef.current = false;
        if (message.status === "completed") {
          const sessions = mergeCachedCliSessions(message.payload?.cliSessions ?? [], cliSessions);
          setCliSessions(sessions);
          // Realtime list pushes intentionally omit the heavier composer
          // catalog. Preserve the last known catalog so the response box does
          // not disappear while sessions update in the background.
          setCliComposerConfig(message.payload?.cliComposerConfig ?? cliComposerConfig);
          void writeCliSessionListCache({ sessions, composerConfig: message.payload?.cliComposerConfig });
          setCliSessionsError(undefined);
          if (explicitRefresh)
            setCliSessionFeedback({ key: Date.now(), level: "info", message: "Sessions refreshed." });
          const routeId = getCliSessionIdFromPath(window.location.pathname);
          if (routeId) {
            const routeSession = sessions.find((session) => session.id === routeId);
            if (routeSession?.archived) {
              setSelectedCliSession(routeSession);
              setCliSessionMessages([]);
              setCliSessionFeedback({
                key: Date.now(),
                level: "warning",
                message: "This session is archived. Restore it below to continue the conversation."
              });
            } else if (routeSession) {
              const previousRouteSession =
                selectedCliSessionRef.current?.id === routeId ? selectedCliSessionRef.current : undefined;
              const sessionChanged =
                !previousRouteSession ||
                previousRouteSession.updatedAt !== routeSession.updatedAt ||
                previousRouteSession.status !== routeSession.status ||
                previousRouteSession.projectPath !== routeSession.projectPath ||
                previousRouteSession.runningBy !== routeSession.runningBy ||
                previousRouteSession.canStop !== routeSession.canStop;
              setSelectedCliSession(routeSession);
              // A running turn appends activity events to its transcript while
              // the session index can keep the same updatedAt. Refresh the
              // selected transcript on every realtime tick so commands and
              // reasoning appear as they happen instead of only showing the
              // generic Working indicator until the turn exits.
              if (typeof realtimeRevision !== "number" || sessionChanged || routeSession.status === "running") {
                requestCliSessionMessages(routeId, routeSession.deviceId, typeof realtimeRevision !== "number");
              }
            } else if (selectedCliSession?.id === routeId) {
              // A newly forked session can take a moment to appear in Codex's local index.
            } else {
              setCliSessionMessagesError(undefined);
              requestCliSessionMessages(routeId);
            }
          }
        } else {
          setCliSessionsError(message.error ?? "Sessions could not be loaded.");
          if (explicitRefresh)
            setCliSessionFeedback({
              key: Date.now(),
              level: "error",
              message: message.error ?? "Sessions could not be refreshed."
            });
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "getCodexCliSessionMessages") {
        if (message.status === "completed") {
          setCliSessionMessages(message.payload?.cliSessionMessages ?? []);
          if (message.payload?.cliSession?.id)
            void writeCliSessionMessagesCache(message.payload.cliSession.id, message.payload?.cliSessionMessages ?? []);
          setSelectedCliSession(
            message.payload?.cliSession
              ? mergeCachedCliSession(message.payload.cliSession, selectedCliSession)
              : selectedCliSession
          );
          setCliSessionMessagesError(undefined);
        } else {
          const error = message.error ?? "Session messages could not be loaded.";
          if (/archived sessions cannot be opened/i.test(error)) {
            const routeId = getCliSessionIdFromPath(window.location.pathname);
            const routeSession = routeId ? cliSessions.find((session) => session.id === routeId) : undefined;
            if (routeSession) setSelectedCliSession(routeSession);
            setCliSessionMessages([]);
            setCliSessionMessagesError(undefined);
            setCliSessionFeedback({
              key: Date.now(),
              level: "warning",
              message: "This session is archived. Restore it below to continue the conversation."
            });
          } else {
            setCliSessionMessagesError(error);
          }
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "sendCodexCliSessionMessage") {
        if (message.status === "completed") {
          const sessions = mergeCachedCliSessions(message.payload?.cliSessions ?? cliSessions, cliSessions);
          setCliSessions(sessions);
          setCliSessionMessages(message.payload?.cliSessionMessages ?? []);
          if (message.payload?.cliSession?.id) {
            void writeCliSessionMessagesCache(message.payload.cliSession.id, message.payload?.cliSessionMessages ?? []);
            void writeCliSessionListCache({
              sessions,
              composerConfig: cliComposerConfig
            });
          }
          setSelectedCliSession(
            message.payload?.cliSession
              ? mergeCachedCliSession(message.payload.cliSession, selectedCliSession)
              : selectedCliSession
          );
          setCliSessionMessagesError(undefined);
          setCliSessionFeedback({ key: Date.now(), level: "info", message: "Codex completed the turn." });
        } else {
          const level = message.status === "cancelled" ? "warning" : "error";
          setCliSessionFeedback({
            key: Date.now(),
            level,
            message: message.error ?? "Codex could not complete the turn."
          });
          if (selectedCliSession) requestCliSessionMessages(selectedCliSession.id, selectedCliSession.deviceId, true);
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "startCodexCliSession") {
        if (message.status === "completed" && message.payload?.cliSession) {
          const session = message.payload.cliSession;
          const sessions = mergeCachedCliSessions(message.payload.cliSessions ?? cliSessions, cliSessions);
          setCliSessions(sessions);
          setCliComposerConfig(message.payload.cliComposerConfig ?? cliComposerConfig);
          setSelectedCliSession(mergeCachedCliSession(session, selectedCliSession));
          setCliSessionMessages(message.payload.cliSessionMessages ?? []);
          setCliSessionMessagesError(undefined);
          navigateDashboardPath(buildCliSessionPath(session), setBrowserPath);
          setCliSessionFeedback({
            key: Date.now(),
            level: "info",
            message: message.payload.notice?.message ?? "New Codex chat is ready."
          });
        } else {
          setCliSessionFeedback({
            key: Date.now(),
            level: "error",
            message: message.error ?? "New Codex chat could not be started."
          });
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "cancelCodexCliSessionTurn") {
        setCliSessionFeedback({
          key: Date.now(),
          level: message.status === "completed" ? "warning" : "error",
          message:
            message.status === "completed"
              ? (message.payload?.notice?.message ?? "Stop signal sent. Waiting for the CLI to exit.")
              : (message.error ?? "The turn could not be stopped.")
        });
      }
      if (
        message.type === "dashboard:action-result" &&
        ["getWorkspaceEnvironment", "commitWorkspaceChanges", "pushWorkspaceBranch"].includes(message.action)
      ) {
        if (message.status === "completed" && message.payload?.workspaceEnvironment) {
          setWorkspaceEnvironment(message.payload.workspaceEnvironment);
          if (message.action !== "getWorkspaceEnvironment") {
            setCliSessionFeedback({
              key: Date.now(),
              level: "info",
              message: message.payload.notice?.message ?? "Environment action completed."
            });
          }
        } else if (message.status === "failed") {
          setCliSessionFeedback({
            key: Date.now(),
            level: "error",
            message: message.error ?? "The workspace environment action failed."
          });
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "runWorkspaceTerminalCommand") {
        if (message.payload?.terminalResult) {
          setTerminalResults((current) => [...current, message.payload!.terminalResult!].slice(-100));
        }
        setCliSessionFeedback({
          key: Date.now(),
          level: message.status === "completed" ? "info" : message.status === "cancelled" ? "warning" : "error",
          message:
            message.status === "completed"
              ? "Terminal command completed."
              : (message.error ?? "Terminal command failed.")
        });
        requestWorkspaceEnvironment(selectedCliSession?.projectPath);
        requestWorkspaceTerminals();
      }
      if (
        message.type === "dashboard:action-result" &&
        ["listWorkspaceTerminals", "createWorkspaceTerminal", "focusWorkspaceTerminal"].includes(message.action)
      ) {
        if (message.status === "completed") {
          setWorkspaceTerminals(
            message.payload?.workspaceTerminals ??
              (message.payload?.workspaceTerminal ? [message.payload.workspaceTerminal] : [])
          );
          if (message.action !== "listWorkspaceTerminals") {
            setCliSessionFeedback({
              key: Date.now(),
              level: "info",
              message: message.payload?.notice?.message ?? "Terminal action completed."
            });
          }
        } else {
          setCliSessionFeedback({
            key: Date.now(),
            level: "error",
            message: message.error ?? "Terminal action failed."
          });
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "listWorkspaceFiles") {
        if (message.status === "completed") setWorkspaceFiles(message.payload?.workspaceFiles ?? []);
        else
          setCliSessionFeedback({
            key: Date.now(),
            level: "error",
            message: message.error ?? "Project files could not be loaded."
          });
      }
      if (message.type === "dashboard:action-result" && message.action === "deleteWorkspaceFile") {
        if (message.status === "completed") {
          setWorkspaceFiles(message.payload?.workspaceFiles ?? []);
          if (message.payload?.deletedWorkspaceFilePath)
            setWorkspaceFilesByPath((current) => {
              const next = { ...current };
              delete next[message.payload!.deletedWorkspaceFilePath!];
              return next;
            });
          setCliSessionFeedback({
            key: Date.now(),
            level: "info",
            message: message.payload?.notice?.message ?? "File deleted."
          });
          requestWorkspaceEnvironment(selectedCliSession?.projectPath);
        } else
          setCliSessionFeedback({
            key: Date.now(),
            level: "error",
            message: message.error ?? "File could not be deleted."
          });
      }
      if (
        message.type === "dashboard:action-result" &&
        (message.action === "readWorkspaceFile" || message.action === "saveWorkspaceFile")
      ) {
        if (message.status === "completed" && message.payload?.workspaceFile) {
          const workspaceFile = message.payload.workspaceFile;
          setWorkspaceFilesByPath((current) => ({ ...current, [workspaceFile.path]: workspaceFile }));
          if (message.action === "saveWorkspaceFile") {
            setCliSessionFeedback({
              key: Date.now(),
              level: "info",
              message: message.payload.notice?.message ?? "File saved."
            });
            requestWorkspaceEnvironment(selectedCliSession?.projectPath);
          }
        } else if (message.status === "failed") {
          setCliSessionFeedback({
            key: Date.now(),
            level: "error",
            message: message.error ?? "The project file action failed."
          });
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "cancelWorkspaceTerminalCommand") {
        setCliSessionFeedback({
          key: Date.now(),
          level: message.status === "completed" ? "warning" : "error",
          message:
            message.status === "completed"
              ? "Stopping the terminal command…"
              : (message.error ?? "The terminal command could not be stopped.")
        });
      }
      if (
        message.type === "dashboard:action-result" &&
        [
          "openCodexCliSession",
          "renameCodexCliSession",
          "forkCodexCliSession",
          "archiveCodexCliSession",
          "unarchiveCodexCliSession",
          "deleteCodexCliSession"
        ].includes(message.action)
      ) {
        setCliSessionFeedback({
          key: Date.now(),
          level: message.status === "completed" ? "info" : "error",
          message:
            message.status === "completed"
              ? (message.payload?.notice?.message ?? "Session action completed.")
              : (message.error ?? "The session action failed.")
        });
        if (message.status === "completed" && message.payload?.cliSessions) {
          const sessions = mergeCachedCliSessions(message.payload.cliSessions, cliSessions);
          setCliSessions(sessions);
          void writeCliSessionListCache({ sessions, composerConfig: cliComposerConfig });
        }
        if (message.status === "completed" && message.action === "renameCodexCliSession" && message.payload?.cliSession)
          setSelectedCliSession(mergeCachedCliSession(message.payload.cliSession, selectedCliSession));
        if (message.status === "completed" && message.action === "forkCodexCliSession" && message.payload?.cliSession) {
          setSelectedCliSession(mergeCachedCliSession(message.payload.cliSession, selectedCliSession));
          setCliSessionMessages([]);
          navigateDashboardPath(buildCliSessionPath(message.payload.cliSession), setBrowserPath);
        }
        if (
          message.status === "completed" &&
          (message.action === "archiveCodexCliSession" || message.action === "deleteCodexCliSession")
        ) {
          if (selectedCliSession) void invalidateCliSessionCache(selectedCliSession.id);
          navigateDashboardPath("/", setBrowserPath);
          setSelectedCliSession(undefined);
          setCliSessionMessages([]);
        }
        if (message.status === "completed" && message.action === "unarchiveCodexCliSession" && selectedCliSession) {
          const restored = message.payload?.cliSessions?.find((session) => session.id === selectedCliSession.id);
          if (restored) setSelectedCliSession(restored);
        }
      }
    },
    handleEscape: () => modals.handleEscape(isActionPending("completeOAuthSession"))
  });
  useEffect(() => {
    if (!snapshot?.dailyUsageCache?.length) return;
    setDailyUsageByAccount((current) => {
      const next = { ...current };
      for (const entry of snapshot.dailyUsageCache ?? []) next[entry.accountId] = entry.usage;
      return next;
    });
  }, [snapshot?.dailyUsageCache]);

  useEffect(() => {
    if (!isBrowserDashboard || !isCliSessionsPath(browserPath)) return;
    const projectPath = selectedCliSession?.projectPath ?? cliComposerConfig?.projects?.[0]?.path;
    const loadKey = `${browserPath}\n${projectPath ?? ""}`;
    // Object-valued composer/session state can be replaced by every realtime
    // response. Key the automatic load by the actual route and path so those
    // renders cannot create a request -> result -> render feedback loop.
    if (lastAutomaticWorkspaceLoadRef.current === loadKey) return;
    lastAutomaticWorkspaceLoadRef.current = loadKey;
    requestWorkspaceEnvironment(projectPath);
    requestWorkspaceTerminals();
  }, [
    browserPath,
    cliComposerConfig?.projects?.[0]?.path,
    isBrowserDashboard,
    requestWorkspaceEnvironment,
    requestWorkspaceTerminals,
    selectedCliSession?.projectPath
  ]);

  useEffect(() => {
    if (!isBrowserDashboard || !realtimeConnected || !isCliSessionsPath(browserPath)) return;
    const announce = (viewing: boolean): void => {
      postMessageToHost({ type: "dashboard:workspace-presence", viewing });
    };
    const announceCurrentVisibility = (): void => announce(document.visibilityState === "visible");
    announceCurrentVisibility();
    const onVisibilityChange = (): void => announceCurrentVisibility();
    document.addEventListener("visibilitychange", onVisibilityChange);
    const timer = window.setInterval(announceCurrentVisibility, 15_000);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      announce(false);
    };
  }, [browserPath, isBrowserDashboard, realtimeConnected]);

  useEffect(() => {
    const session = selectedCliSession;
    if (!session || session.status !== "running") return;
    // Filesystem notifications are not guaranteed on every platform or for
    // every Codex writer. Keep the selected transcript fresh while a turn is
    // active; requestCliSessionMessages throttles duplicate requests.
    const refresh = (): void => requestCliSessionMessages(session.id, session.deviceId);
    const timer = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(timer);
  }, [requestCliSessionMessages, selectedCliSession?.deviceId, selectedCliSession?.id, selectedCliSession?.status]);

  useEffect(() => {
    if (!isBrowserDashboard) return;
    const onPopState = () => {
      const path = window.location.pathname;
      setBrowserPath(path);
      const sessionId = getCliSessionIdFromPath(path);
      if (!sessionId) {
        setSelectedCliSession(undefined);
        setCliSessionMessages([]);
      }
      if (path === "/" || path === "/workspace" || sessionId) requestCliSessions();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isBrowserDashboard, requestCliSessions]);

  useEffect(() => {
    if (!snapshot?.settings.cliIntegrationEnabled) return;
    if (!isBrowserDashboard) {
      requestCliSessions();
      return;
    }
    if (!isCliSessionsPath(browserPath)) return;
    void readCliSessionListCache().then((cached) => {
      if (cached) {
        setCliSessions(cached.sessions);
        setCliComposerConfig(cached.composerConfig);
      }
      // Cached content paints immediately, but every page opening revalidates
      // in the background so a recent cache never makes the UI look stale.
      requestCliSessions();
    });
    const routeId = getCliSessionIdFromPath(window.location.pathname);
    if (routeId)
      void readCliSessionMessagesCache(routeId).then((cached) => {
        if (cached) setCliSessionMessages(cached);
      });
  }, [browserPath, isBrowserDashboard, requestCliSessions, snapshot?.settings.cliIntegrationEnabled]);

  useEffect(() => {
    const terminalNotice = snapshot?.terminalNotice;
    if (!terminalNotice || lastTerminalNoticeAtRef.current === terminalNotice.createdAt) {
      return;
    }
    lastTerminalNoticeAtRef.current = terminalNotice.createdAt;
    showNotice(terminalNotice);
  }, [showNotice, snapshot?.terminalNotice]);
  useEffect(() => {
    const preference = snapshot?.settings.dashboardTheme ?? "auto";
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const applyResolvedTheme = () => {
      root.dataset["themePreference"] = preference;
      root.dataset["theme"] = resolveDashboardThemeFromMedia(preference, media);
    };

    applyResolvedTheme();
    media.addEventListener("change", applyResolvedTheme);
    const observer = new MutationObserver(applyResolvedTheme);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    return () => {
      media.removeEventListener("change", applyResolvedTheme);
      observer.disconnect();
    };
  }, [snapshot?.settings.dashboardTheme]);

  useEffect(() => {
    const workspaceRoute = isBrowserDashboard && isCliSessionsPath(browserPath);
    document.body.classList.toggle("is-cli-workspace-route", workspaceRoute);
    return () => {
      document.body.classList.remove("is-cli-workspace-route");
    };
  }, [browserPath, isBrowserDashboard]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ACCOUNT_SORT_STORAGE_KEY, accountSort);
    } catch {
      // Local storage may be unavailable in restricted webviews; sorting still works for this session.
    }
  }, [accountSort]);

  useEffect(() => {
    saveUiPreferences(uiPreferences);
  }, [uiPreferences]);

  useEffect(() => {
    savePrivacyMode(state.privacyMode);
  }, [state.privacyMode]);

  useEffect(() => {
    if (!snapshot?.usageHistory?.length) return;
    setUsageHistory((current) => {
      const next = isBrowserDashboard
        ? [...(snapshot.usageHistory ?? [])]
        : mergeUsageHistory(snapshot.usageHistory ?? [], current);
      return sameUsageHistory(current, next) ? current : next;
    });
  }, [snapshot?.usageHistory]);

  useEffect(() => {
    if (isBrowserDashboard || !usageHistory.length) return;
    postMessageToHost({ type: "dashboard:usage-history", samples: usageHistory.slice(-10_000) });
  }, [usageHistory]);

  useEffect(() => {
    if (!snapshot?.accounts.length) return;
    const at = Date.now();
    const samples: DashboardUsageSample[] = snapshot.accounts.map((account) => ({
      at,
      accountId: account.id,
      hourly: account.metrics.find((metric) => metric.key.includes("hourly"))?.percentage,
      weekly: account.metrics.find((metric) => metric.key.includes("weekly"))?.percentage,
      review: account.metrics.find((metric) => metric.key.includes("review"))?.percentage
    }));
    setUsageHistory((current) => {
      const retentionDays = snapshot.settings.usageHistoryRetentionDays;
      const cutoff = retentionDays > 0 ? at - retentionDays * DAY_MS : Number.NEGATIVE_INFINITY;
      const next = current.filter((sample) => sample.at >= cutoff);
      const latestByAccount = new Map<string, DashboardUsageSample>();
      for (const sample of next) latestByAccount.set(sample.accountId, sample);
      let changed = false;
      for (const sample of samples) {
        const previous = latestByAccount.get(sample.accountId);
        const valuesChanged =
          !previous ||
          previous.hourly !== sample.hourly ||
          previous.weekly !== sample.weekly ||
          previous.review !== sample.review;
        if (previous && !valuesChanged) continue;
        next.push(sample);
        latestByAccount.set(sample.accountId, sample);
        changed = true;
      }
      if (!changed && next.length === current.length) return current;
      try {
        window.localStorage.setItem(USAGE_HISTORY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* optional */
      }
      return next;
    });
  }, [snapshot?.accounts, snapshot?.settings.usageHistoryRetentionDays]);

  useEffect(() => {
    const handleKeyboardShortcut = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (typing || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.key.toLowerCase() === "r" && snapshot && !hasGlobalPendingAction) {
        event.preventDefault();
        sendAction("refreshAll");
      } else if (event.key.toLowerCase() === "a" && snapshot) {
        event.preventDefault();
        modals.openAddAccountModal();
      } else if (event.key.toLowerCase() === "v") {
        event.preventDefault();
        setUiPreferences((current) => ({ ...current, view: current.view === "cards" ? "list" : "cards" }));
      }
    };
    window.addEventListener("keydown", handleKeyboardShortcut);
    return () => window.removeEventListener("keydown", handleKeyboardShortcut);
  }, [snapshot, hasGlobalPendingAction, sendAction, modals]);

  if (!snapshot) {
    return (
      <main
        class={`panel ${isBrowserDashboard && isCliSessionsPath(browserPath) ? "workspace-route-dashboard-hidden" : ""}`}
        id="dashboard-main"
      >
        <section class="section loading-section">
          <div class="loading-screen" role="status" aria-live="polite" aria-label="Loading…">
            <div class="loading-logo-wrap" aria-hidden="true">
              {isBrowserDashboard ? (
                <img class="loading-logo" src="/assets/codex.svg" alt="" width="72" height="72" />
              ) : (
                <span class="loading-logo loading-logo-fallback">
                  <CodexSessionsIcon />
                </span>
              )}
            </div>
            <div class="loading-shine" aria-hidden="true">
              <span />
            </div>
            <span class="loading-label">Loading</span>
          </div>
        </section>
      </main>
    );
  }

  const connectedPeers = snapshot.connectedPeers ?? [];
  const pcOptions =
    connectedPeers.length > 0
      ? connectedPeers
      : [{ id: "local", name: "This PC", sessionCount: 0, connected: true, local: true }];
  const selectedPeer =
    pcOptions.find((peer) => peer.id === selectedPeerId) ?? pcOptions.find((peer) => peer.local) ?? pcOptions[0];
  const runningCliSessionCount = cliSessions.filter(
    (session) => session.status === "running" && !session.archived
  ).length;
  const displayedAccounts =
    selectedPeer && !selectedPeer.local ? (snapshot.peerAccounts?.[selectedPeer.id] ?? []) : snapshot.accounts;
  const overviewAccount = resolveOverviewAccount(displayedAccounts);
  const accountInfoAccount = accountInfoAccountId
    ? displayedAccounts.find((account) => account.id === accountInfoAccountId)
    : undefined;
  const openCliSessions = (): void => {
    if (!isBrowserDashboard) {
      sendAction("openWebDashboard", undefined, { path: "/" });
      return;
    }
    navigateDashboardPath("/", setBrowserPath);
    setSelectedCliSession(undefined);
    setCliSessionMessages([]);
    setCliSessionsError(undefined);
    setCliSessionMessagesError(undefined);
    requestCliSessions();
  };
  const selectCliSession = (session: DashboardCliSessionSummary): void => {
    if (session.archived) {
      setCliSessionFeedback({
        key: Date.now(),
        level: "warning",
        message: "Archived sessions cannot be opened. Restore this session first."
      });
      return;
    }
    navigateDashboardPath(buildCliSessionPath(session), setBrowserPath);
    setSelectedCliSession(session);
    setCliSessionMessagesError(undefined);
    void readCliSessionMessagesCache(session.id).then((cached) => setCliSessionMessages(cached ?? []));
    requestCliSessionMessages(session.id, session.deviceId);
  };
  const availableTags = useMemo(
    () =>
      [...new Set(displayedAccounts.flatMap((account) => account.tags))].sort((left, right) =>
        left.localeCompare(right)
      ),
    [displayedAccounts]
  );
  useEffect(() => {
    setUiPreferences((current) => {
      const filtered = current.tagFilter.filter((tag) => availableTags.includes(tag));
      return filtered.length === current.tagFilter.length ? current : { ...current, tagFilter: filtered };
    });
    if (!availableTags.length) setTagFilterOpen(false);
  }, [availableTags]);
  const sortedAccounts = useMemo(
    () =>
      sortAccounts(
        filterAccounts(
          displayedAccounts,
          uiPreferences.accountSearch,
          uiPreferences.filter,
          snapshot.settings.quotaYellowThreshold,
          uiPreferences.tagFilter,
          {
            hourlyEnabled: snapshot.settings.hourlyQuotaControlEnabled,
            hourlyThreshold: snapshot.settings.autoSwitchHourlyThreshold,
            weeklyThreshold: snapshot.settings.autoSwitchWeeklyThreshold
          }
        ),
        accountSort,
        uiPreferences.metricPriority,
        {
          hourlyEnabled: snapshot.settings.hourlyQuotaControlEnabled,
          hourlyThreshold: snapshot.settings.autoSwitchHourlyThreshold,
          weeklyThreshold: snapshot.settings.autoSwitchWeeklyThreshold
        }
      ),
    [
      displayedAccounts,
      snapshot.settings.quotaYellowThreshold,
      snapshot.settings.hourlyQuotaControlEnabled,
      snapshot.settings.autoSwitchHourlyThreshold,
      snapshot.settings.autoSwitchWeeklyThreshold,
      uiPreferences.accountSearch,
      uiPreferences.filter,
      uiPreferences.tagFilter,
      accountSort,
      uiPreferences.metricPriority
    ]
  );
  useEffect(() => {
    if (!pcOptions.some((peer) => peer.id === selectedPeerId)) {
      setSelectedPeerId(pcOptions.find((peer) => peer.local)?.id ?? pcOptions[0]!.id);
    }
  }, [pcOptions, selectedPeerId]);
  const handleAutoRefreshToggle = (enabled: boolean): void => {
    const nextMinutes = enabled ? state.lastEnabledAutoRefreshMinutes || 15 : 0;
    patchSettings({ autoRefreshMinutes: nextMinutes });
    sendSetting("autoRefreshMinutes", nextMinutes);
  };

  const handleAutoRefreshCurrentToggle = (enabled: boolean): void => {
    const nextMinutes = enabled ? state.lastEnabledAutoRefreshCurrentMinutes || 1 : 0;
    patchSettings({ autoRefreshCurrentMinutes: nextMinutes });
    sendSetting("autoRefreshCurrentMinutes", nextMinutes);
  };

  const handleAutoRefreshCurrentValue = (minutes: number): void => {
    patchSettings({ autoRefreshCurrentMinutes: minutes });
    sendSetting("autoRefreshCurrentMinutes", minutes);
  };

  const handleAutoRefreshValue = (minutes: number): void => {
    patchSettings({ autoRefreshMinutes: minutes });
    sendSetting("autoRefreshMinutes", minutes);
  };

  const handleThresholdPreview = (key: "yellow" | "green", value: number): void => {
    const thresholds =
      key === "yellow"
        ? normalizeThresholds(snapshot.settings.quotaGreenThreshold, value)
        : normalizeThresholds(value, snapshot.settings.quotaYellowThreshold);

    patchSettings({
      quotaGreenThreshold: thresholds.green,
      quotaYellowThreshold: thresholds.yellow
    });
  };

  const handleThresholdCommit = (key: "yellow" | "green", value: number): void => {
    const thresholds =
      key === "yellow"
        ? normalizeThresholds(snapshot.settings.quotaGreenThreshold, value)
        : normalizeThresholds(value, snapshot.settings.quotaYellowThreshold);

    patchSettings({
      quotaGreenThreshold: thresholds.green,
      quotaYellowThreshold: thresholds.yellow
    });
    sendSetting("quotaYellowThreshold", thresholds.yellow);
    sendSetting("quotaGreenThreshold", thresholds.green);
  };

  const selectedAccountIds = new Set(state.selectedAccountIds);
  const selectedCount = state.selectedAccountIds.length;
  const isAccountBusy = (accountId: string): boolean =>
    hasGlobalPendingAction || state.pendingActions.some((request) => request.accountId === accountId);
  const privacyToggleLabel = state.privacyMode ? snapshot.copy.showSensitive : snapshot.copy.hideSensitive;
  const prepareOAuthPending = isActionPending("prepareOAuthSession");
  const startOAuthAutoPending = isActionPending("startOAuthAutoFlow");
  const completeOAuthPending = isActionPending("completeOAuthSession");
  const importSharedPending = isActionPending("importSharedJson");
  const previewImportPending = isActionPending("previewImportSharedJson");
  const restoreBackupPending = isActionPending("restoreFromBackup");
  const restoreAuthPending = isActionPending("restoreFromAuthJson");
  const sharePending = isActionPending("shareTokens");
  const downloadSharePending = isActionPending("downloadJsonFile");
  const batchRefreshPending = isActionPending("batchRefresh");
  const batchResyncPending = isActionPending("batchResyncProfile");
  const batchRemovePending = isActionPending("batchRemove");
  const batchTagsPending = state.pendingActions.some(
    (request) => request.action === "updateTags" && request.accountId == null
  );
  const syncPending = isActionPending("syncNow") || isActionPending("configureEncryptedSync");
  const brandSubtitle = resolveBrandSubtitle(
    snapshot.brandSub,
    snapshot.settings.encryptedSyncEnabled,
    snapshot.encryptedSyncLastCompletedAt,
    snapshot.encryptedSyncEnabledSessionCount,
    snapshot.encryptedSyncSessionCount,
    displayedAccounts.length
  );
  const invalidAccountCount = displayedAccounts.filter(isAccountAttention).length;
  const validAccountCount = displayedAccounts.length - invalidAccountCount;
  const accountEnablement = countAccountEnablement(displayedAccounts);
  const claimedAccountCount = displayedAccounts.filter(isAccountClaimedByAnotherDevice).length;
  const capabilityThresholds: DashboardAutoQueueCapabilityThresholds = {
    hourlyEnabled: snapshot.settings.hourlyQuotaControlEnabled,
    hourlyThreshold: snapshot.settings.autoSwitchHourlyThreshold,
    weeklyThreshold: snapshot.settings.autoSwitchWeeklyThreshold
  };
  const capableAccountCount = displayedAccounts.filter((account) =>
    hasDashboardAutoQueueCapability(account, capabilityThresholds)
  ).length;
  const incapableAccountCount = displayedAccounts.length - capableAccountCount;
  const weeklyPercentages = displayedAccounts
    .map(
      (account) =>
        account.metrics.find(
          (metric) =>
            metric.visible &&
            metric.key.includes("weekly") &&
            typeof metric.percentage === "number" &&
            Number.isFinite(metric.percentage)
        )?.percentage
    )
    .filter((value): value is number => typeof value === "number");
  const weeklyQuotaPercent = weeklyPercentages.length
    ? Math.round(weeklyPercentages.reduce((sum, value) => sum + value, 0) / weeklyPercentages.length)
    : undefined;
  const availableMetrics = Array.from(
    new Map(
      displayedAccounts
        .flatMap((account) => account.metrics)
        .filter((metric) => metric.visible)
        .map((metric) => [metric.key, metric])
    ).values()
  );

  const handleShareTokens = (): void => {
    if (!selectedCount) {
      return;
    }
    setShareExportCount(selectedCount);
    sendAction("shareTokens", undefined, { accountIds: state.selectedAccountIds });
  };

  const handleExportAccount = (accountId: string): void => {
    setShareExportCount(1);
    sendAction("exportAuthFile", accountId);
  };

  const handleAccountAction = (
    action: DashboardActionName,
    accountId?: string,
    payload?: DashboardActionPayload
  ): void => {
    if (action === "details" && isBrowserDashboard && accountId) {
      setAccountInfoAccountId(accountId);
      return;
    }
    if (action === "reauthorize" && accountId) {
      modals.openReauthorizeModal(accountId);
      return;
    }
    if (action === "remove" && accountId) {
      const account = displayedAccounts.find((candidate) => candidate.id === accountId);
      setBrowserActionRequest({
        kind: "confirm",
        action,
        accountId,
        title: "Remove account",
        message: `Remove ${account?.email ?? "this account"} from Codex Manager?`,
        confirmLabel: "Remove",
        danger: true
      });
      return;
    }
    if (action === "consumeResetCredit" && accountId) {
      const account = displayedAccounts.find((candidate) => candidate.id === accountId);
      const available = account?.resetCreditsAvailable ?? 0;
      setBrowserActionRequest({
        kind: "confirm",
        action,
        accountId,
        title: "Reset your usage?",
        message: `Reset the rate limit for ${account?.email ?? "this account"}? ${available} reset${available === 1 ? "" : "s"} available.`,
        confirmLabel: "Reset Rate Limit"
      });
      return;
    }
    if (action === "reloadPrompt" && accountId) {
      setBrowserActionRequest({
        kind: "confirm",
        action,
        accountId,
        title: "Reload VS Code",
        message: "Reload the VS Code extension host so this window uses the active account?",
        confirmLabel: "Reload"
      });
      return;
    }
    sendAction(action, accountId, payload);
  };

  const handleExportBackup = (): void => {
    setShareExportCount(displayedAccounts.length);
    sendAction("exportBackup");
  };

  const handleEditAccountTags = (account: DashboardAccountViewModel): void => {
    setBrowserActionRequest({
      kind: "tags",
      accountId: account.id,
      accountIds: [account.id],
      mode: "set",
      initialTags: account.tags,
      title: `Edit tags: ${account.email}`
    });
  };

  const handleBatchTagMutation = (mode: "add" | "remove"): void => {
    if (!selectedCount) {
      return;
    }
    setBrowserActionRequest({
      kind: "tags",
      accountIds: state.selectedAccountIds,
      mode,
      initialTags: [],
      title: mode === "add" ? "Add tags" : "Remove tags"
    });
  };

  const openBrowserSwitchPicker = (targetDeviceId?: string): void => {
    const accountsForTarget = targetDeviceId ? (snapshot.peerAccounts?.[targetDeviceId] ?? []) : displayedAccounts;
    const accountIds = accountsForTarget
      .filter(
        (account) =>
          !account.isActive &&
          !account.switchQueued &&
          account.enabled &&
          hasDashboardAutoQueueCapability(account, capabilityThresholds) &&
          canRunAccountOnThisPc(account, hasGlobalPendingAction, snapshot.settings.encryptedSyncRegistryOverrideEnabled)
      )
      .sort((left, right) => compareDashboardAutoQueueAccounts(left, right, capabilityThresholds))
      .map((account) => account.id);
    if (accountIds.length === 0) {
      showNotice({
        level: "warning",
        message:
          snapshot.lang === "zh"
            ? "没有可切换的账号——所有账号配额都已用完。"
            : snapshot.lang === "zh-hant"
              ? "沒有可切換的帳號——所有帳號配額都已用完。"
              : "No account to switch — no capable account has enough quota remaining."
      });
      return;
    }
    setBrowserActionRequest({ kind: "switch", accountIds, targetDeviceId });
  };

  const confirmBrowserAction = (request: BrowserActionRequest, submittedTags?: string[]): void => {
    setBrowserActionRequest(undefined);
    if (request.kind === "quotaWarning") {
      const choice = submittedTags?.[0];
      if (choice === "switch" && request.switchAccountId) {
        sendAction("switch", request.switchAccountId);
      } else if (choice === "reset") {
        sendAction("consumeResetCredit", request.accountId);
      } else if (choice === "select") {
        openBrowserSwitchPicker();
      }
      return;
    }
    if (request.kind === "notification") {
      postMessageToHost({
        type: "dashboard:notification-response",
        notificationId: request.notificationId,
        action: submittedTags?.[0]
      });
      return;
    }
    if (request.kind === "switch") {
      const accountId = request.accountIds[0];
      if (accountId) {
        sendAction("switch", accountId, { targetDeviceId: request.targetDeviceId });
      }
      return;
    }
    if (request.kind === "tags") {
      sendAction("updateTags", request.accountId, {
        accountIds: request.accountIds,
        mode: request.mode,
        submittedTags: submittedTags ?? []
      });
      return;
    }
    if (request.kind === "password") {
      sendAction(request.action, undefined, {
        enabled: request.enabled,
        passphrase: submittedTags?.[0],
        passphraseConfirmation: submittedTags?.[1]
      });
      return;
    }
    sendAction(request.action, request.accountId, {
      accountIds: request.accountIds,
      confirmed: true
    });
    if (request.action === "reloadPrompt") {
      showNotice({ level: "info", message: "Reload requested. Waiting for VS Code to restart the extension host…" });
    }
  };

  const cancelBrowserAction = (request: BrowserActionRequest): void => {
    setBrowserActionRequest(undefined);
    const message =
      request.kind === "switch"
        ? "Account switch cancelled."
        : request.kind === "tags"
          ? "Tag update cancelled."
          : request.kind === "password"
            ? `${request.title} cancelled.`
            : request.kind === "notification"
              ? "Notification dismissed."
              : request.action === "reloadPrompt"
                ? "Reload postponed. Use Reload when you are ready."
                : `${request.title} cancelled.`;
    showNotice({ level: "info", message });
  };

  const handleConfigureEncryptedSync = (): void => {
    setBrowserActionRequest({
      kind: "password",
      action: "configureEncryptedSync",
      title: "Set password",
      message:
        "Create or enter the one password used for encrypted sync, remote dashboard login, and protected controls.",
      confirmPassword: true
    });
  };

  const handleRegistryOverride = (enabled: boolean): void => {
    if (!enabled) {
      sendAction("setEncryptedSyncRegistryOverride", undefined, { enabled });
      return;
    }
    setBrowserActionRequest({
      kind: "password",
      action: "setEncryptedSyncRegistryOverride",
      enabled,
      title: "Enable rescue override",
      message: "Enter the shared password to enable rescue override on this PC.",
      confirmPassword: false
    });
  };

  const acceptOnboarding = (): void => {
    setOnboardingError(undefined);
    setOnboardingStep("setup");
  };

  const submitOnboardingSetup = (values: { syncEnabled: boolean; password: string; confirmation: string }): void => {
    setOnboardingError(undefined);
    setOnboardingBusy(true);
    onboardingPendingRef.current = new Set();
    sendSetting("encryptedSyncEnabled", values.syncEnabled);
    if (values.syncEnabled) {
      onboardingPendingRef.current.add("configureEncryptedSync");
      sendAction("configureEncryptedSync", undefined, {
        passphrase: values.password,
        passphraseConfirmation: values.confirmation,
        deferSync: true
      });
    }
    if (onboardingPendingRef.current.size === 0) {
      setOnboardingBusy(false);
      setOnboardingStep("import");
      sendAction("inspectCurrentAuth");
    }
  };

  const importOnboardingCurrent = (): void => {
    setOnboardingError(undefined);
    setOnboardingBusy(true);
    sendAction("importCurrent");
  };

  const continueOnboardingCloudflare = (values: { cloudflaredDomain: string; dashboardEnabled: boolean }): void => {
    setOnboardingBusy(true);
    onboardingPendingRef.current = new Set();
    sendSetting("cloudflaredDomain", values.cloudflaredDomain);
    sendSetting("webDashboardEnabled", values.dashboardEnabled);
    setOnboardingStep("donation");
    setOnboardingBusy(false);
  };

  const finishOnboarding = (): void => {
    setOnboardingError(undefined);
    setOnboardingBusy(true);
    onboardingPendingRef.current = new Set(["completeOnboarding"]);
    sendAction("completeOnboarding");
  };

  const handleAutoSwitchLock = (lockMinutes: number): void => {
    if (!overviewAccount) {
      return;
    }
    sendAction("setAutoSwitchLock", overviewAccount.id, {
      lockMinutes
    });
  };

  const renderAddAccount = (inline: boolean, open: boolean) => (
    <AddAccountModal
      open={open}
      inline={inline}
      tab={modals.addAccountTab}
      copy={snapshot.copy}
      oauthSession={modals.oauthSession}
      oauthCallbackUrl={modals.oauthCallbackUrl}
      oauthError={modals.oauthError}
      importJsonText={modals.importJsonText}
      importJsonError={modals.importJsonError}
      importPreview={modals.importPreview}
      importResult={modals.importResult}
      copyFeedbackKey={modals.copyFeedbackKey}
      lang={snapshot.lang}
      prepareOAuthPending={prepareOAuthPending}
      startOAuthAutoPending={startOAuthAutoPending}
      completeOAuthPending={completeOAuthPending}
      importCurrentPending={isActionPending("importCurrent")}
      previewImportPending={previewImportPending}
      importSharedPending={importSharedPending}
      onClose={() => modals.closeAddAccountModal(completeOAuthPending)}
      onSelectTab={modals.handleAddAccountTabChange}
      onCreateOauthLink={modals.handlePrepareOauthLink}
      onCopyOauthLink={modals.handleCopyOauthLink}
      onOpenInBrowser={modals.handleStartOAuthAutoFlow}
      onOauthCallbackChange={modals.setOauthCallbackUrl}
      onCompleteOAuth={modals.handleCompleteOAuth}
      onImportCurrent={() => sendAction("importCurrent")}
      onImportFileSelected={modals.handleImportFileSelected}
      onImportTextChange={modals.handleImportTextChange}
      onPreviewImport={modals.handlePreviewImport}
      onSubmitImport={modals.handleSubmitImport}
    />
  );

  return (
    <>
      <a class="skip-link" href="#dashboard-main">
        Skip to main content
      </a>
      <main
        id="dashboard-main"
        class={`panel dashboard-density-compact dashboard-view-${uiPreferences.view} ${state.privacyMode ? "privacy-hidden" : ""} ${isBrowserDashboard && isCliSessionsPath(browserPath) ? "workspace-route-dashboard-hidden" : ""}`}
      >
        {snapshot.indexHealth.status !== "healthy" ? (
          <section class="section">
            <RecoveryPanel
              copy={snapshot.copy}
              health={snapshot.indexHealth}
              restoreBackupPending={restoreBackupPending}
              restoreAuthPending={restoreAuthPending}
              restoreJsonPending={importSharedPending && modals.importRecoveryMode}
              onRestoreBackup={() => sendAction("restoreFromBackup")}
              onRestoreAuth={() => sendAction("restoreFromAuthJson")}
              onImportJson={modals.openRecoveryImportModal}
            />
          </section>
        ) : null}
        <section class="section">
          {notices.length ? (
            <div class="dashboard-notice-stack" aria-label="Notifications">
              {notices.map((notice) => (
                <div
                  key={notice.id}
                  class={`dashboard-notice is-${notice.level}`}
                  role={notice.level === "error" ? "alert" : "status"}
                >
                  <span>{notice.message}</span>
                  <button
                    type="button"
                    aria-label="Dismiss notification"
                    onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div class="hero">
            <div class={`brand ${isBrowserDashboard ? "has-pc-picker" : ""}`}>
              <img class="brand-logo" src={snapshot.logoUri} alt="" aria-hidden="true" width="28" height="28" />
              <div class="brand-copy">
                <h1>Codex Manager</h1>
                <p>{brandSubtitle}</p>
              </div>
              {isBrowserDashboard && selectedPeer ? (
                <PcPickerControl
                  peers={pcOptions}
                  accountsByPeerId={Object.fromEntries(
                    pcOptions.map((peer) => [
                      peer.id,
                      peer.local ? snapshot.accounts : (snapshot.peerAccounts?.[peer.id] ?? [])
                    ])
                  )}
                  selectedPeer={selectedPeer}
                  selectedPeerId={selectedPeer.id}
                  lang={snapshot.lang}
                  open={pcPickerOpen}
                  onToggle={() => {
                    setCliSessionsMenuOpen(false);
                    setPcPickerOpen((current) => !current);
                  }}
                  onClose={() => setPcPickerOpen(false)}
                  onChange={setSelectedPeerId}
                />
              ) : null}
            </div>
            <div class="hero-settings">
              {isBrowserDashboard && realtimeConnected ? (
                <span class="dashboard-live-status" role="status" title="WebSocket real-time updates are active">
                  <span aria-hidden="true"></span>
                  Live
                </span>
              ) : null}
              {!isBrowserDashboard ? (
                <button
                  id="codexDashboardButton"
                  class="settings-btn action-btn"
                  type="button"
                  title={snapshot.lang === "zh" ? "在浏览器中打开面板" : "Open dashboard in browser"}
                  aria-label={snapshot.lang === "zh" ? "在浏览器中打开面板" : "Open dashboard in browser"}
                  onClick={() => sendAction("openWebDashboard")}
                >
                  <span class="button-face">
                    <span class="button-icon">
                      <GridViewIcon />
                    </span>
                  </span>
                </button>
              ) : null}
              {snapshot.settings.cliIntegrationEnabled === true ? (
                <CliSessionsMenu
                  peers={pcOptions}
                  runningCount={runningCliSessionCount}
                  lang={snapshot.lang}
                  open={cliSessionsMenuOpen}
                  onToggle={() => {
                    setPcPickerOpen(false);
                    setCliSessionsMenuOpen((current) => !current);
                  }}
                  onClose={() => setCliSessionsMenuOpen(false)}
                  onManage={() => {
                    setCliSessionsMenuOpen(false);
                    openCliSessions();
                  }}
                />
              ) : null}
              <button
                id="privacyToggleButton"
                class={`settings-btn action-btn icon-only ${state.privacyMode ? "is-active" : ""}`}
                type="button"
                title={privacyToggleLabel}
                aria-label={privacyToggleLabel}
                aria-pressed={state.privacyMode}
                onClick={() => dispatch({ type: "toggle-privacy" })}
              >
                <span class="button-face">
                  <span class="button-icon">{state.privacyMode ? <EyeOffIcon /> : <EyeIcon />}</span>
                </span>
              </button>
              <button
                id="syncNowButton"
                class="settings-btn refresh-view-btn action-btn icon-only"
                type="button"
                title="Sync now"
                aria-label="Sync now"
                disabled={hasGlobalPendingAction || syncPending}
                aria-busy={syncPending}
                onClick={() => sendAction("syncNow")}
              >
                <span class="button-face">
                  {syncPending ? <span class="button-spinner" aria-hidden="true"></span> : null}
                  <span class="button-label">↻</span>
                </span>
              </button>
              <button
                id="settingsOpenButton"
                class="settings-btn action-btn icon-only"
                type="button"
                title={snapshot.copy.settingsTitle}
                aria-label={snapshot.copy.settingsTitle}
                onClick={() => dispatch({ type: "open-settings" })}
              >
                <span class="button-face">
                  <span class="button-icon">⚙</span>
                </span>
              </button>
              <button
                id="aboutOpenButton"
                class="settings-btn action-btn about-btn"
                type="button"
                title={resolveAboutTitle(snapshot.lang)}
                aria-label={resolveAboutTitle(snapshot.lang)}
                onClick={() => setAboutOpen(true)}
              >
                <span class="button-face">
                  <span class="button-icon">
                    <InfoIcon />
                  </span>
                </span>
              </button>
            </div>
          </div>
          <OverviewSection
            account={overviewAccount}
            accounts={displayedAccounts}
            hasAccounts={displayedAccounts.length > 0}
            lang={snapshot.lang}
            copy={snapshot.copy}
            settings={snapshot.settings}
            now={state.now}
            privacyMode={state.privacyMode}
            disabled={hasGlobalPendingAction || snapshot.indexHealth.status === "corrupted_unrecoverable"}
            addPending={prepareOAuthPending}
            refreshAllPending={isActionPending("refreshAll")}
            consumeResetCreditPending={Boolean(
              overviewAccount && isActionPending("consumeResetCredit", overviewAccount.id)
            )}
            emptyAccountContent={!overviewAccount ? renderAddAccount(true, true) : undefined}
            metricPriority={uiPreferences.metricPriority}
            dailyUsage={overviewAccount ? dailyUsageByAccount[overviewAccount.id] : undefined}
            dailyUsagePending={Boolean(overviewAccount && isActionPending("getDailyUsage", overviewAccount.id))}
            dailyUsageError={overviewAccount ? dailyUsageErrorByAccount[overviewAccount.id] : undefined}
            onLoadDailyUsage={() => {
              if (overviewAccount) sendAction("getDailyUsage", overviewAccount.id, { days: 30 });
            }}
            usageHistory={usageHistory}
            onSetAutoSwitchLock={handleAutoSwitchLock}
            onAddAccount={
              overviewAccount
                ? modals.openAddAccountModal
                : () => document.querySelector<HTMLInputElement>("#inline-add-account-panel .oauth-link-input")?.focus()
            }
            onRefreshAll={() => sendAction("refreshAll")}
            onConfigureSync={handleConfigureEncryptedSync}
            onSyncNow={() => sendAction("syncNow")}
            syncPending={syncPending}
            switchPending={
              isActionPending("switch") || displayedAccounts.some((account) => isActionPending("switch", account.id))
            }
            reloadPending={Boolean(overviewAccount && isActionPending("reloadPrompt", overviewAccount.id))}
            registryOverridePending={isActionPending("setEncryptedSyncRegistryOverride")}
            onSetRegistryOverride={handleRegistryOverride}
            onConsumeResetCredit={() => {
              if (overviewAccount) handleAccountAction("consumeResetCredit", overviewAccount.id);
            }}
            onSwitchAccount={() => {
              // Keep account selection beside the dashboard action. Command
              // Palette/tree commands continue to use native Quick Pick.
              openBrowserSwitchPicker();
            }}
            onReloadAccount={() => {
              if (overviewAccount) handleAccountAction("reloadPrompt", overviewAccount.id, { forceReload: true });
            }}
            onUnloadAuth={() => sendAction("unloadAuth")}
            onEnableAllValid={() => sendAction("enableAllValid")}
            onDisableAll={() => sendAction("disableAll")}
            showCliSessions={snapshot.settings.cliIntegrationEnabled === true}
            onOpenCliSessions={openCliSessions}
          />
        </section>
        {displayedAccounts.length > 0 ? (
          <section class="section">
            <div class="header accounts-section-header">
              <div>
                <h2 class="header-title header-title-with-meta">
                  {snapshot.copy.savedAccounts}
                  <span class="account-count-badges">
                    <button
                      class={`header-count-badge header-count-link ${uiPreferences.filter === "all" ? "is-selected" : ""}`}
                      type="button"
                      aria-pressed={uiPreferences.filter === "all"}
                      onClick={() => setUiPreferences((current) => ({ ...current, filter: "all" }))}
                    >
                      {resolveUiText("total", snapshot.lang)} {displayedAccounts.length}
                    </button>
                    {accountEnablement.enabled > 0 ? (
                      <button
                        class={`header-count-badge is-enabled header-count-link ${uiPreferences.filter === "enabled" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "enabled"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "enabled" }))}
                      >
                        {resolveUiText("enabled", snapshot.lang)} {accountEnablement.enabled}
                      </button>
                    ) : null}
                    {accountEnablement.disabled > 0 ? (
                      <button
                        class={`header-count-badge is-disabled header-count-link ${uiPreferences.filter === "disabled" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "disabled"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "disabled" }))}
                      >
                        {resolveUiText("disabled", snapshot.lang)} {accountEnablement.disabled}
                      </button>
                    ) : null}
                    {claimedAccountCount > 0 ? (
                      <button
                        class={`header-count-badge is-claimed header-count-link ${uiPreferences.filter === "claimed" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "claimed"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "claimed" }))}
                      >
                        {resolveUiText("claimed", snapshot.lang)} {claimedAccountCount}
                      </button>
                    ) : null}
                    {validAccountCount > 0 ? (
                      <button
                        class={`header-count-badge is-valid header-count-link ${uiPreferences.filter === "healthy" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "healthy"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "healthy" }))}
                      >
                        {resolveUiText("valid", snapshot.lang)} {validAccountCount}
                      </button>
                    ) : null}
                    {invalidAccountCount > 0 ? (
                      <button
                        class={`header-count-badge header-count-link ${invalidAccountCount ? "is-invalid" : ""} ${uiPreferences.filter === "attention" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "attention"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "attention" }))}
                      >
                        {resolveUiText("invalid", snapshot.lang)} {invalidAccountCount}
                      </button>
                    ) : null}
                    {capableAccountCount > 0 ? (
                      <button
                        class={`header-count-badge is-capable header-count-link ${uiPreferences.filter === "capable" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "capable"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "capable" }))}
                      >
                        {resolveUiText("capable", snapshot.lang)} {capableAccountCount}
                      </button>
                    ) : null}
                    {incapableAccountCount > 0 ? (
                      <button
                        class={`header-count-badge header-count-link ${incapableAccountCount ? "is-incapable" : ""} ${uiPreferences.filter === "incapable" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "incapable"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "incapable" }))}
                      >
                        {resolveUiText("incapable", snapshot.lang)} {incapableAccountCount}
                      </button>
                    ) : null}
                    <button
                      class={`header-count-badge is-quota ${uiPreferences.metricPriority === "weekly" ? "is-selected" : ""}`}
                      type="button"
                      aria-pressed={uiPreferences.metricPriority === "weekly"}
                      title={resolveWeeklyQuotaTitle(weeklyQuotaPercent, weeklyPercentages.length, snapshot.lang)}
                      onClick={() => setUiPreferences((current) => ({ ...current, metricPriority: "weekly" }))}
                    >
                      {resolveUiText("weeklyShort", snapshot.lang)}{" "}
                      {weeklyQuotaPercent == null ? "—" : `${weeklyQuotaPercent}%`}
                    </button>
                  </span>
                </h2>
              </div>
              {selectedCount > 0 ? (
                <BatchSelectionBar
                  copy={snapshot.copy}
                  selectedCount={selectedCount}
                  refreshPending={batchRefreshPending}
                  resyncPending={batchResyncPending}
                  removePending={batchRemovePending}
                  sharePending={sharePending}
                  tagsPending={batchTagsPending}
                  onRefresh={() => sendAction("batchRefresh", undefined, { accountIds: state.selectedAccountIds })}
                  onResync={() => sendAction("batchResyncProfile", undefined, { accountIds: state.selectedAccountIds })}
                  onRemove={() => {
                    setBrowserActionRequest({
                      kind: "confirm",
                      action: "batchRemove",
                      accountIds: state.selectedAccountIds,
                      title: "Remove selected accounts",
                      message: `Remove ${selectedCount} selected account${selectedCount === 1 ? "" : "s"}?`,
                      confirmLabel: "Remove",
                      danger: true
                    });
                  }}
                  onShare={handleShareTokens}
                  onAddTags={() => handleBatchTagMutation("add")}
                  onRemoveTags={() => handleBatchTagMutation("remove")}
                />
              ) : null}
            </div>
            <div class="dashboard-account-toolbar">
              <label class="account-search-control">
                <span aria-hidden="true">⌕</span>
                <input
                  ref={searchInputRef}
                  name="account-search"
                  type="search"
                  autoComplete="off"
                  value={uiPreferences.accountSearch}
                  onInput={(event) =>
                    setUiPreferences((current) => ({ ...current, accountSearch: event.currentTarget.value }))
                  }
                  placeholder={resolveUiText("search", snapshot.lang)}
                  aria-label={resolveUiText("search", snapshot.lang)}
                />
                {uiPreferences.accountSearch ? (
                  <button
                    type="button"
                    aria-label={resolveUiText("clear", snapshot.lang)}
                    onClick={() => setUiPreferences((current) => ({ ...current, accountSearch: "" }))}
                  >
                    ×
                  </button>
                ) : null}
              </label>
              <label class="dashboard-select-control">
                <select
                  value={accountSort}
                  onChange={(event) => setAccountSort(event.currentTarget.value as AccountSort)}
                  aria-label={resolveSortAriaLabel(snapshot.lang)}
                >
                  {(
                    [
                      "auto-queue",
                      "quota",
                      "time-left",
                      "login-date",
                      "last-refresh",
                      "subscription-expiry",
                      "account-type",
                      "email",
                      "status"
                    ] as AccountSort[]
                  ).map((sort) => (
                    <option key={sort} value={sort}>
                      {resolveSortOptionLabel(sort, snapshot.lang)}
                    </option>
                  ))}
                </select>
              </label>
              <label class="dashboard-select-control metric-priority-control">
                <select
                  value={uiPreferences.metricPriority}
                  aria-label={resolveUiText("metric", snapshot.lang)}
                  onChange={(event) =>
                    setUiPreferences((current) => ({
                      ...current,
                      metricPriority: event.currentTarget.value as MetricPriority
                    }))
                  }
                >
                  {availableMetrics.map((metric) => (
                    <option key={metric.key} value={metric.key}>
                      {metric.label}
                    </option>
                  ))}
                </select>
              </label>
              {availableTags.length > 0 ? (
                <TagFilterControl
                  availableTags={availableTags}
                  selectedTags={uiPreferences.tagFilter}
                  open={tagFilterOpen}
                  lang={snapshot.lang}
                  onToggleOpen={() => setTagFilterOpen((current) => !current)}
                  onToggleTag={(tag) =>
                    setUiPreferences((current) => ({
                      ...current,
                      tagFilter: current.tagFilter.includes(tag)
                        ? current.tagFilter.filter((value) => value !== tag)
                        : [...current.tagFilter, tag]
                    }))
                  }
                  onClear={() => setUiPreferences((current) => ({ ...current, tagFilter: [] }))}
                  onClose={() => setTagFilterOpen(false)}
                />
              ) : null}
              <div class="dashboard-view-controls">
                <button
                  type="button"
                  class="dashboard-view-toggle active"
                  title={resolveUiText(uiPreferences.view === "cards" ? "tableView" : "gridView", snapshot.lang)}
                  aria-label={resolveUiText(uiPreferences.view === "cards" ? "tableView" : "gridView", snapshot.lang)}
                  onClick={() =>
                    setUiPreferences((current) => ({
                      ...current,
                      view: current.view === "cards" ? "list" : "cards"
                    }))
                  }
                >
                  {uiPreferences.view === "cards" ? <GridViewIcon /> : <TableViewIcon />}
                </button>
              </div>
            </div>
            {selectedPeer && !selectedPeer.local ? (
              <div class="dashboard-notice is-info" role="status">
                <span>
                  {snapshot.lang === "zh"
                    ? `当前查看：${selectedPeer.name} · ${selectedPeer.sessionCount} 个会话 · 操作通过安全连接转发。`
                    : snapshot.lang === "zh-hant"
                      ? `目前檢視：${selectedPeer.name} · ${selectedPeer.sessionCount} 個工作階段 · 操作會透過安全連線轉送。`
                      : `Viewing ${selectedPeer.name} · ${selectedPeer.sessionCount} sessions · actions are relayed over the secure connection.`}
                </span>
              </div>
            ) : null}
            <div class="accounts-grid">
              {sortedAccounts.map((account) => (
                <SavedAccountCard
                  key={account.id}
                  account={account}
                  lang={snapshot.lang}
                  copy={snapshot.copy}
                  settings={snapshot.settings}
                  now={state.now}
                  privacyMode={state.privacyMode}
                  busy={isAccountBusy(account.id)}
                  reloadPromptPending={isActionPending("reloadPrompt", account.id)}
                  switchPending={isActionPending("switch", account.id)}
                  reauthorizePending={isActionPending("reauthorize", account.id)}
                  resyncProfilePending={isActionPending("resyncProfile", account.id)}
                  refreshPending={isActionPending("refresh", account.id)}
                  detailsPending={isActionPending("details", account.id)}
                  removePending={isActionPending("remove", account.id)}
                  enabledPending={isActionPending("toggleAccountEnabled", account.id)}
                  queuePriorityPending={isActionPending("setAccountQueuePriority", account.id)}
                  tokenRefreshPending={isActionPending("setAccountTokenRefreshEnabled", account.id)}
                  manualTokenRefreshPending={isActionPending("refreshToken", account.id)}
                  updateTagsPending={isActionPending("updateTags", account.id)}
                  consumeResetCreditPending={isActionPending("consumeResetCredit", account.id)}
                  exportPending={isActionPending("shareTokens") || isActionPending("exportAuthFile")}
                  selected={selectedAccountIds.has(account.id)}
                  metricPriority={uiPreferences.metricPriority}
                  compactRow={uiPreferences.view === "list"}
                  onToggleSelected={() => dispatch({ type: "toggle-select", accountId: account.id })}
                  onExportAuth={() => handleExportAccount(account.id)}
                  onEditTags={() => handleEditAccountTags(account)}
                  onAction={handleAccountAction}
                />
              ))}
              {sortedAccounts.length === 0 ? (
                <div class="accounts-empty-filter">{resolveUiText("noResults", snapshot.lang)}</div>
              ) : null}
            </div>
          </section>
        ) : null}
      </main>

      <SettingsOverlay
        open={state.settingsOpen}
        copy={snapshot.copy}
        lang={snapshot.lang}
        settings={snapshot.settings}
        tokenAutomation={snapshot.tokenAutomation}
        encryptedSyncNeedsConfiguration={Boolean(snapshot.encryptedSyncNeedsConfiguration)}
        encryptedSyncNeedsSettingsSync={Boolean(snapshot.encryptedSyncNeedsSettingsSync)}
        usageHistoryCount={usageHistory.length}
        onClose={() => dispatch({ type: "close-settings" })}
        onPatchSettings={patchSettings}
        onSendSetting={sendSetting}
        onAutoRefreshToggle={handleAutoRefreshToggle}
        onAutoRefreshValue={handleAutoRefreshValue}
        onAutoRefreshCurrentToggle={handleAutoRefreshCurrentToggle}
        onAutoRefreshCurrentValue={handleAutoRefreshCurrentValue}
        onThresholdPreview={handleThresholdPreview}
        onThresholdCommit={handleThresholdCommit}
        onPickCodexAppPath={() => postMessageToHost({ type: "dashboard:pickCodexAppPath" })}
        onClearCodexAppPath={() => postMessageToHost({ type: "dashboard:clearCodexAppPath" })}
        onPickCodexCliPath={() => postMessageToHost({ type: "dashboard:pickCodexCliPath" })}
        onClearCodexCliPath={() => postMessageToHost({ type: "dashboard:clearCodexCliPath" })}
        onClearUsageHistory={() => {
          setUsageHistory([]);
          try {
            window.localStorage.removeItem(USAGE_HISTORY_STORAGE_KEY);
          } catch {
            /* optional */
          }
        }}
        onOpenNetworkLogs={() => sendAction("openNetworkLogs")}
        onExportBackup={handleExportBackup}
        onImportBackup={modals.openImportModal}
        onConfigureSync={handleConfigureEncryptedSync}
        onSyncNow={() => sendAction("syncNow")}
        onSetRegistryOverride={handleRegistryOverride}
        registryOverridePending={isActionPending("setEncryptedSyncRegistryOverride")}
      />

      <OnboardingModal
        open={onboardingOpen}
        step={onboardingStep}
        settings={snapshot.settings}
        lang={snapshot.lang}
        currentAuthEmail={currentAuthEmail}
        currentAuthAlreadyAdded={currentAuthAlreadyAdded}
        busy={onboardingBusy}
        error={onboardingError}
        importCompleted={onboardingImportCompleted}
        onClose={() => setOnboardingOpen(false)}
        onAccept={acceptOnboarding}
        onSubmitSetup={submitOnboardingSetup}
        onImportCurrent={importOnboardingCurrent}
        onContinueImport={() => {
          setOnboardingError(undefined);
          setOnboardingStep("cloudflare");
        }}
        onContinueCloudflare={continueOnboardingCloudflare}
        onFinish={finishOnboarding}
      />

      <AnnouncementCenter
        open={announcementsOpen}
        copy={snapshot.copy}
        state={snapshot.announcements}
        refreshPending={isActionPending("refreshAnnouncements")}
        markAllPending={isActionPending("markAllAnnouncementsRead")}
        onClose={() => setAnnouncementsOpen(false)}
        onAction={sendAction}
      />

      <AboutModal
        open={aboutOpen}
        lang={snapshot.lang}
        logoUri={snapshot.logoUri}
        version={packageJson.version}
        onClose={() => setAboutOpen(false)}
        onOpenExternal={(url) => sendAction("openExternalUrl", undefined, { url })}
      />

      <AccountInfoModal
        account={isBrowserDashboard ? accountInfoAccount : undefined}
        lang={snapshot.lang}
        closeLabel={snapshot.copy.closeModal}
        onClose={() => setAccountInfoAccountId(undefined)}
      />

      {
        <BrowserActionModal
          request={browserActionRequest}
          accounts={
            browserActionRequest?.kind === "switch" && browserActionRequest.targetDeviceId
              ? (snapshot.peerAccounts?.[browserActionRequest.targetDeviceId] ?? [])
              : displayedAccounts
          }
          lang={snapshot.lang}
          closeLabel={snapshot.copy.closeModal}
          onCancel={cancelBrowserAction}
          onConfirm={confirmBrowserAction}
          presentation={isBrowserDashboard ? "modal" : "popover"}
        />
      }

      {isBrowserDashboard && isCliSessionsPath(browserPath)
        ? createPortal(
            <CliSessionsPage
              sessions={cliSessions}
              selectedSession={selectedCliSession}
              messages={cliSessionMessages}
              composerConfig={cliComposerConfig}
              loading={isActionPending("listCodexCliSessions")}
              starting={isActionPending("startCodexCliSession")}
              messagesLoading={isActionPending("getCodexCliSessionMessages")}
              sending={isActionPending("sendCodexCliSessionMessage")}
              stopping={isActionPending("cancelCodexCliSessionTurn")}
              mutating={[
                "openCodexCliSession",
                "renameCodexCliSession",
                "forkCodexCliSession",
                "archiveCodexCliSession",
                "unarchiveCodexCliSession",
                "deleteCodexCliSession"
              ].some((action) => isActionPending(action as DashboardActionName))}
              error={cliSessionsError}
              messagesError={cliSessionMessagesError}
              feedback={cliSessionFeedback}
              environment={workspaceEnvironment}
              terminalResults={terminalResults}
              workspaceTerminals={workspaceTerminals}
              environmentLoading={isActionPending("getWorkspaceEnvironment")}
              terminalRunning={isActionPending("runWorkspaceTerminalCommand")}
              terminalStopping={isActionPending("cancelWorkspaceTerminalCommand")}
              workspaceFiles={workspaceFiles}
              workspaceFilesByPath={workspaceFilesByPath}
              workspaceFilesLoading={isActionPending("listWorkspaceFiles")}
              workspaceFileLoading={isActionPending("readWorkspaceFile")}
              workspaceFileSaving={isActionPending("saveWorkspaceFile")}
              logoUri={snapshot.logoUri}
              account={overviewAccount}
              localAccounts={snapshot.accounts}
              onSwitchAccount={openBrowserSwitchPicker}
              peers={pcOptions}
              selectedPeerId={selectedPeer?.id ?? selectedPeerId}
              peerAccounts={snapshot.peerAccounts}
              onPeerChange={setSelectedPeerId}
              onDashboard={() => navigateDashboardPath("/dash", setBrowserPath)}
              onRefresh={() => {
                explicitCliRefreshRef.current = true;
                requestCliSessions(true);
              }}
              onSelect={selectCliSession}
              onBackToList={() => {
                navigateDashboardPath("/", setBrowserPath);
                setSelectedCliSession(undefined);
                setCliSessionMessages([]);
                setCliSessionMessagesError(undefined);
              }}
              onRefreshMessages={() =>
                selectedCliSession &&
                requestCliSessionMessages(selectedCliSession.id, selectedCliSession.deviceId, true)
              }
              onRefreshEnvironment={(projectPath) => {
                lastAutomaticWorkspaceLoadRef.current = undefined;
                requestWorkspaceEnvironment(projectPath);
              }}
              onRunTerminal={(command, projectPath, terminalId) =>
                sendAction("runWorkspaceTerminalCommand", undefined, { command, projectPath, terminalId })
              }
              onListTerminals={requestWorkspaceTerminals}
              onCreateTerminal={(profile, projectPath) =>
                sendAction("createWorkspaceTerminal", undefined, { terminalProfile: profile, projectPath })
              }
              onFocusTerminal={(terminalId) => sendAction("focusWorkspaceTerminal", undefined, { terminalId })}
              onCancelTerminal={(terminalId) => sendAction("cancelWorkspaceTerminalCommand", undefined, { terminalId })}
              onCommitWorkspace={(commitMessage, projectPath) =>
                sendAction("commitWorkspaceChanges", undefined, { commitMessage, projectPath, confirmed: true })
              }
              onPushWorkspace={(projectPath) =>
                sendAction("pushWorkspaceBranch", undefined, { projectPath, confirmed: true })
              }
              onClearTerminal={() => setTerminalResults([])}
              onListFiles={(projectPath) =>
                sendAction("listWorkspaceFiles", undefined, {
                  projectPath,
                  targetDeviceId: selectedCliSession?.deviceId
                })
              }
              onReadFile={(filePath, projectPath) =>
                sendAction("readWorkspaceFile", undefined, {
                  filePath,
                  projectPath,
                  targetDeviceId: selectedCliSession?.deviceId
                })
              }
              onClearFile={() => setWorkspaceFilesByPath({})}
              onDeleteFile={(filePath, projectPath) =>
                sendAction("deleteWorkspaceFile", undefined, {
                  filePath,
                  projectPath,
                  confirmed: true,
                  targetDeviceId: selectedCliSession?.deviceId
                })
              }
              onSaveFile={(filePath, fileContent, projectPath) =>
                sendAction("saveWorkspaceFile", undefined, {
                  filePath,
                  fileContent,
                  projectPath,
                  targetDeviceId: selectedCliSession?.deviceId
                })
              }
              onStart={(input) => sendAction("startCodexCliSession", undefined, input)}
              onSend={(input) =>
                selectedCliSession &&
                sendAction("sendCodexCliSessionMessage", undefined, {
                  sessionId: selectedCliSession.id,
                  targetDeviceId: selectedCliSession.deviceId,
                  ...input
                })
              }
              onStop={(session) =>
                sendAction("cancelCodexCliSessionTurn", undefined, {
                  sessionId: session.id,
                  targetDeviceId: session.deviceId
                })
              }
              onRename={(name) =>
                selectedCliSession &&
                sendAction("renameCodexCliSession", undefined, {
                  sessionId: selectedCliSession.id,
                  targetDeviceId: selectedCliSession.deviceId,
                  text: name
                })
              }
              onFork={() =>
                selectedCliSession &&
                sendAction("forkCodexCliSession", undefined, {
                  sessionId: selectedCliSession.id,
                  targetDeviceId: selectedCliSession.deviceId
                })
              }
              onCopyLink={() => {
                void navigator.clipboard.writeText(window.location.href).then(
                  () => setCliSessionFeedback({ key: Date.now(), level: "info", message: "Session link copied." }),
                  () =>
                    setCliSessionFeedback({
                      key: Date.now(),
                      level: "error",
                      message: "Session link could not be copied. Copy it from the address bar."
                    })
                );
              }}
              onShare={() => {
                if (navigator.share) {
                  void navigator
                    .share({ title: selectedCliSession?.title ?? "Codex session", url: window.location.href })
                    .then(
                      () => setCliSessionFeedback({ key: Date.now(), level: "info", message: "Session link shared." }),
                      (error: unknown) =>
                        setCliSessionFeedback({
                          key: Date.now(),
                          level: "warning",
                          message:
                            error instanceof Error && error.name === "AbortError"
                              ? "Sharing cancelled."
                              : "Session link could not be shared."
                        })
                    );
                } else {
                  void navigator.clipboard.writeText(window.location.href).then(
                    () =>
                      setCliSessionFeedback({
                        key: Date.now(),
                        level: "info",
                        message: "Sharing is unavailable, so the session link was copied instead."
                      }),
                    () =>
                      setCliSessionFeedback({
                        key: Date.now(),
                        level: "error",
                        message: "Sharing is unavailable and the link could not be copied."
                      })
                  );
                }
              }}
              onArchive={(session) =>
                sendAction("archiveCodexCliSession", undefined, {
                  sessionId: session.id,
                  targetDeviceId: session.deviceId
                })
              }
              onOpenInCodex={(session) =>
                sendAction("openCodexCliSession", undefined, {
                  sessionId: session.id,
                  targetDeviceId: session.deviceId
                })
              }
              onUnarchive={(session) =>
                sendAction("unarchiveCodexCliSession", undefined, {
                  sessionId: session.id,
                  targetDeviceId: session.deviceId
                })
              }
              onDelete={(session) =>
                sendAction("deleteCodexCliSession", undefined, {
                  sessionId: session.id,
                  targetDeviceId: session.deviceId,
                  confirmed: true
                })
              }
            />,
            document.body
          )
        : null}

      {overviewAccount ? renderAddAccount(false, modals.addAccountModalOpen) : null}

      <ConfirmCancelOauthModal
        open={modals.confirmCancelOauthOpen}
        copy={snapshot.copy}
        onClose={modals.closeConfirmCancelOauth}
        onConfirm={modals.confirmCancelOauth}
      />

      <ShareTokenModal
        open={modals.shareModalOpen}
        copy={snapshot.copy}
        selectedCount={shareExportCount || selectedCount}
        shareModalJson={modals.shareModalJson}
        shareModalFilename={modals.shareModalFilename}
        sharePreviewExpanded={modals.sharePreviewExpanded}
        copyFeedbackKey={modals.copyFeedbackKey}
        downloadSharePending={downloadSharePending}
        onClose={modals.closeShareModal}
        onTogglePreview={modals.toggleSharePreview}
        onCopyJson={modals.handleCopyShareJson}
        onDownloadJson={modals.handleDownloadShareJson}
      />
    </>
  );
}

function sortAccounts(
  accounts: DashboardAccountViewModel[],
  sort: AccountSort,
  metricPriority: MetricPriority,
  capabilityThresholds: DashboardAutoQueueCapabilityThresholds
): DashboardAccountViewModel[] {
  const metricFor = (account: DashboardAccountViewModel, priority: MetricPriority) =>
    account.metrics.find(
      (metric) =>
        metric.visible &&
        metric.key.includes(priority) &&
        typeof metric.percentage === "number" &&
        Number.isFinite(metric.percentage)
    ) ??
    account.metrics.find(
      (metric) => metric.visible && typeof metric.percentage === "number" && Number.isFinite(metric.percentage)
    );
  const compareDefinedNumbers = (left: number | undefined, right: number | undefined, direction: 1 | -1): number => {
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return direction * (left - right);
  };
  const compareAutoQueue = (left: DashboardAccountViewModel, right: DashboardAccountViewModel): number => {
    if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    const leftPriority = left.queuePriority && hasDashboardAutoQueueCapability(left, capabilityThresholds);
    const rightPriority = right.queuePriority && hasDashboardAutoQueueCapability(right, capabilityThresholds);
    if (leftPriority !== rightPriority) {
      return leftPriority ? -1 : 1;
    }

    const healthRank = { healthy: 0, expiring: 1, quota: 2, refresh_failed: 3, disabled: 4, reauthorize: 5 } as const;
    const healthDifference = healthRank[left.healthKind] - healthRank[right.healthKind];
    if (healthDifference !== 0) return healthDifference;

    return (
      compareDashboardAutoQueueAccounts(left, right, capabilityThresholds) || left.email.localeCompare(right.email)
    );
  };

  if (sort === "auto-queue") {
    return sortWithQueuedAccount(accounts, compareAutoQueue);
  }

  const compareQuotaBalance = (
    left: DashboardAccountViewModel,
    right: DashboardAccountViewModel,
    quotaSort: "balance-desc" | "balance-asc"
  ): number => {
    const quotaValue = (account: DashboardAccountViewModel, priority: MetricPriority): number | undefined =>
      metricFor(account, priority)?.percentage;
    const valuesFor = (account: DashboardAccountViewModel): Array<number | undefined> => {
      const metrics = account.metrics
        .filter(
          (metric) => metric.visible && typeof metric.percentage === "number" && Number.isFinite(metric.percentage)
        )
        .map((metric) => metric.percentage as number);
      if (!metrics.length) return [undefined];
      const preferred = quotaValue(account, metricPriority);
      return [Math.min(...metrics), preferred, ...metrics];
    };
    const leftValues = valuesFor(left);
    const rightValues = valuesFor(right);
    const direction: 1 | -1 = quotaSort === "balance-asc" ? 1 : -1;
    for (let index = 0; index < leftValues.length; index += 1) {
      const difference = compareDefinedNumbers(leftValues[index], rightValues[index], direction);
      if (difference !== 0) return difference;
    }
    return left.email.localeCompare(right.email);
  };

  const valueFor = (account: DashboardAccountViewModel): number | string | undefined => {
    if (sort === "email") {
      return account.email.toLocaleLowerCase();
    }
    if (sort === "last-refresh") {
      return account.lastQuotaAt;
    }
    if (sort === "login-date") {
      return account.loginAt;
    }
    if (sort === "account-type") {
      return account.accountStructureLabel.toLocaleLowerCase();
    }
    if (sort === "status") {
      return ({ healthy: 0, expiring: 1, quota: 2, refresh_failed: 3, disabled: 4, reauthorize: 5 } as const)[
        account.healthKind
      ];
    }
    if (sort === "time-left") {
      const resetTimes = account.metrics
        .filter((metric) => metric.visible)
        .map((metric) => metric.resetAt)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      return resetTimes.length ? Math.min(...resetTimes) : undefined;
    }
    if (sort === "subscription-expiry") {
      return account.subscriptionExpiresAt;
    }
    return metricFor(account, metricPriority)?.percentage;
  };

  return sortWithQueuedAccount(accounts, (left, right) => {
    if (sort === "quota") {
      return compareQuotaBalance(left, right, "balance-desc");
    }
    const leftValue = valueFor(left);
    const rightValue = valueFor(right);
    if (leftValue === undefined && rightValue === undefined) {
      return left.email.localeCompare(right.email);
    }
    if (leftValue === undefined) {
      return 1;
    }
    if (rightValue === undefined) {
      return -1;
    }
    const direction =
      sort === "time-left" ||
      sort === "login-date" ||
      sort === "subscription-expiry" ||
      sort === "status" ||
      sort === "email" ||
      sort === "account-type"
        ? 1
        : -1;
    if (typeof leftValue === "string" && typeof rightValue === "string") {
      return direction * leftValue.localeCompare(rightValue);
    }
    return direction * ((leftValue as number) - (rightValue as number));
  });
}

function loadUsageHistory(): DashboardUsageSample[] {
  try {
    const raw = window.localStorage.getItem(USAGE_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is DashboardUsageSample =>
          Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as DashboardUsageSample).at === "number" &&
            typeof (item as DashboardUsageSample).accountId === "string"
          )
        )
      : [];
  } catch {
    return [];
  }
}

function mergeUsageHistory(
  authoritative: readonly DashboardUsageSample[],
  local: readonly DashboardUsageSample[]
): DashboardUsageSample[] {
  const merged = new Map<string, DashboardUsageSample>();
  for (const sample of [...authoritative, ...local]) {
    merged.set(`${sample.accountId}:${sample.at}`, sample);
  }
  return [...merged.values()].sort((left, right) => left.at - right.at).slice(-10_000);
}

function sameUsageHistory(left: readonly DashboardUsageSample[], right: readonly DashboardUsageSample[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((sample, index) => {
    const other = right[index];
    return Boolean(
      other &&
      sample.at === other.at &&
      sample.accountId === other.accountId &&
      sample.hourly === other.hourly &&
      sample.weekly === other.weekly &&
      sample.review === other.review
    );
  });
}

function filterAccounts(
  accounts: DashboardAccountViewModel[],
  query: string,
  filter: AccountFilter,
  threshold: number,
  selectedTags: string[],
  capabilityThresholds: DashboardAutoQueueCapabilityThresholds
): DashboardAccountViewModel[] {
  const normalized = query.trim().toLocaleLowerCase();
  return accounts.filter((account) => {
    const matchesQuery =
      !normalized ||
      [account.email, account.displayName, account.accountName, account.workspaceLabel, ...account.tags]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalized));
    const percentages = account.metrics
      .filter((metric) => metric.visible && typeof metric.percentage === "number")
      .map((metric) => metric.percentage as number);
    const low = percentages.some((value) => value <= threshold);
    const attention = isAccountAttention(account);
    const matchesFilter =
      filter === "all" ||
      (filter === "healthy" && !attention) ||
      (filter === "attention" && attention) ||
      (filter === "low" && low) ||
      (filter === "active" && account.isActive) ||
      (filter === "enabled" && account.enabled) ||
      (filter === "disabled" && !account.enabled) ||
      (filter === "claimed" && isAccountClaimedByAnotherDevice(account)) ||
      (filter === "capable" && hasDashboardAutoQueueCapability(account, capabilityThresholds)) ||
      (filter === "incapable" && !hasDashboardAutoQueueCapability(account, capabilityThresholds));
    const matchesTags = selectedTags.length === 0 || selectedTags.some((tag) => account.tags.includes(tag));
    return matchesQuery && matchesFilter && matchesTags;
  });
}

function TagFilterControl(props: {
  availableTags: string[];
  selectedTags: string[];
  open: boolean;
  lang: string;
  onToggleOpen: () => void;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, right: 0 });
  useEffect(() => {
    if (!props.open) return;
    const updatePosition = (): void => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPopoverPosition({ top: rect.bottom + 5, right: Math.max(8, window.innerWidth - rect.right) });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [props.open]);
  useEffect(() => {
    if (!props.open) return;
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) props.onClose();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [props.open, props.onClose]);

  const label = resolveUiText("tags", props.lang);
  const triggerLabel = props.selectedTags.length ? `${label} (${props.selectedTags.length})` : label;
  return (
    <div class="dashboard-tag-filter" ref={rootRef}>
      <button
        type="button"
        class={`dashboard-tag-filter-trigger ${props.open ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={props.open}
        aria-label={label}
        onClick={props.onToggleOpen}
      >
        <span>{triggerLabel}</span>
        <DropdownChevronIcon open={props.open} />
      </button>
      {props.open
        ? createPortal(
            <div
              ref={popoverRef}
              class="dashboard-tag-filter-popover"
              role="menu"
              style={{ top: `${popoverPosition.top}px`, right: `${popoverPosition.right}px` }}
            >
              {props.availableTags.map((tag) => (
                <label class="dashboard-tag-filter-option" key={tag}>
                  <input
                    type="checkbox"
                    checked={props.selectedTags.includes(tag)}
                    onChange={() => props.onToggleTag(tag)}
                  />
                  <span>{tag}</span>
                </label>
              ))}
              {props.selectedTags.length ? (
                <button type="button" class="dashboard-tag-filter-clear" onClick={props.onClear}>
                  {resolveUiText("clearTagsFilter", props.lang)}
                </button>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function PcPickerControl(props: {
  peers: DashboardPeerView[];
  accountsByPeerId: Record<string, DashboardAccountViewModel[]>;
  selectedPeer: DashboardPeerView;
  selectedPeerId: string;
  lang: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onChange: (peerId: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });
  const isZh = props.lang === "zh";
  const isHant = props.lang === "zh-hant";
  const localLabel = isZh ? "本机" : isHant ? "本機" : "This PC";
  const connectedLabel = isZh ? "在线" : isHant ? "線上" : "online";
  const offlineLabel = isZh ? "离线" : isHant ? "離線" : "offline";
  const syncLabel = isZh ? "同步" : isHant ? "同步" : "Sync";
  const enabledLabel = isZh ? "已启用" : isHant ? "已啟用" : "enabled";
  const disabledLabel = isZh ? "已停用" : isHant ? "已停用" : "disabled";
  const sessionsLabel = isZh ? "个会话" : isHant ? "個工作階段" : "sessions";
  const pickerLabel = isZh ? "选择电脑" : isHant ? "選擇電腦" : "Select PC";
  const peerName = (peer: DashboardPeerView): string => peer.name.trim() || (peer.local ? localLabel : pickerLabel);
  const peerStatus = (peer: DashboardPeerView): string => {
    const accounts = props.accountsByPeerId[peer.id] ?? [];
    const enabledCount = accounts.filter((account) => account.enabled).length;
    const sessionSummary = Number.isFinite(peer.sessionCount)
      ? ` · ${peer.sessionCount} ${peer.sessionCount === 1 && !isZh && !isHant ? "session" : sessionsLabel}`
      : "";
    return `${peer.connected ? connectedLabel : offlineLabel} · ${syncLabel} · ${enabledCount} ${enabledLabel} · ${accounts.length - enabledCount} ${disabledLabel}${sessionSummary}`;
  };

  useEffect(() => {
    if (!props.open) return;
    const updatePosition = (): void => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPopoverPosition({ top: rect.bottom + 7, left: Math.max(8, Math.min(rect.left, window.innerWidth - 258)) });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) props.onClose();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [props.open, props.onClose]);

  return (
    <div class="dashboard-pc-picker" ref={rootRef}>
      <button
        type="button"
        class={`dashboard-pc-picker-trigger ${props.open ? "active" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={props.open}
        aria-label={pickerLabel}
        title={pickerLabel}
        onClick={props.onToggle}
      >
        <span class="dashboard-pc-picker-copy">
          <strong>{peerName(props.selectedPeer)}</strong>
          <small title={peerStatus(props.selectedPeer)}>{peerStatus(props.selectedPeer)}</small>
        </span>
        <DropdownChevronIcon open={props.open} />
      </button>
      {props.open
        ? createPortal(
            <div
              ref={popoverRef}
              class="dashboard-pc-picker-popover"
              role="listbox"
              aria-label={pickerLabel}
              style={{ top: `${popoverPosition.top}px`, left: `${popoverPosition.left}px` }}
            >
              <div class="dashboard-pc-picker-heading">
                {isZh ? "已连接的电脑" : isHant ? "已連線的電腦" : "Connected PCs"}
              </div>
              {props.peers.map((peer) => (
                <button
                  key={peer.id}
                  type="button"
                  role="option"
                  aria-selected={props.selectedPeerId === peer.id}
                  class={`dashboard-pc-picker-option ${props.selectedPeerId === peer.id ? "is-selected" : ""}`}
                  onClick={() => {
                    props.onChange(peer.id);
                    props.onClose();
                  }}
                >
                  <span class={`dashboard-pc-picker-status ${peer.connected ? "is-online" : ""}`} aria-hidden="true" />
                  <span class="dashboard-pc-picker-copy">
                    <strong>{peerName(peer)}</strong>
                    <small title={peerStatus(peer)}>{peerStatus(peer)}</small>
                  </span>
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function CliSessionsMenu(props: {
  peers: DashboardPeerView[];
  runningCount: number;
  lang: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onManage: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });
  const isZh = props.lang === "zh";
  const isHant = props.lang === "zh-hant";
  const menuLabel = isZh ? "电脑和会话" : isHant ? "電腦和工作階段" : "PCs and sessions";
  const heading = isZh ? "电脑状态" : isHant ? "電腦狀態" : "PC status";
  const localLabel = isZh ? "本机" : isHant ? "本機" : "This PC";
  const onlineLabel = isZh ? "在线" : isHant ? "線上" : "Online";
  const offlineLabel = isZh ? "离线" : isHant ? "離線" : "Offline";
  const manageLabel = isZh ? "管理会话" : isHant ? "管理工作階段" : "Manage sessions";
  const peerName = (peer: DashboardPeerView): string => peer.name.trim() || (peer.local ? localLabel : "PC");
  const sessionLabel = (count: number): string => {
    if (isZh) {
      return `${count} 个会话`;
    }
    if (isHant) {
      return `${count} 個工作階段`;
    }
    return `${count} ${count === 1 ? "session" : "sessions"}`;
  };

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const updatePosition = (): void => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const width = Math.min(280, window.innerWidth - 16);
      setPopoverPosition({
        top: rect.bottom + 7,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        props.onClose();
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      props.onClose();
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [props.open, props.onClose]);

  return (
    <div class="cli-sessions-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        id="cliSessionsButton"
        class={`settings-btn action-btn icon-only cli-sessions-entry ${props.runningCount > 0 ? "has-running" : ""} ${props.open ? "is-active" : ""}`}
        type="button"
        title={menuLabel}
        aria-label={menuLabel}
        aria-haspopup="dialog"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <span class="button-face">
          <span class="button-icon">
            <CodexSessionsIcon />
          </span>
        </span>
        {props.runningCount > 0 ? (
          <span class="cli-running-count" aria-label={`${props.runningCount} running sessions`}>
            {Math.min(99, props.runningCount)}
          </span>
        ) : null}
      </button>
      {props.open
        ? createPortal(
            <div
              ref={popoverRef}
              class="cli-sessions-popover"
              role="dialog"
              aria-label={menuLabel}
              style={{ top: `${popoverPosition.top}px`, left: `${popoverPosition.left}px` }}
            >
              <div class="cli-sessions-popover-heading">{heading}</div>
              <div class="cli-sessions-pc-list" role="list">
                {props.peers.map((peer) => (
                  <div class="cli-sessions-pc-row" role="listitem" key={peer.id}>
                    <span class={`cli-sessions-pc-status ${peer.connected ? "is-online" : ""}`} aria-hidden="true" />
                    <span class="cli-sessions-pc-copy">
                      <strong>{peerName(peer)}</strong>
                      <small>{sessionLabel(peer.sessionCount)}</small>
                    </span>
                    <span class={`cli-sessions-pc-state ${peer.connected ? "is-online" : ""}`}>
                      {peer.connected ? onlineLabel : offlineLabel}
                    </span>
                  </div>
                ))}
              </div>
              <button type="button" class="cli-sessions-manage" onClick={props.onManage}>
                <span class="cli-sessions-manage-icon" aria-hidden="true">
                  <CodexSessionsIcon />
                </span>
                <span>{manageLabel}</span>
                <span class="cli-sessions-manage-arrow" aria-hidden="true">
                  →
                </span>
              </button>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function resolveUiText(key: string, lang: string): string {
  const zh = lang === "zh";
  const hant = lang === "zh-hant";
  const labels: Record<string, string> = {
    summary: zh ? "账号摘要" : hant ? "帳號摘要" : "Account summary",
    total: zh ? "总数" : hant ? "總數" : "Total",
    healthy: zh ? "正常" : hant ? "正常" : "Healthy",
    attention: zh ? "需关注" : hant ? "需注意" : "Attention",
    lowest: zh ? "最低余额" : hant ? "最低餘額" : "Lowest",
    average: zh ? "平均余额" : hant ? "平均餘額" : "Average",
    search: zh ? "搜索账号…" : hant ? "搜尋帳號…" : "Search accounts…",
    clear: zh ? "清除搜索" : hant ? "清除搜尋" : "Clear search",
    filter: zh ? "筛选" : hant ? "篩選" : "Filter",
    all: zh ? "全部" : hant ? "全部" : "All accounts",
    healthyFilter: zh ? "正常" : "Healthy",
    attentionFilter: zh ? "需关注" : "Attention",
    low: zh ? "低配额" : hant ? "低配額" : "Low quota",
    active: zh ? "当前" : hant ? "目前" : "Current",
    valid: zh ? "有效" : hant ? "有效" : "Valid",
    invalid: zh ? "无效" : hant ? "無效" : "Invalid",
    capable: zh ? "配额内" : hant ? "配額內" : "Within quota",
    incapable: zh ? "超出配额" : hant ? "超出配額" : "Over quota",
    enabled: zh ? "已启用" : hant ? "已啟用" : "Enabled",
    disabled: zh ? "已禁用" : hant ? "已停用" : "Disabled",
    claimed: zh ? "已被占用" : hant ? "已被占用" : "Claimed",
    weeklyShort: zh ? "周配额" : hant ? "週配額" : "Weekly",
    metric: zh ? "主指标" : hant ? "主指標" : "Metric",
    tags: zh ? "标签" : hant ? "標籤" : "Tags",
    clearTagsFilter: zh ? "清除标签筛选" : hant ? "清除標籤篩選" : "Clear tag filter",
    weekly: zh ? "每周配额" : hant ? "每週配額" : "Weekly quota",
    hourly: zh ? "5小时配额" : hant ? "5小時配額" : "5-hour quota",
    review: zh ? "代码审查" : hant ? "程式碼審查" : "Code review",
    view: zh ? "切换视图" : hant ? "切換檢視" : "Toggle view",
    gridView: zh ? "网格视图" : hant ? "網格檢視" : "Grid view",
    tableView: zh ? "表格视图" : hant ? "表格檢視" : "Table view",
    noResults: zh ? "没有匹配的账号" : hant ? "沒有符合的帳號" : "No accounts match your filters"
  };
  if (key === "healthy") return labels["healthy"] ?? "Healthy";
  if (key === "attention") return labels["attention"] ?? "Attention";
  return labels[key] ?? key;
}

function resolveWeeklyQuotaTitle(percent: number | undefined, accountCount: number, lang: string): string {
  if (percent == null) {
    return lang === "zh"
      ? "没有可用的每周配额数据"
      : lang === "zh-hant"
        ? "沒有可用的每週配額資料"
        : "No weekly quota data available";
  }
  if (lang === "zh") return `${accountCount} 个账号的平均每周剩余配额：${percent}%`;
  if (lang === "zh-hant") return `${accountCount} 個帳號的平均每週剩餘配額：${percent}%`;
  return `Average weekly quota remaining across ${accountCount} accounts: ${percent}%`;
}

function resolveSortAriaLabel(lang: string): string {
  return lang === "zh" ? "排序账号" : lang === "zh-hant" ? "排序帳號" : "Sort accounts";
}

function resolveSortOptionLabel(sort: AccountSort, lang: string): string {
  const zh = lang === "zh";
  const hant = lang === "zh-hant";
  if (sort === "auto-queue") return zh ? "自动队列" : hant ? "自動佇列" : "Auto queue";
  if (sort === "quota") return zh ? "配额" : hant ? "配額" : "Quota";
  if (sort === "time-left") return zh ? "剩余时间" : hant ? "剩餘時間" : "Time left";
  if (sort === "login-date") return zh ? "登录日期" : hant ? "登入日期" : "Login date";
  if (sort === "account-type") return zh ? "账号类型" : hant ? "帳號類型" : "Account type";
  if (sort === "subscription-expiry") return zh ? "订阅即将到期" : hant ? "訂閱即將到期" : "Expiring soon";
  if (sort === "email") return zh ? "电子邮箱地址" : hant ? "電子郵件地址" : "Email Address";
  if (sort === "last-refresh") return zh ? "最近刷新" : hant ? "最近重新整理" : "Last refreshed";
  return zh ? "状态" : hant ? "狀態" : "Status";
}

function resolveAboutTitle(lang: string): string {
  if (lang === "zh") {
    return "关于";
  }
  if (lang === "zh-hant") {
    return "關於";
  }
  return "About";
}

render(<App />, document.getElementById("app")!);
