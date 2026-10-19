import { SystemLogConsole } from "./systemLogConsole";
import { useTokenHistoryRefresh } from "./tokenHistoryRefresh";
import { render } from "preact";
import { BrowserNotifications } from "./browserNotifications";
import { createPortal } from "preact/compat";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import packageJson from "../../package.json";
import { emptyWorkspaceTerminalActivity, reduceWorkspaceTerminalActivity } from "../../src/domain/workspaceTerminalActivity";
import type {
  DashboardAccountViewModel,
  DashboardActionName,
  DashboardActionPayload,
  DashboardCliComposerConfig,
  DashboardCodexServerRequest,
  DashboardCodexSessionLiveState,
  DashboardCliSessionMessage,
  DashboardCliSessionSummary,
  DashboardHostMessage,
  DashboardNotice,
  DashboardPeerView,
  DashboardUsageGraphData,
  DashboardWorkspaceEnvironment,
  DashboardWorkspaceFile,
  DashboardWorkspaceFileEntry,
  DashboardWorkspaceTerminalInfo
} from "../../src/domain/dashboard/types";
import { createAutoQueuePolicy, type AutoQueuePolicy } from "../../src/domain/autoQueuePolicy";
import { BatchSelectionBar, OverviewSection, RecoveryPanel } from "./components";
import { isAutomaticRequest, postMessageToHost } from "./host";
import {
  compareDashboardAutoQueueAccounts,
  compareDashboardQuotaBalance,
  filterAccounts,
  hasDashboardQuotaRemaining,
  isDashboardAccountOutOfQuota,
  hasDashboardAutoQueueCapability,
  sortWithQueuedAccount
} from "./accountSorting";
import {
  countAccountEnablement,
  getSensitiveDisplayValue,
  isAccountAttention,
  isAccountClaimedByAnotherDevice,
  normalizeThresholds,
  resolveBrandSubtitle,
  resolveOverviewAccount,
  shouldShowAccountCountFilter
} from "./helpers";
import { useDashboardActions, useDashboardHostSync, useDashboardModals } from "./hooks";
import {
  CodexSessionsIcon,
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
  resolveAccountModalTitle,
  SettingsOverlay,
  ShareTokenModal,
  ApiTokenModal
} from "./panels";
import { SavedAccountCard } from "./savedAccountCard";
import { createInitialState, reducer } from "./state";
import { resolveDashboardThemeFromMedia } from "./theme";
import { createDashboardToastController, scheduleDashboardToastDismiss, type DashboardToast } from "./toast";
import { BrowserActionModal, type BrowserActionRequest } from "./browserActionModal";
import { OnboardingModal, type OnboardingStep } from "./onboardingModal";
import { DonationDetails } from "./donationDetails";
import { ModalShell, useModalAccessibility } from "./primitives";
import { onboardingFailureMessage } from "./onboardingFeedback";
import { classifyCliSessionListResult } from "./cliSessionListResult";
import { formatSessionReadError } from "./actionFeedback";
import { buildCliSessionPath, cliSessionTargetFromLocation, cliSessionTargetKey, sameCliSessionTarget, type CliSessionTarget } from "./cliSessionRoute";
import { canRunAccountOnThisPc } from "./accountRunPolicy";
import { loadUiPreferences, saveUiPreferences, type UiPreferences } from "./preferences";
import { AutoResumeIcon, QueueIcon, formatElapsed, projectDisplayName, type CliSessionFeedback } from "./cliSessionsModal";
import { filterCliSessionsBySection, mergeDashboardPeers } from "../../src/domain/codexSessionState";
import type { CliSubmissionResult } from "./cliSessionComposerState";
import { acceptCliLiveState, combineCliLiveMessages, isCliTurnActive, reconcileCliSessionStatus, reconcileCliSessionStatuses } from "./cliSessionLiveState";
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
import { clampWebviewZoom, nextWebviewZoom } from "./webviewZoom";
import { TaskBoard } from "./taskBoard";

const ACCOUNT_SORT_STORAGE_KEY = "codexManager.dashboardAccountSort.v3";
const USAGE_HISTORY_STORAGE_KEY = "codexManager.dashboardUsageHistory.v1";
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
  return pathname === "/workspace" || Boolean(cliSessionTargetFromLocation(pathname, ""));
}

function hasBrowserWorkspaceShell(pathname: string): boolean {
  return pathname === "/" || pathname === "/tasks" || isCliSessionsPath(pathname);
}

function getCliSessionIdFromPath(pathname: string): string | undefined {
  return cliSessionTargetFromLocation(pathname, "")?.id;
}

function navigateDashboardPath(path: string, setPath: (value: string) => void): void {
  const url = new URL(path, window.location.origin);
  if (window.location.pathname !== url.pathname || window.location.search !== url.search) {
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
  }
  setPath(url.pathname);
}

function replaceDashboardPath(path: string, setPath: (value: string) => void): void {
  const url = new URL(path, window.location.origin);
  if (window.location.pathname !== url.pathname || window.location.search !== url.search) {
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  }
  setPath(url.pathname);
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
  useEffect(() => {
    if (isBrowserDashboard) return;
    const storageKey = "codexManager.webviewZoom.v1";
    const body = document.body;
    let zoom = 1;
    try {
      const stored = Number(window.localStorage.getItem(storageKey));
      if (Number.isFinite(stored)) zoom = clampWebviewZoom(stored);
    } catch {
      // Restricted webviews can disable storage; zoom still works for this session.
    }
    const apply = (value: number) => {
      zoom = clampWebviewZoom(value);
      body.style.zoom = String(zoom);
      try { window.localStorage.setItem(storageKey, String(zoom)); } catch { /* ignore unavailable storage */ }
    };
    apply(zoom);
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      apply(nextWebviewZoom(zoom, event.deltaY));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "0") return;
      event.preventDefault();
      apply(1);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      body.style.zoom = "";
    };
  }, [isBrowserDashboard]);
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [donationOpen, setDonationOpen] = useState(false);
  const [apiTokenOpen, setApiTokenOpen] = useState(false);
  const [apiToken, setApiToken] = useState<string>();
  const [apiTokens, setApiTokens] = useState<import('../../src/domain/dashboard/apiActions').DashboardApiToken[]>([]);
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
  const [shareExportCount, setShareExportCount] = useState(0);
  const [usageGraphData, setUsageGraphData] = useState<DashboardUsageGraphData>();
  const [usageGraphError, setUsageGraphError] = useState<string>();
  const [usageGraphVersion, setUsageGraphVersion] = useState(0);
  const usageGraphRequestRef = useRef<string>();
  const usageGraphSourceRef = useRef<string>();
  const usageGraphDataSourceRef = useRef<string>();
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
  const [agentMessages, setAgentMessages] = useState<Record<string, { messages?: DashboardCliSessionMessage[]; error?: string; loading?: boolean }>>({});
  const messageRequests = useRef(new Map<string, CliSessionTarget>());
  const messageRequestStreams = useRef(new Map<string, string | undefined>());
  const historicalStreams = useRef(new Set<string>());
  const turnRequests = useRef(new Map<string, CliSessionTarget>());
  const sessionActionRequests = useRef(new Map<string, CliSessionTarget>());
  const messageViewRevision = useRef(0);
  const liveSessionListReceived = useRef(false);
  const agentRequests = useRef(new Map<string, string>());
  const [cliSessionMessages, setCliSessionMessages] = useState<DashboardCliSessionMessage[]>([]);
  const [cliLiveStates, setCliLiveStates] = useState<Record<string, DashboardCodexSessionLiveState>>({});
  const cliLiveStatesRef = useRef<Record<string, DashboardCodexSessionLiveState>>({});
  const liveAuthority = useRef(new Set<string>());
  const [submissionResults, setSubmissionResults] = useState<CliSubmissionResult[]>([]);
  const recordSubmissionResult = (requestId: string, status: CliSubmissionResult["status"]) =>
    setSubmissionResults((current) => [...current.filter((result) => result.requestId !== requestId), { requestId, status }].slice(-128));
  const acceptLiveSnapshot = (live: DashboardCodexSessionLiveState, replay = false): void => {
    const key = cliSessionTargetKey({ id: live.sessionId, deviceId: live.deviceId });
    const previous = cliLiveStatesRef.current[key];
    const duplicateReplay = replay && previous?.streamId === live.streamId && previous.sequence === live.sequence && previous.status === live.status;
    if (duplicateReplay || acceptCliLiveState(previous, live)) {
      if (!duplicateReplay) {
        cliLiveStatesRef.current = Object.fromEntries(Object.entries({ ...cliLiveStatesRef.current, [key]: live }).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 30));
        setCliLiveStates(cliLiveStatesRef.current);
      }
      // Realtime snapshots are authoritative for the visible running marker.
      // The session index can lag behind the stream by one refresh tick.
      const patchSession = (session: DashboardCliSessionSummary): DashboardCliSessionSummary =>
        reconcileCliSessionStatus(session, cliLiveStatesRef.current);
      setCliSessions((sessions) => sessions.map(patchSession));
      setSelectedCliSession((session) => session ? patchSession(session) : session);
      liveAuthority.current.add(key);
    } else if (previous?.streamId !== live.streamId && live.updatedAt < (previous?.updatedAt ?? 0)) {
      liveAuthority.current.delete(key);
      setCliLiveStates({ ...cliLiveStatesRef.current });
    }
  };
  const [selectedCliSession, setSelectedCliSession] = useState<DashboardCliSessionSummary>();
  const [selectedPeerId, setSelectedPeerId] = useState<string>("local");
  const [pcPickerOpen, setPcPickerOpen] = useState(false);
  const [cliSessionsMenuOpen, setCliSessionsMenuOpen] = useState(false);
  const [cliSessionsError, setCliSessionsError] = useState<string>();
  const [cliSessionMessagesError, setCliSessionMessagesError] = useState<string>();
  const [cliComposerConfig, setCliComposerConfig] = useState<DashboardCliComposerConfig>();
  const [cliSessionFeedback, setCliSessionFeedback] = useState<CliSessionFeedback>();
  const showCliSessionFeedback = useCallback((feedback: CliSessionFeedback): void => {
    // These updates are already visible in their panel and were causing a
    // stream of stacked toasts while the workspace refreshed in the background.
    if (feedback.message.startsWith("The session action completed, but the session list could not refresh:")) { noticeControllerRef.current?.show(feedback); return; }
    if (feedback.level === "info") return;
    setCliSessionFeedback(feedback);
  }, []);
  const [codexRequests, setCodexRequests] = useState<DashboardCodexServerRequest[]>([]);
  const [codexRequestError, setCodexRequestError] = useState<string>();
  const [workspaceEnvironment, setWorkspaceEnvironment] = useState<DashboardWorkspaceEnvironment>();
  const [terminalActivity, dispatchTerminalActivity] = useReducer(reduceWorkspaceTerminalActivity, emptyWorkspaceTerminalActivity);
  const terminalResults = terminalActivity.results;
  const terminalLiveOutputs = terminalActivity.outputs;
  const terminalEpochs = useRef<Record<string, string>>({});
  const [workspaceTerminals, setWorkspaceTerminals] = useState<DashboardWorkspaceTerminalInfo[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<DashboardWorkspaceFileEntry[]>([]);
  const [workspaceFilesByPath, setWorkspaceFilesByPath] = useState<Record<string, DashboardWorkspaceFile>>({});
  const explicitCliRefreshRef = useRef<string>();
  const selectedCliSessionRef = useRef<DashboardCliSessionSummary>();
  useEffect(() => {
    selectedCliSessionRef.current = selectedCliSession;
  }, [selectedCliSession]);
  const currentSessionTarget = (): CliSessionTarget | undefined => {
    if (!isBrowserDashboard) return selectedCliSessionRef.current;
    const route = cliSessionTargetFromLocation(window.location.pathname, window.location.search);
    if (!route) return undefined;
    return route.deviceId ? route : { ...route, deviceId: selectedCliSessionRef.current?.id === route.id ? selectedCliSessionRef.current.deviceId : undefined };
  };
  const [notice, setNotice] = useState<DashboardToast>();
  const noticeControllerRef = useRef<ReturnType<typeof createDashboardToastController>>();
  noticeControllerRef.current ??= createDashboardToastController(setNotice);
  useEffect(() => () => noticeControllerRef.current?.dispose(), []);
  const lastBrowserPushKeyRef = useRef<string>();
  const browserPushRef = useRef<Notification>();
  const cancelBrowserPushDismissRef = useRef<() => void>();
  const browserPushGenerationRef = useRef(0);
  const closeBrowserPush = useCallback(() => {
    browserPushGenerationRef.current += 1;
    cancelBrowserPushDismissRef.current?.();
    cancelBrowserPushDismissRef.current = undefined;
    browserPushRef.current?.close();
    browserPushRef.current = undefined;
  }, []);
  useEffect(() => {
    window.addEventListener("pagehide", closeBrowserPush);
    return () => {
      window.removeEventListener("pagehide", closeBrowserPush);
      closeBrowserPush();
    };
  }, [closeBrowserPush]);
  const pushBrowserNotification = useCallback(
    (notice: DashboardNotice) => {
      const major = notice.level !== "info" || Boolean(notice.actions?.length);
      if (!isBrowserDashboard || !major || typeof Notification === "undefined" || document.documentElement.dataset["pushSubscribed"] === "true") {
        closeBrowserPush();
        lastBrowserPushKeyRef.current = undefined;
        return;
      }
      const notificationKey = notice.notificationId ?? `${notice.level}:${notice.message}`;
      if (lastBrowserPushKeyRef.current === notificationKey) return;
      closeBrowserPush();
      lastBrowserPushKeyRef.current = notificationKey;
      const generation = browserPushGenerationRef.current;
      const show = () => {
        if (browserPushGenerationRef.current !== generation || Notification.permission !== "granted") return;
        try {
          const notification = new Notification("Codex Manager", {
            body: notice.message,
            tag: `codex-manager-${notice.notificationId ?? notice.level}`
          });
          browserPushRef.current = notification;
          cancelBrowserPushDismissRef.current = scheduleDashboardToastDismiss(() => {
            if (browserPushRef.current !== notification) return;
            notification.close();
            browserPushRef.current = undefined;
            cancelBrowserPushDismissRef.current = undefined;
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
      // Notification permission is requested only by the explicit settings control.
    },
    [closeBrowserPush, isBrowserDashboard]
  );
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const logDownloadRequestRef = useRef<string>();
  const logConsoleRequestRef = useRef<string>();
  const browserDownloadsRef = useRef(new Set<string>());
  const [logConsoleOpen, setLogConsoleOpen] = useState(false);
  const [logConsoleRecords, setLogConsoleRecords] = useState<unknown[]>([]);
  const [logConsoleError, setLogConsoleError] = useState<string>();
  const [logConsoleLimited, setLogConsoleLimited] = useState(false);

  const [browserHostStage, setBrowserHostStage] = useState<Extract<DashboardHostMessage, { type: "dashboard:host-status" }>["stage"]>("connecting");
  const [browserLastSyncAt, setBrowserLastSyncAt] = useState<number>();
  const showNotice = useCallback(
    (next: DashboardNotice) => {
      if (next.level === "info") return;
      noticeControllerRef.current?.show(next);
      pushBrowserNotification(next);
    },
    [pushBrowserNotification]
  );
  const lastTerminalNoticeAtRef = useRef<number>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const handleActionTimeout = useCallback(
    (action: DashboardActionName, requestId: string) => {
      sessionActionRequests.current.delete(requestId);
      if (action === "viewLogs" && logConsoleRequestRef.current === requestId) {
        logConsoleRequestRef.current = undefined;
        setLogConsoleError("Logs timed out. Saved records are still shown; retrying automatically.");
      }
      if (action === "getDailyUsage") tokenHistoryRefresh.finish(requestId, false, "Token refresh timed out. Saved history was kept; verify before retrying.");
      if (action === "getCodexCliSessionMessages") {
        const target = messageRequests.current.get(requestId);
        messageRequests.current.delete(requestId);
        if (sameCliSessionTarget(target, currentSessionTarget())) setCliSessionMessagesError("Messages did not refresh in time. Try Refresh conversation.");
      }
      if (action === "getCodexSubAgentMessages") {
        const id = agentRequests.current.get(requestId);
        agentRequests.current.delete(requestId);
        if (id) setAgentMessages((current) => ({ ...current, [id]: { ...current[id], loading: false, error: "Agent messages timed out. Try Refresh." } }));
      }
      if (action === "listCodexCliSessions") setCliSessionsError("Sessions did not refresh in time. Try again.");
      if (action === "listCodexCliSessions" && explicitCliRefreshRef.current === requestId) {
        explicitCliRefreshRef.current = undefined;
        showCliSessionFeedback({
          key: Date.now(),
          level: "warning",
          message: "Refreshing sessions did not finish in time. Try again."
        });
      }
      if (action === "startCodexCliSession" || action === "sendCodexCliSessionMessage" || action === "steerCodexCliSessionTurn") {
        recordSubmissionResult(requestId, "failed");
        turnRequests.current.delete(requestId);
        showCliSessionFeedback({
          key: Date.now(),
          level: "warning",
          message: action === "startCodexCliSession"
            ? "Starting the Codex session timed out. Refresh sessions before trying again."
            : "The request timed out and may still be running. Your draft is saved. Refresh this session before deciding whether to send it again."
        });
      }
      if (action === "getUsageGraph" && usageGraphRequestRef.current === requestId) {
        usageGraphRequestRef.current = undefined;
        setUsageGraphError("Loading saved graph data timed out. Retry to query the database again.");
      }
      if (!onboardingOpen) return;
      const isPendingStep = onboardingPendingRef.current.has(action);
      const isImportStep = onboardingStep === "import" && onboardingBusy && action === "importCurrent";
      if (!isPendingStep && !isImportStep) return;
      onboardingPendingRef.current.delete(action);
      setOnboardingBusy(false);
      setOnboardingError(onboardingFailureMessage(action, "timed-out"));
    },
    [onboardingBusy, onboardingOpen, onboardingStep]
  );
  const { patchSettings, sendAction, sendSetting, isActionPending } = useDashboardActions(
    state,
    dispatch,
    showNotice,
    selectedPeerId,
    handleActionTimeout,
    !isBrowserDashboard || realtimeConnected
  );
  useEffect(() => { if (apiTokenOpen) sendAction('listApiTokens', undefined, { targetDeviceId: undefined }); }, [apiTokenOpen]);
  const openExternalLink = useCallback((url: string): void => {
    if (!isBrowserDashboard) {
      sendAction("openExternalUrl", undefined, { url });
      return;
    }
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) showNotice({ level: "warning", message: "The browser blocked this link. Allow pop-ups for this dashboard and try again." });
  }, [isBrowserDashboard, sendAction, showNotice]);
  const tokenHistoryRefresh = useTokenHistoryRefresh(sendAction, selectedPeerId, state.snapshot?.settings.dailyTokenUsageEnabled === true);
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
  const refreshLogConsole = useCallback(() => {
    if (logConsoleRequestRef.current) return;
    logConsoleRequestRef.current = sendAction("viewLogs", undefined, { automatic: true });
  }, [sendAction]);
  useEffect(() => {
    if (!logConsoleOpen) return;
    refreshLogConsole();
    const timer = setInterval(refreshLogConsole, 2_000);
    return () => { clearInterval(timer); logConsoleRequestRef.current = undefined; };
  }, [logConsoleOpen, refreshLogConsole]);
  useEffect(() => {
    setLogConsoleRecords([]); setLogConsoleError(undefined); setLogConsoleLimited(false);
    logConsoleRequestRef.current = undefined;
  }, [selectedPeerId, snapshot?.settings.persistentLoggingEnabled]);

  const lastCliListRequestAtRef = useRef(0);
  const lastCliRealtimeRevisionRef = useRef(0);
  const lastCliMessageRequestRef = useRef<{ target: CliSessionTarget; at: number }>();
  const cliSessionsRef = useRef(cliSessions);
  cliSessionsRef.current = cliSessions;
  const connectedPeers = mergeDashboardPeers(snapshot?.connectedPeers ?? [], cliSessions);
  const pcOptions = connectedPeers.length > 0 ? connectedPeers : [{ id: "local", name: "This PC", sessionCount: 0, connected: true, local: true }];
  const selectedPeer = pcOptions.find((peer) => peer.id === selectedPeerId) ?? pcOptions.find((peer) => peer.local) ?? pcOptions[0];
  const workspaceTargetDeviceId = selectedCliSession ? selectedCliSession.deviceId : selectedPeer?.local ? undefined : selectedPeer?.id;
  const requestSessionAction = (action: DashboardActionName, session: CliSessionTarget, payload?: DashboardActionPayload): void => {
    const requestId = sendAction(action, undefined, { ...payload, sessionId: session.id, targetDeviceId: session.deviceId });
    if (requestId) sessionActionRequests.current.set(requestId, session);
  };
  const requestCliSessions = useCallback(
    (force = false, userInitiated = false): string | undefined => {
      const now = Date.now();
      if (!force && now - lastCliListRequestAtRef.current < 2_000) return;
      lastCliListRequestAtRef.current = now;
      return sendAction("listCodexCliSessions", undefined, { automatic: !userInitiated, targetDeviceId: undefined });
    },
    [sendAction]
  );
  const requestCliSessionMessages = useCallback(
    (sessionId: string, targetDeviceId?: string, force = false, automatic = true): void => {
      const target = { id: sessionId, deviceId: targetDeviceId };
      if ([...messageRequests.current.values()].some((pending) => sameCliSessionTarget(pending, target))) return;
      const now = Date.now();
      const previous = lastCliMessageRequestRef.current;
      if (!force && sameCliSessionTarget(previous?.target, target) && previous && now - previous.at < 2_000) return;
      lastCliMessageRequestRef.current = { target, at: now };
      const projectPath = cliSessionsRef.current.find((session) => sameCliSessionTarget(session, target))?.projectPath;
      const requestId = sendAction("getCodexCliSessionMessages", undefined, { sessionId, targetDeviceId, projectPath, automatic });
      if (requestId) {
        messageRequests.current.set(requestId, target);
        messageRequestStreams.current.set(requestId, cliLiveStatesRef.current[cliSessionTargetKey(target)]?.streamId);
      }
    },
    [sendAction]
  );
  const requestWorkspaceEnvironment = useCallback(
    (projectPath?: string, includeBranchDiff?: boolean, automatic = false): void => {
      sendAction("getWorkspaceEnvironment", undefined, { sessionId: selectedCliSession?.id, projectPath: projectPath ?? selectedCliSession?.projectPath, includeBranchDiff, automatic, targetDeviceId: workspaceTargetDeviceId });
    },
    [sendAction, workspaceTargetDeviceId, selectedCliSession?.id, selectedCliSession?.projectPath]
  );
  const requestWorkspaceTerminals = useCallback((): void => {
    sendAction("listWorkspaceTerminals", undefined, { targetDeviceId: workspaceTargetDeviceId });
  }, [sendAction, workspaceTargetDeviceId]);
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
      if (message.type === "dashboard:snapshot") {
        dashboardCacheHydratedRef.current = true;
        if (isBrowserDashboard) setBrowserLastSyncAt(Date.now());
      }
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
            setOnboardingError(onboardingFailureMessage(onboardingAction, message.status, message.error));
          }
        }
        if (onboardingAction === "inspectCurrentAuth" && message.status === "completed") {
          setCurrentAuthEmail(message.payload?.currentAuthEmail);
          setCurrentAuthAlreadyAdded(message.payload?.currentAuthAlreadyAdded === true);
        }
        if (onboardingPendingRef.current.has(onboardingAction)) {
          if (message.status !== "completed") {
            onboardingPendingRef.current.clear();
            setOnboardingBusy(false);
            setOnboardingError(onboardingFailureMessage(onboardingAction, message.status, message.error));
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
          } else {
            setOnboardingBusy(false);
            setOnboardingError(onboardingFailureMessage(onboardingAction, message.status, message.error));
          }
        }
      }
      if (message.type === "dashboard:connection") {
        setRealtimeConnected(message.connected);
        if (!message.connected) {
          liveAuthority.current.clear();
          if ([...messageRequests.current.values()].some((target) => sameCliSessionTarget(target, currentSessionTarget()))) {
            setCliSessionMessagesError("Connection lost while loading messages. Reconnecting; use Refresh conversation if needed.");
          }
          messageRequests.current.clear();
          messageRequestStreams.current.clear();
          agentRequests.current.clear();
          setAgentMessages((current) => Object.fromEntries(Object.entries(current).map(([id, value]) => [id, value.loading ? { ...value, loading: false, error: "Connection lost while loading agent messages. Reconnecting; use Refresh if needed." } : value])));
        }
        return;
      }
      if (message.type === "dashboard:codex-session-live") {
        acceptLiveSnapshot(message.state);
        if (!isCliTurnActive(message.state) && sameCliSessionTarget({ id: message.state.sessionId, deviceId: message.state.deviceId }, currentSessionTarget()))
          requestCliSessionMessages(message.state.sessionId, message.state.deviceId, true);
        return;
      }
      if (message.type === "dashboard:host-status") {
        setBrowserHostStage(message.stage);
        if (message.lastSyncAt) setBrowserLastSyncAt(message.lastSyncAt);
        return;
      }
      if (message.type === "dashboard:codex-request") {
        setCodexRequests((current) => current.some((request) => request.id === message.request.id && request.deviceId === message.request.deviceId)
          ? current : [...current, message.request]);
        setCodexRequestError(undefined);
        return;
      }
      if (message.type === "dashboard:codex-request-resolved") {
        setCodexRequests((current) => current.filter((request) => request.id !== message.requestId || request.deviceId !== message.deviceId));
        setCodexRequestError(undefined);
        return;
      }
      if (message.type === "dashboard:action-result" && message.action === "respondCodexServerRequest") {
        setCodexRequestError(message.status === "completed" ? undefined : (message.error ?? "Codex could not receive this response. Try again or refresh the session."));
        if (message.status !== "completed") showCliSessionFeedback({ key: Date.now(), level: "error", message: message.error ?? "Codex could not receive this response. Try again or refresh the session." });
      }
      if (message.type === "dashboard:action-result" && ["generateApiToken", "listApiTokens", "revokeApiToken"].includes(message.action)) {
        if (message.payload?.apiTokens) setApiTokens(message.payload.apiTokens);
        if (message.status === 'completed' && message.action === 'revokeApiToken') setApiToken(undefined);
        if (message.action === 'revokeApiToken' && message.status === 'completed') setApiToken(undefined);
      }
      if (message.type === "dashboard:action-result" && message.action === "generateApiToken") {
        if (message.status === "completed" && message.payload?.apiToken) {
          setApiToken(message.payload.apiToken);
          setApiTokenOpen(true);
        } else if (message.status !== "completed") showNotice({ level: "error", message: message.error ?? "API token could not be generated." });
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
      if (actionPrompt?.kind === "disabledActiveAccount") {
        setBrowserActionRequest({
          kind: "disabledActiveAccount",
          accountId: actionPrompt.accountId,
          title: "Current account disabled",
          message: actionPrompt.message,
          unloadLabel: actionPrompt.unloadLabel,
          keepUsingLabel: actionPrompt.keepUsingLabel
        });
      }
      if (
        isBrowserDashboard &&
        message.type === "dashboard:action-result" &&
        (message.action === "switch" || message.action === "importCurrent") &&
        message.status === "completed" &&
        message.payload?.reloadRequired &&
        message.payload.reloadAccountId &&
        !state.snapshot?.settings.autoSwitchReloadWindowEnabled
      ) {
        const switchedAccount = state.snapshot?.accounts.find(
          (account) => account.id === message.payload?.reloadAccountId
        );
        setBrowserActionRequest({
          kind: "confirm",
          action: "reloadPrompt",
          accountId: message.payload.reloadAccountId,
          title: "Reload VS Code",
          message: `${message.action === "switch" ? "The account was switched" : "The current account was imported"}${switchedAccount ? ` (${getSensitiveDisplayValue(switchedAccount.email, state.privacyMode, "email")})` : ""}. Reload the VS Code extension host now to apply it to this window?`,
          confirmLabel: "Reload"
        });
      }
      if (message.type === "dashboard:action-result" && message.action === "getUsageGraph" && message.requestId === usageGraphRequestRef.current) {
        usageGraphRequestRef.current = undefined;
        if (message.status === "completed" && message.payload?.usageGraph) {
          usageGraphDataSourceRef.current = usageGraphSourceRef.current;
          setUsageGraphData(message.payload.usageGraph);
          setUsageGraphError(undefined);
        } else setUsageGraphError(message.error ?? "Saved graph data could not be loaded. Retry to query the database again.");
      }
      if (message.type === "dashboard:action-result" && message.action === "viewLogs" && message.requestId === logConsoleRequestRef.current) {
        logConsoleRequestRef.current = undefined;
        if (message.status === "completed" && message.payload?.logDownload) {
          try {
            const parsed = JSON.parse(message.payload.logDownload.text) as { records?: unknown[]; limited?: boolean };
            if (!Array.isArray(parsed.records)) throw new Error("Missing log records");
            setLogConsoleRecords(parsed.records);
            setLogConsoleLimited(parsed.limited === true);
            setLogConsoleError(undefined);
          } catch { setLogConsoleError("The log response was unreadable. Retry refresh."); }
        } else setLogConsoleError(message.error ?? "No logs were returned. Retry refresh.");
      }
      if (message.type === "dashboard:action-result" && message.action === "clearLogs") {
        if (message.status === "completed") { logConsoleRequestRef.current = undefined; setLogConsoleRecords([]); setLogConsoleError(undefined); refreshLogConsole(); }
        else setLogConsoleError(message.error ?? "System log could not be cleared. Retry when storage is available.");
      }
      if (message.type === "dashboard:action-result" && message.action === "downloadJsonFile" && message.status === "completed" && message.payload?.fileDownload && isBrowserDashboard) {
        if (browserDownloadsRef.current.has(message.requestId)) return;
        browserDownloadsRef.current.add(message.requestId);
        if (browserDownloadsRef.current.size > 64) browserDownloadsRef.current.delete(browserDownloadsRef.current.values().next().value!);
        try { downloadInBrowser(message.payload.fileDownload); }
        catch { showNotice({ level: "error", message: "Download could not start. Retry in this browser." }); }
      }
      if (message.type === "dashboard:action-result" && message.action === "downloadLogs" && message.requestId === logDownloadRequestRef.current) {
        logDownloadRequestRef.current = undefined;
        if (message.status === "completed" && message.payload?.logDownload) {
          try {
            downloadInBrowser(message.payload.logDownload);
          } catch {
            showNotice({ level: "error", message: "Log download could not start. Retry in this browser." });
          }
        } else if (message.status === "completed" && isBrowserDashboard) {
          showNotice({ level: "warning", message: "The host returned no log download. Update the host and retry." });
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "getDailyUsage" && message.accountId) {
        tokenHistoryRefresh.finish(message.requestId, message.status === "completed" && Boolean(message.payload?.dailyUsage), message.error ?? (message.status === "cancelled" ? "Refresh cancelled. Saved history was kept." : "No token history was returned. Saved history was kept."));
        if (message.status === "completed" && message.payload?.dailyUsage) {
          setUsageGraphVersion(current => current + 1);
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "listCodexCliSessions") {
        const realtimeRevision = message.payload?.realtimeRevision;
        const result = classifyCliSessionListResult(
          message.requestId,
          realtimeRevision,
          lastCliRealtimeRevisionRef.current,
          explicitCliRefreshRef.current
        );
        if (!result.apply && !result.explicitRefresh) return;
        lastCliRealtimeRevisionRef.current = result.nextRealtimeRevision;
        const explicitRefresh = result.explicitRefresh;
        if (explicitRefresh) explicitCliRefreshRef.current = undefined;
        if (message.status === "completed") {
          if (result.apply) {
            liveSessionListReceived.current = true;
            const sessions = mergeCachedCliSessions(message.payload?.cliSessions ?? [], cliSessions);
            setCliSessions(reconcileCliSessionStatuses(sessions, cliLiveStatesRef.current));
            // Realtime list pushes intentionally omit the heavier composer
            // catalog. Preserve the last known catalog so the response box does
            // not disappear while sessions update in the background.
            setCliComposerConfig(message.payload?.cliComposerConfig ?? cliComposerConfig);
            void writeCliSessionListCache({ sessions, composerConfig: message.payload?.cliComposerConfig });
            if (explicitRefresh || !message.payload?.cliSessions?.some(session => session.status === "unknown"))
              setCliSessionsError(message.payload?.cliSessions?.some(session => session.status === "unknown") ? message.payload?.notice?.message ?? "Session running state could not be verified. Refresh before sending." : undefined);
            const routeId = getCliSessionIdFromPath(window.location.pathname);
            if (routeId) {
              const routeDevice = new URLSearchParams(window.location.search).get("device");
              const routeSession = sessions.find((session) => session.id === routeId && (routeDevice ? session.deviceId === routeDevice : !session.remote));
              if (routeSession?.archived) {
                setSelectedCliSession(reconcileCliSessionStatus(routeSession, cliLiveStatesRef.current));
                setCliSessionMessages([]);
                showCliSessionFeedback({
                  key: Date.now(),
                  level: "warning",
                  message: "This session is archived. Restore it below to continue the conversation."
                });
              } else if (routeSession) {
                if (new URLSearchParams(window.location.search).has("project")) replaceDashboardPath(buildCliSessionPath(routeSession), setBrowserPath);
                const previousRouteSession =
                  sameCliSessionTarget(selectedCliSessionRef.current, routeSession) ? selectedCliSessionRef.current : undefined;
                const sessionChanged =
                  !previousRouteSession ||
                  previousRouteSession.updatedAt !== routeSession.updatedAt ||
                  previousRouteSession.status !== routeSession.status ||
                  previousRouteSession.projectPath !== routeSession.projectPath ||
                  previousRouteSession.runningBy !== routeSession.runningBy ||
                  previousRouteSession.canStop !== routeSession.canStop;
                setSelectedCliSession(reconcileCliSessionStatus(routeSession, cliLiveStatesRef.current));
                // A running turn appends activity events to its transcript while
                // the session index can keep the same updatedAt. Refresh the
                // selected transcript on every realtime tick so commands and
                // reasoning appear as they happen instead of only showing the
                // generic Working indicator until the turn exits.
                if (typeof realtimeRevision !== "number" || sessionChanged || routeSession.status === "running") {
                  requestCliSessionMessages(routeId, routeSession.deviceId, typeof realtimeRevision !== "number");
                }
              } else {
                // The refreshed index is authoritative. Do not request a route
                // that is already gone; that only turns a stale link into a
                // noisy “session not found” error.
                navigateDashboardPath("/workspace", setBrowserPath);
                messageViewRevision.current++;
                selectedCliSessionRef.current = undefined;
                setSelectedCliSession(undefined);
                setCliSessionMessages([]);
                setCliSessionMessagesError(undefined);
              }
            }
          }
          if (explicitRefresh)
            showCliSessionFeedback({ key: Date.now(), ...(message.payload?.notice ?? { level: "info" as const, message: "Sessions refreshed." }) });
        } else {
          setCliSessionsError(message.error ?? "Sessions could not be loaded.");
          if (explicitRefresh)
            showCliSessionFeedback({
              key: Date.now(),
              level: "error",
              message: message.error ?? "Sessions could not be refreshed."
            });
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "getCodexSubAgentMessages") {
        const id = agentRequests.current.get(message.requestId);
        if (id) {
          agentRequests.current.delete(message.requestId);
          setAgentMessages((current) => ({ ...current, [id]: message.status === "completed"
            ? { messages: message.payload?.cliSubAgentMessages ?? [] }
            : { ...current[id], loading: false, error: message.error ?? "Agent messages could not be loaded. Try Refresh." } }));
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "getCodexCliSessionMessages") {
        const requestedTarget = messageRequests.current.get(message.requestId);
        const requestedStream = messageRequestStreams.current.get(message.requestId);
        messageRequestStreams.current.delete(message.requestId);
        messageRequests.current.delete(message.requestId);
        if (!sameCliSessionTarget(requestedTarget, currentSessionTarget())) return;
        messageViewRevision.current++;
        if (message.status === "completed") {
          if (message.payload?.cliSessionLive) {
            acceptLiveSnapshot(message.payload.cliSessionLive, true);
            if (!isCliTurnActive(message.payload.cliSessionLive)) {
              historicalStreams.current.add(message.payload.cliSessionLive.streamId);
              if (historicalStreams.current.size > 60) historicalStreams.current.delete(historicalStreams.current.values().next().value!);
            }
          }
          else if (requestedTarget) {
            const key = cliSessionTargetKey(requestedTarget);
            if (cliLiveStatesRef.current[key]?.streamId === requestedStream) {
              const previousLive = cliLiveStatesRef.current[key];
              if (previousLive && ["completed", "cancelled", "failed"].includes(previousLive.status)) {
                // Keep the bounded terminal snapshot as an ordering guard. A
                // history refresh must not let delayed running events revive it.
                historicalStreams.current.add(previousLive.streamId);
                if (historicalStreams.current.size > 60) historicalStreams.current.delete(historicalStreams.current.values().next().value!);
                liveAuthority.current.add(key);
              } else {
                liveAuthority.current.delete(key);
                const { [key]: removed, ...remaining } = cliLiveStatesRef.current;
                void removed;
                cliLiveStatesRef.current = remaining;
                setCliLiveStates(remaining);
              }
            }
          }
          setCliSessionMessages(message.payload?.cliSessionMessages ?? []);
          if (message.payload?.cliSession?.id)
            void writeCliSessionMessagesCache(message.payload.cliSession.id, message.payload?.cliSessionMessages ?? [], requestedTarget?.deviceId);
          setSelectedCliSession(
            message.payload?.cliSession
              ? reconcileCliSessionStatus(mergeCachedCliSession(message.payload.cliSession, selectedCliSession), cliLiveStatesRef.current)
              : selectedCliSession
          );
          setCliSessionMessagesError(undefined);
        } else {
          const error = message.error ?? "Session messages could not be loaded.";
          if (/archived sessions cannot be opened/i.test(error)) {
            const routeId = getCliSessionIdFromPath(window.location.pathname);
            const routeSession = routeId ? cliSessions.find((session) => session.id === routeId) : undefined;
            if (routeSession) setSelectedCliSession(reconcileCliSessionStatus(routeSession, cliLiveStatesRef.current));
            setCliSessionMessages([]);
            setCliSessionMessagesError(undefined);
            showCliSessionFeedback({
              key: Date.now(),
              level: "warning",
              message: "This session is archived. Restore it below to continue the conversation."
            });
          } else {
            setCliSessionMessagesError(formatSessionReadError(message.action, error));
          }
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "sendCodexCliSessionMessage") {
        recordSubmissionResult(message.requestId, message.status === "completed" && !message.payload?.cliSession ? "failed" : message.status);
        if (message.payload?.cliSessionLive) acceptLiveSnapshot(message.payload.cliSessionLive, true);
        const target = turnRequests.current.get(message.requestId);
        turnRequests.current.delete(message.requestId);
        if (!target) return;
        if (message.status === "completed" && !message.payload?.cliSession) {
          showCliSessionFeedback({ key: Date.now(), level: "warning", message: "The send response was incomplete. Your draft is saved; refresh the original conversation before sending again." });
          if (sameCliSessionTarget(target, currentSessionTarget())) requestCliSessionMessages(target.id, target.deviceId, true);
          return;
        }
        if (!sameCliSessionTarget(target, currentSessionTarget())) {
          if (message.status === "completed") {
            if (message.payload?.cliSessions) setCliSessions((current) => reconcileCliSessionStatuses(mergeCachedCliSessions(message.payload!.cliSessions!, current), cliLiveStatesRef.current));
            if (message.payload?.cliSessionMessages) void writeCliSessionMessagesCache(target.id, message.payload.cliSessionMessages, target.deviceId);
          }
          showCliSessionFeedback({ key: Date.now(), level: message.status === "completed" ? "info" : message.status === "cancelled" ? "warning" : "error", message: message.status === "completed" ? "Codex completed the turn in the original chat." : message.error ?? "The turn in the original chat did not complete. Return to that chat and retry." });
          return;
        }
        messageViewRevision.current++;
        if (message.status === "completed") {
          const sessions = mergeCachedCliSessions(message.payload?.cliSessions ?? cliSessions, cliSessions);
          setCliSessions(reconcileCliSessionStatuses(sessions, cliLiveStatesRef.current));
          setCliSessionMessages(message.payload?.cliSessionMessages ?? cliSessionMessages);
          if (message.payload?.cliSession?.id) {
            if (message.payload.cliSessionMessages) void writeCliSessionMessagesCache(message.payload.cliSession.id, message.payload.cliSessionMessages, target.deviceId);
            void writeCliSessionListCache({
              sessions,
              composerConfig: cliComposerConfig
            });
          }
          setSelectedCliSession(
            message.payload?.cliSession
              ? reconcileCliSessionStatus(mergeCachedCliSession(message.payload.cliSession, selectedCliSession), cliLiveStatesRef.current)
              : selectedCliSession
          );
          setCliSessionMessagesError(undefined);
          showCliSessionFeedback({ key: Date.now(), ...(message.payload?.notice ?? { level: "info" as const, message: "Codex completed the turn." }) });
        } else {
          const level = message.status === "cancelled" ? "warning" : "error";
          showCliSessionFeedback({
            key: Date.now(),
            level,
            message: message.error ?? "Codex could not complete the turn."
          });
          if (selectedCliSession) requestCliSessionMessages(selectedCliSession.id, selectedCliSession.deviceId, true);
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "startCodexCliSession") {
        recordSubmissionResult(message.requestId, message.status === "completed" && !message.payload?.cliSession ? "failed" : message.status);
        if (message.payload?.cliSessionLive) acceptLiveSnapshot(message.payload.cliSessionLive, true);
        if (message.status === "completed" && message.payload?.cliSession) {
          const session = message.payload.cliSession;
          const sessions = mergeCachedCliSessions([session, ...(message.payload.cliSessions ?? cliSessions).filter((candidate) => !sameCliSessionTarget(candidate, session))], cliSessions);
          setCliSessions(reconcileCliSessionStatuses(sessions, cliLiveStatesRef.current));
          setCliComposerConfig(message.payload.cliComposerConfig ?? cliComposerConfig);
          if (selectedCliSession && !sameCliSessionTarget(selectedCliSession, session)) {
            showCliSessionFeedback({ key: Date.now(), level: "info", message: "New Codex chat is ready. Open it from the session list." });
            return;
          }
          messageViewRevision.current++;
          selectedCliSessionRef.current = session;
          setSelectedCliSession(reconcileCliSessionStatus(mergeCachedCliSession(session, selectedCliSession), cliLiveStatesRef.current));
          const initialMessages = message.payload.cliSessionMessages ?? [];
          setCliSessionMessages(initialMessages);
          setCliSessionMessagesError(undefined);
          if (!initialMessages.length) requestCliSessionMessages(session.id, session.deviceId, true);
          navigateDashboardPath(buildCliSessionPath(session), setBrowserPath);
          showCliSessionFeedback({
            key: Date.now(),
            level: "info",
            message: message.payload.notice?.message ?? "New Codex chat is ready."
          });
        } else {
          showCliSessionFeedback({
            key: Date.now(),
            level: "error",
            message: message.error ?? "New Codex chat could not be started."
          });
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "steerCodexCliSessionTurn") {
        recordSubmissionResult(message.requestId, message.status);
        if (message.payload?.cliSessionLive) acceptLiveSnapshot(message.payload.cliSessionLive, true);
        showCliSessionFeedback({ key: Date.now(), level: message.status === "completed" ? "info" : message.status === "cancelled" ? "warning" : "error", message: message.payload?.notice?.message ?? message.error ?? (message.status === "completed" ? "Follow-up sent to the running turn." : "Follow-up could not be confirmed. Your draft is saved; refresh before trying again.") });
      }
      if (message.type === "dashboard:action-result" && message.action === "cancelCodexCliSessionTurn") {
        showCliSessionFeedback({
          key: Date.now(),
          level: message.status === "completed" ? "warning" : "error",
          message:
            message.status === "completed"
              ? (message.payload?.notice?.message ?? "Stop requested. Waiting for Codex to end the turn.")
              : (message.error ?? "The turn could not be stopped.")
        });
      }
      if (
        message.type === "dashboard:action-result" &&
        ["getWorkspaceEnvironment", "commitWorkspaceChanges", "pushWorkspaceBranch"].includes(message.action)
      ) {
        if (message.status === "completed") {
          if (message.payload?.workspaceEnvironment) setWorkspaceEnvironment(message.payload.workspaceEnvironment);
          if (message.action !== "getWorkspaceEnvironment") {
            showCliSessionFeedback({
              key: Date.now(),
              level: "info",
              message: message.payload?.notice?.message ?? "Environment action completed."
            });
          }
        } else if (message.status === "failed" && !isAutomaticRequest(message.requestId)) {
          showCliSessionFeedback({
            key: Date.now(),
            level: "error",
            message: message.error ?? "The workspace environment action failed."
          });
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "runWorkspaceTerminalCommand") {
        if (message.payload?.terminalResult && message.payload.terminalResult.status !== "running") {
          const completed = message.payload.terminalResult;
          dispatchTerminalActivity({ result: completed });
        }
        showCliSessionFeedback({
          key: Date.now(),
          level: message.status === "completed" ? (message.payload?.terminalResult?.status === "untracked" ? "warning" : "info") : message.status === "cancelled" ? "warning" : "error",
          message:
          message.status === "completed"
              ? (message.payload?.notice?.message ?? "Terminal command completed.")
              : (message.error ?? "Terminal command failed.")
        });
        requestWorkspaceEnvironment(selectedCliSession?.projectPath, undefined, true);
        requestWorkspaceTerminals();
      }
      if (message.type === "dashboard:terminal-output") {
        dispatchTerminalActivity({ output: message.output });
      }
      if (message.type === "dashboard:terminal-complete") {
        dispatchTerminalActivity({ result: message.result });
      }
      if (
        message.type === "dashboard:action-result" &&
        ["listWorkspaceTerminals", "createWorkspaceTerminal", "focusWorkspaceTerminal"].includes(message.action)
      ) {
        if (message.status === "completed") {
          const epoch = message.payload?.terminalActivityEpoch;
          if (epoch) {
            const device = message.payload?.terminalActivityDeviceId ?? "local";
            const previous = terminalEpochs.current[device];
            if (previous && previous !== epoch) dispatchTerminalActivity({ resetDevice: device });
            terminalEpochs.current[device] = epoch;
          }
          for (const result of message.payload?.terminalResults ?? []) dispatchTerminalActivity({ result });
          for (const output of message.payload?.terminalLiveOutputs ?? []) dispatchTerminalActivity({ output, replay: true });
          const terminals = message.payload?.workspaceTerminals ?? [];
          const selected = message.payload?.workspaceTerminal;
          // VS Code reports activeTerminal asynchronously. Keep the acknowledged
          // target selected so the next command reaches the terminal the user chose.
          setWorkspaceTerminals(selected
            ? [...terminals.filter(terminal => terminal.id !== selected.id).map(terminal => ({ ...terminal, isActive: false })), { ...selected, isActive: true }]
            : terminals);
          if (message.action !== "listWorkspaceTerminals") {
            showCliSessionFeedback({
              key: Date.now(),
              level: "info",
              message: message.payload?.notice?.message ?? "Terminal action completed."
            });
          }
        } else {
          showCliSessionFeedback({
            key: Date.now(),
            level: "error",
            message: message.error ?? "Terminal action failed."
          });
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "listWorkspaceFiles") {
        if (message.status === "completed") setWorkspaceFiles(message.payload?.workspaceFiles ?? []);
        else
          showCliSessionFeedback({
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
          showCliSessionFeedback({
            key: Date.now(),
            level: "info",
            message: message.payload?.notice?.message ?? "File deleted."
          });
          requestWorkspaceEnvironment(selectedCliSession?.projectPath, undefined, true);
        } else
          showCliSessionFeedback({
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
            showCliSessionFeedback({
              key: Date.now(),
              level: "info",
              message: message.payload.notice?.message ?? "File saved."
            });
            requestWorkspaceEnvironment(selectedCliSession?.projectPath, undefined, true);
          }
        } else if (message.status === "failed") {
          showCliSessionFeedback({
            key: Date.now(),
            level: "error",
            message: message.error ?? "The project file action failed."
          });
        }
      }
      if (message.type === "dashboard:action-result" && message.action === "cancelWorkspaceTerminalCommand") {
        showCliSessionFeedback({
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
          "openNewCodexWebview",
          "resumeCodexSessions",
          "setCodexSessionGoalStatus",
          "setCodexSessionAutoResume",
          "setCodexSessionQueue",
          "openCodexCliSession",
          "renameCodexCliSession",
          "forkCodexCliSession",
          "archiveCodexCliSession",
          "unarchiveCodexCliSession",
          "deleteCodexCliSession"
        ].includes(message.action)
      ) {
        const target = sessionActionRequests.current.get(message.requestId);
        sessionActionRequests.current.delete(message.requestId);
        const applyToCurrentChat = sameCliSessionTarget(target, currentSessionTarget());
        showCliSessionFeedback({
          key: Date.now(),
          level: message.status === "completed" ? message.payload?.notice?.level ?? "info" : message.status === "cancelled" ? "warning" : "error",
          message:
            message.status === "completed"
              ? (message.payload?.notice?.message ?? "Session action completed.")
              : (message.error ?? "The session action failed.")
        });
        if (message.status === "completed" && message.payload?.cliSessions) {
          const sessions = mergeCachedCliSessions(message.payload.cliSessions, cliSessions);
          setCliSessions(reconcileCliSessionStatuses(sessions, cliLiveStatesRef.current));
          void writeCliSessionListCache({ sessions, composerConfig: cliComposerConfig });
        }
        if (message.status === "completed" && !message.payload?.cliSessions && target) {
          setCliSessions((current) => {
            if (message.action === "deleteCodexCliSession") return current.filter((session) => !sameCliSessionTarget(session, target));
            if (message.action === "archiveCodexCliSession" || message.action === "unarchiveCodexCliSession")
              return current.map((session) => sameCliSessionTarget(session, target) ? { ...session, archived: message.action === "archiveCodexCliSession" } : session);
            const updated = message.payload?.cliSession;
            return updated ? [updated, ...current.filter((session) => !sameCliSessionTarget(session, updated))] : current;
          });
        }
        if (applyToCurrentChat && message.status === "completed" && ["renameCodexCliSession", "setCodexSessionGoalStatus", "setCodexSessionAutoResume", "setCodexSessionQueue"].includes(message.action) && message.payload?.cliSession)
          setSelectedCliSession(reconcileCliSessionStatus(mergeCachedCliSession(message.payload.cliSession, selectedCliSession), cliLiveStatesRef.current));
        if (
          isBrowserDashboard &&
          applyToCurrentChat &&
          message.status === "completed" &&
          message.action === "openCodexCliSession" &&
          message.payload?.cliSession
        ) {
          const opened = reconcileCliSessionStatus(mergeCachedCliSession(message.payload.cliSession, selectedCliSession), cliLiveStatesRef.current);
          messageViewRevision.current++;
          selectedCliSessionRef.current = opened;
          navigateDashboardPath(buildCliSessionPath(opened), setBrowserPath);
          setSelectedCliSession(opened);
          setCliSessionMessages(message.payload.cliSessionMessages ?? []);
          setCliSessionMessagesError(undefined);
        }
        if (applyToCurrentChat && message.status === "completed" && message.action === "forkCodexCliSession" && message.payload?.cliSession) {
          messageViewRevision.current++;
          selectedCliSessionRef.current = message.payload.cliSession;
          setSelectedCliSession(reconcileCliSessionStatus(mergeCachedCliSession(message.payload.cliSession, selectedCliSession), cliLiveStatesRef.current));
          setCliSessionMessages([]);
          navigateDashboardPath(buildCliSessionPath(message.payload.cliSession), setBrowserPath);
        }
        if (
          message.status === "completed" &&
          (message.action === "archiveCodexCliSession" || message.action === "deleteCodexCliSession")
        ) {
          if (target) void invalidateCliSessionCache(target.id, target.deviceId);
          if (!applyToCurrentChat) return;
          navigateDashboardPath("/workspace", setBrowserPath);
          messageViewRevision.current++;
          selectedCliSessionRef.current = undefined;
          setSelectedCliSession(undefined);
          setCliSessionMessages([]);
        }
        if (applyToCurrentChat && message.status === "completed" && message.action === "unarchiveCodexCliSession" && selectedCliSession) {
          const restored = message.payload?.cliSessions?.find((session) => sameCliSessionTarget(session, target)) ?? { ...selectedCliSession, archived: false };
          if (restored) setSelectedCliSession(reconcileCliSessionStatus(restored, cliLiveStatesRef.current));
        }
      }
    },
    handleEscape: () => modals.handleEscape(isActionPending("completeOAuthSession"))
  });
  const workspaceRootsKey = cliComposerConfig?.projects?.map((project) => project.path).join("\n") ?? "";
  const viewingBrowserWorkspace = isBrowserDashboard && isCliSessionsPath(browserPath) && snapshot?.settings.cliIntegrationEnabled === true;
  useEffect(() => {
    if (viewingBrowserWorkspace && realtimeConnected) requestWorkspaceTerminals();
  }, [viewingBrowserWorkspace, realtimeConnected, requestWorkspaceTerminals]);
  useEffect(() => {
    if (!viewingBrowserWorkspace) return;
    const projectPath = selectedCliSession ? selectedCliSession.projectPath : cliComposerConfig?.projects?.[0]?.path;
    const loadKey = `${selectedPeerId}:${browserPath}\n${projectPath ?? ""}:${workspaceRootsKey}`;
    // Object-valued composer/session state can be replaced by every realtime
    // response. Key the automatic load by the actual route and path so those
    // renders cannot create a request -> result -> render feedback loop.
    if (lastAutomaticWorkspaceLoadRef.current === loadKey) return;
    lastAutomaticWorkspaceLoadRef.current = loadKey;
    if (!projectPath) {
      setWorkspaceEnvironment(undefined);
      return;
    }
    requestWorkspaceEnvironment(projectPath, undefined, true);
    requestWorkspaceTerminals();
  }, [
    browserPath,
    cliComposerConfig?.projects?.[0]?.path,
    viewingBrowserWorkspace,
    requestWorkspaceEnvironment,
    requestWorkspaceTerminals,
    selectedCliSession?.projectPath,
    selectedCliSession?.remote,
    selectedPeerId,
    workspaceRootsKey
  ]);

  useEffect(() => {
    if (!viewingBrowserWorkspace || !realtimeConnected) return;
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
  }, [viewingBrowserWorkspace, realtimeConnected]);

  useEffect(() => {
    const session = selectedCliSession;
    if (!session) return;
    // Filesystem notifications are not guaranteed on every platform or for
    // every Codex writer. Keep the selected transcript fresh while a turn is
    // active; requestCliSessionMessages throttles duplicate requests.
    const refresh = (): void => {
      if (document.visibilityState === "visible" && navigator.onLine) requestCliSessionMessages(session.id, session.deviceId);
    };
    const timer = window.setInterval(refresh, session.status === "running" ? 2_000 : 5_000);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onVisibilityChange);
    refresh();
    return () => {
      window.removeEventListener("online", onVisibilityChange);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [requestCliSessionMessages, realtimeConnected, selectedCliSession?.deviceId, selectedCliSession?.id, selectedCliSession?.status]);

  useEffect(() => {
    if (!isBrowserDashboard) return;
    const onPopState = () => {
      const path = window.location.pathname;
      setBrowserPath(path);
      const sessionId = getCliSessionIdFromPath(path);
      messageViewRevision.current++;
      selectedCliSessionRef.current = undefined;
      setSelectedCliSession(undefined);
      setCliSessionMessages([]);
      setCliSessionMessagesError(undefined);
      if (sessionId || hasBrowserWorkspaceShell(path)) requestCliSessions(true);
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
    if (!hasBrowserWorkspaceShell(browserPath)) return;
    void readCliSessionListCache().then((cached) => {
      if (cached && !liveSessionListReceived.current) {
        setCliSessions(reconcileCliSessionStatuses(cached.sessions, cliLiveStatesRef.current));
        setCliComposerConfig(cached.composerConfig);
      }
      // Cached content paints immediately, but every page opening revalidates
      // in the background so a recent cache never makes the UI look stale.
      requestCliSessions();
    });
    const routeId = getCliSessionIdFromPath(window.location.pathname);
    const target = currentSessionTarget();
    const revision = messageViewRevision.current;
    if (routeId && target)
      void readCliSessionMessagesCache(routeId, target.deviceId).then((cached) => {
        if (cached && revision === messageViewRevision.current && sameCliSessionTarget(target, currentSessionTarget())) setCliSessionMessages(cached);
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
    const dashboardWorkspaceRoute = isBrowserDashboard && (browserPath === "/" || browserPath === "/tasks");
    document.body.classList.toggle("is-cli-workspace-route", workspaceRoute);
    document.body.classList.toggle("is-dashboard-workspace-route", dashboardWorkspaceRoute);
    return () => {
      document.body.classList.remove("is-cli-workspace-route");
      document.body.classList.remove("is-dashboard-workspace-route");
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
      if (event.key.toLowerCase() === "r" && snapshot && !isActionPending("refreshAll")) {
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
  }, [snapshot, isActionPending, sendAction, modals]);

  const usageAccounts = selectedPeerId === "local" || snapshot?.connectedPeers?.some(peer => peer.id === selectedPeerId && peer.local)
    ? snapshot?.accounts : snapshot?.peerAccounts?.[selectedPeerId];
  const currentUsageAccountId = usageAccounts?.find(account => account.isActive)?.id;
  useEffect(() => {
    if (usageGraphSourceRef.current !== selectedPeerId) {
      usageGraphSourceRef.current = selectedPeerId;
      usageGraphRequestRef.current = undefined;
      setUsageGraphData(undefined);
      setUsageGraphError(undefined);
    }
    if (snapshot?.settings.dailyTokenUsageEnabled !== true || !currentUsageAccountId) return;
    const refresh = () => tokenHistoryRefresh.refresh([currentUsageAccountId], true);
    refresh();
    const timer = window.setInterval(refresh, (snapshot.settings.dailyTokenUsageIntervalMinutes ?? 60) * 60_000);
    return () => window.clearInterval(timer);
  }, [currentUsageAccountId, selectedPeerId, sendAction, snapshot?.settings.dailyTokenUsageEnabled, snapshot?.settings.dailyTokenUsageIntervalMinutes]);

  if (!snapshot) {
    const connectionFailed = isBrowserDashboard && (browserHostStage === "unreachable" || browserHostStage === "offline");
    return (
      <main
        class={`panel ${isBrowserDashboard && isCliSessionsPath(browserPath) ? "workspace-route-dashboard-hidden" : ""}`}
        id="dashboard-main"
      >
        <section class="section loading-section">
          {connectionFailed ? <BrowserConnectionRecovery stage={browserHostStage} onRetry={() => postMessageToHost({ type: "dashboard:retry-connection" })} /> : <div class="loading-screen" role="status" aria-live="polite" aria-label="Loading…">
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
          </div>}
        </section>
      </main>
    );
  }

  const runningCliSessions = filterCliSessionsBySection(cliSessions, "active").filter((session) =>
    (session.status === "running" && (!session.remote || pcOptions.some(peer => peer.id === session.deviceId && peer.connected))) || session.interrupted === true
  );
  const displayedAccounts =
    selectedPeer && !selectedPeer.local ? (snapshot.peerAccounts?.[selectedPeer.id] ?? []) : snapshot.accounts;
  const overviewAccount = resolveOverviewAccount(displayedAccounts);
  const accountInfoAccount = accountInfoAccountId
    ? displayedAccounts.find((account) => account.id === accountInfoAccountId)
    : undefined;
  const openCliSessions = (): void => {
    if (!isBrowserDashboard) {
      sendAction("openWebDashboard", undefined, { path: "/workspace", targetDeviceId: undefined });
      return;
    }
    navigateDashboardPath("/workspace", setBrowserPath);
    setSelectedCliSession(undefined);
    setCliSessionMessages([]);
    setCliSessionsError(undefined);
    setCliSessionMessagesError(undefined);
    requestCliSessions();
  };
  const selectCliSession = (session: DashboardCliSessionSummary): void => {
    if (session.archived) {
      showCliSessionFeedback({
        key: Date.now(),
        level: "warning",
        message: "Archived sessions cannot be opened. Restore this session first."
      });
      return;
    }
    navigateDashboardPath(buildCliSessionPath(session), setBrowserPath);
    selectedCliSessionRef.current = session;
    setSelectedCliSession(reconcileCliSessionStatus(session, cliLiveStatesRef.current));
    setCliSessionMessages([]);
    setCliSessionMessagesError(undefined);
    const revision = ++messageViewRevision.current;
    void readCliSessionMessagesCache(session.id, session.deviceId).then((cached) => {
      if (cached && revision === messageViewRevision.current && sameCliSessionTarget(session, currentSessionTarget())) setCliSessionMessages(cached);
    });
    requestCliSessionMessages(session.id, session.deviceId, false, false);
  };
  const sortedAccounts = useMemo(
    () =>
      sortAccounts(
        filterAccounts(
          displayedAccounts,
          uiPreferences.accountSearch,
          uiPreferences.filter,
          snapshot.settings.quotaYellowThreshold
        ),
        accountSort,
        uiPreferences.metricPriority,
        createAutoQueuePolicy(snapshot.settings, state.now),
        snapshot.settings.encryptedSyncRegistryOverrideEnabled
      ),
    [
      displayedAccounts,
      snapshot.settings.quotaYellowThreshold,
      snapshot.settings.autoSwitchHourlyThreshold,
      snapshot.settings.autoSwitchWeeklyThreshold,
      snapshot.settings.autoSwitchEnabled,
      snapshot.settings.autoResetEnabled,
      snapshot.settings.autoResetWeeklyThreshold,
      snapshot.settings.quotaFreshnessMs,
      state.now,
      snapshot.settings.encryptedSyncRegistryOverrideEnabled,
      uiPreferences.accountSearch,
      uiPreferences.filter,
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
  const privacyToggleLabel = state.privacyMode ? snapshot.copy.showSensitive : snapshot.copy.hideSensitive;
  const handlePrivacyToggle = (): void => {
    const privacyMode = !state.privacyMode;
    dispatch({ type: "toggle-privacy" });
    sendAction("setPrivacyMode", undefined, { privacyMode });
  };
  const prepareOAuthPending = isActionPending("prepareOAuthSession");
  const startOAuthAutoPending = isActionPending("startOAuthAutoFlow");
  const completeOAuthPending = isActionPending("completeOAuthSession");
  const importSharedPending = isActionPending("importSharedJson");
  const restoreBackupPending = isActionPending("restoreFromBackup");
  const restoreAuthPending = isActionPending("restoreFromAuthJson");
  const sharePending = isActionPending("shareTokens");
  const downloadSharePending = isActionPending("downloadJsonFile");
  const batchRefreshPending = isActionPending("batchRefresh");
  const batchResyncPending = isActionPending("batchResyncProfile");
  const batchRemovePending = isActionPending("batchRemove");
  const syncPending = isActionPending("syncNow") || isActionPending("configureEncryptedSync");
  const brandSubtitle = resolveBrandSubtitle(
    snapshot.brandSub,
    snapshot.settings.encryptedSyncEnabled,
    snapshot.encryptedSyncLastCompletedAt,
    snapshot.encryptedSyncEnabledSessionCount,
    snapshot.encryptedSyncSessionCount,
    displayedAccounts.length
  );
  const capabilityThresholds = createAutoQueuePolicy(snapshot.settings, state.now);
  const searchedAccounts = filterAccounts(displayedAccounts, uiPreferences.accountSearch, "all", snapshot.settings.quotaYellowThreshold);
  const invalidAccountCount = searchedAccounts.filter(isAccountAttention).length;
  const validAccountCount = searchedAccounts.length - invalidAccountCount;
  const accountEnablement = countAccountEnablement(searchedAccounts);
  const claimedAccountCount = searchedAccounts.filter(isAccountClaimedByAnotherDevice).length;
  const capableAccountCount = searchedAccounts.filter(hasDashboardQuotaRemaining).length;
  const incapableAccountCount = searchedAccounts.filter(isDashboardAccountOutOfQuota).length;
  const availableMetrics = Array.from(
    new Map(
      displayedAccounts
        .flatMap((account) => account.metrics)
        .filter((metric) => metric.visible)
        .map((metric) => [metric.key, metric])
    ).values()
  );
  const metricAveragePercent = (metricKey: string): number | undefined => {
    const values = displayedAccounts
      .flatMap((account) => account.metrics)
      .filter(
        (metric) =>
          metric.visible &&
          metric.key === metricKey &&
          typeof metric.percentage === "number" &&
          Number.isFinite(metric.percentage)
      )
      .map((metric) => metric.percentage as number);
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : undefined;
  };

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
    if (action === "switch" && accountId) {
      const account = displayedAccounts.find((candidate) => candidate.id === accountId);
      const claimedElsewhere = Boolean(account?.runningDeviceName && !account.runningOnThisDevice);
      if (claimedElsewhere && !snapshot.settings.encryptedSyncRegistryOverrideEnabled) {
        setBrowserActionRequest({
          kind: "password",
          action: "switch",
          accountId,
          title: "Switch claimed account",
          message: `Enter the shared password to enable Rescue on this PC and switch to ${getSensitiveDisplayValue(account?.email, state.privacyMode, "email", "this account")}. Automation will continue to avoid foreign-claimed accounts.`,
          confirmPassword: false
        });
        return;
      }
    }
    if (action === "details" && isBrowserDashboard && accountId) {
      setAccountInfoAccountId(accountId);
      return;
    }
    if (action === "reauthorize" && accountId) {
      const account = displayedAccounts.find((candidate) => candidate.id === accountId);
      modals.openReauthorizeModal(accountId, account?.email ?? "");
      return;
    }
    if (action === "remove" && accountId) {
      const account = displayedAccounts.find((candidate) => candidate.id === accountId);
      setBrowserActionRequest({
        kind: "confirm",
        action,
        accountId,
        title: "Remove account",
        message: `Remove ${getSensitiveDisplayValue(account?.email, state.privacyMode, "email", "this account")} from Codex Manager?`,
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
        message: `Reset the rate limit for ${getSensitiveDisplayValue(account?.email, state.privacyMode, "email", "this account")}? ${available} reset${available === 1 ? "" : "s"} available.`,
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

  const openBrowserSwitchPicker = (targetDeviceId?: string, preferredAccountId?: string): void => {
    const targetPeer = targetDeviceId === "local" ? pcOptions.find(peer => peer.local) : targetDeviceId ? pcOptions.find(peer => peer.id === targetDeviceId) : selectedPeer;
    if ((targetDeviceId && !targetPeer) || targetPeer?.connected === false) {
      showNotice({ level: "warning", message: "This system is offline. Reconnect it before switching accounts." });
      return;
    }
    const resolvedTarget = targetPeer && !targetPeer.local ? targetPeer.id : undefined;
    const accountsForTarget = resolvedTarget ? (snapshot.peerAccounts?.[resolvedTarget] ?? []) : snapshot.accounts;
    const accountIds = accountsForTarget
      .filter(
        (account) =>
          (!preferredAccountId || account.id === preferredAccountId) &&
          !account.isActive &&
          !account.switchQueued &&
          account.enabled &&
          hasDashboardAutoQueueCapability(account, capabilityThresholds) &&
          canRunAccountOnThisPc(account, isActionPending("switch", account.id), snapshot.settings.encryptedSyncRegistryOverrideEnabled)
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
                : preferredAccountId ? "This account is not ready to switch. Check its status and quota on the dashboard." : "No account to switch — no capable account has enough quota remaining."
      });
      return;
    }
    setBrowserActionRequest({ kind: "switch", accountIds, targetDeviceId: resolvedTarget });
  };

  const confirmBrowserAction = (request: BrowserActionRequest, submittedValues?: string[]): void => {
    setBrowserActionRequest(undefined);
    if (request.kind === "quotaWarning") {
      const choice = submittedValues?.[0];
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
        action: submittedValues?.[0]
      });
      return;
    }
    if (request.kind === "disabledActiveAccount") {
      if (submittedValues?.[0] === "unload") {
        sendAction("unloadAuth");
      } else {
        showNotice({
          level: "warning",
          message:
            "The account stays loaded until you manually choose Unload, including after restart."
        });
      }
      return;
    }
    if (request.kind === "switch") {
      const accountId = request.accountIds[0];
      if (accountId) {
        const account = (
          request.targetDeviceId ? (snapshot.peerAccounts?.[request.targetDeviceId] ?? []) : snapshot.accounts
        ).find((candidate) => candidate.id === accountId);
        const claimedElsewhere = Boolean(account?.runningDeviceName && !account.runningOnThisDevice);
        if (claimedElsewhere && !snapshot.settings.encryptedSyncRegistryOverrideEnabled) {
          setBrowserActionRequest({
            kind: "password",
            action: "switch",
            accountId,
            targetDeviceId: request.targetDeviceId,
            title: "Switch claimed account",
            message: `Enter the shared password to enable Rescue on that PC and switch to ${getSensitiveDisplayValue(account?.email, state.privacyMode, "email", "this account")}.`,
            confirmPassword: false
          });
        } else {
          sendAction("switch", accountId, { targetDeviceId: request.targetDeviceId });
        }
      }
      return;
    }
    if (request.kind === "password") {
      const rotating = request.action === "configureEncryptedSync" && request.requireCurrentPassword === true;
      sendAction(request.action, request.accountId, {
        enabled: request.enabled,
        targetDeviceId: request.targetDeviceId,
        currentPassphrase: rotating ? submittedValues?.[0] : undefined,
        passphrase: rotating ? submittedValues?.[1] : submittedValues?.[0],
        passphraseConfirmation: rotating ? submittedValues?.[2] : submittedValues?.[1]
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
        : request.kind === "password"
          ? `${request.title} cancelled.`
          : request.kind === "notification"
            ? "Notification dismissed."
            : request.kind === "disabledActiveAccount"
              ? "The disabled account stays loaded until you manually choose Unload, including after restart."
              : request.action === "reloadPrompt"
                ? "Reload postponed. Use Reload when you are ready."
                : `${request.title} cancelled.`;
    showNotice({ level: "info", message });
  };

  const handleConfigureEncryptedSync = (): void => {
    const configured = snapshot.encryptedSyncNeedsConfiguration !== true;
    setBrowserActionRequest({
      kind: "password",
      action: "configureEncryptedSync",
      title: configured ? "Change password" : "Set password",
      message: configured
        ? "Enter the current password and a new shared password. Existing browser sessions will be signed out, and every PC must use the new password."
        : "Create the one shared password used for cross-PC claim checks, optional full account sync, remote dashboard login, and protected controls.",
      confirmPassword: true,
      requireCurrentPassword: configured
    });
  };

  const handleSyncNow = (): void => {
    if (snapshot.encryptedSyncNeedsConfiguration === true) {
      handleConfigureEncryptedSync();
      return;
    }
    sendAction("syncNow");
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
      title={resolveAccountModalTitle(
        snapshot.copy.addAccountModalTitle,
        getSensitiveDisplayValue(modals.reauthorizeEmail, state.privacyMode, "email")
      )}
      tab={modals.addAccountTab}
      copy={snapshot.copy}
      oauthSession={modals.oauthSession}
      oauthCallbackUrl={modals.oauthCallbackUrl}
      oauthError={modals.oauthError}
      importJsonText={modals.importJsonText}
      importJsonError={modals.importJsonError}
      importResult={modals.importResult}
      copyFeedbackKey={modals.copyFeedbackKey}
      lang={snapshot.lang}
      prepareOAuthPending={prepareOAuthPending}
      startOAuthAutoPending={startOAuthAutoPending}
      completeOAuthPending={completeOAuthPending}
      importCurrentPending={isActionPending("importCurrent")}
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
      onSubmitImport={modals.handleSubmitImport}
    />
  );

  return (
    <>
      <a class="skip-link" href="#dashboard-main">
        Skip to main content
      </a>
      {isBrowserDashboard && !isCliSessionsPath(browserPath) && (browserHostStage === "unreachable" || browserHostStage === "offline")
        ? createPortal(<BrowserConnectionBanner stage={browserHostStage} lastSyncAt={browserLastSyncAt} onRetry={() => postMessageToHost({ type: "dashboard:retry-connection" })} />, document.body)
        : null}
      {notice && !(isBrowserDashboard && isCliSessionsPath(browserPath) && cliSessionFeedback?.message === notice.message)
        ? createPortal(
            <div class="dashboard-notice-stack" aria-label="Notifications" aria-live="polite">
              <div
                key={notice.id}
                class={`dashboard-notice is-${notice.level}`}
                role={notice.level === "error" ? "alert" : "status"}
              >
                <span>{notice.message}</span>
                <button
                  type="button"
                  aria-label="Dismiss notification"
                  onClick={() => {
                    noticeControllerRef.current?.dismiss(notice.id);
                    closeBrowserPush();
                  }}
                >
                  ×
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
      {codexRequests[0]
        ? createPortal(
            <CodexRequestDialog
              key={`${codexRequests[0].deviceId ?? "local"}:${codexRequests[0].id}`}
              request={codexRequests[0]}
              queuedCount={codexRequests.length - 1}
              busy={isActionPending("respondCodexServerRequest")}
              error={codexRequestError}
              onRespond={(decision, answers) => {
                setCodexRequestError(undefined);
                sendAction("respondCodexServerRequest", undefined, {
                  codexRequestId: codexRequests[0]!.id,
                  codexDecision: decision,
                  codexAnswers: answers,
                  targetDeviceId: codexRequests[0]!.deviceId
                });
              }}
            />,
            document.body
          )
        : null}
      <main
        id="dashboard-main"
        class={`panel dashboard-density-compact dashboard-view-${uiPreferences.view} ${state.privacyMode ? "privacy-hidden" : ""} ${isBrowserDashboard && isCliSessionsPath(browserPath) ? "workspace-route-dashboard-hidden" : ""}`}
      >
        {snapshot.settings.taskBoardEnabled !== false ? <div hidden={browserPath !== '/tasks'}><TaskBoard
          sessions={cliSessions} projects={cliComposerConfig?.projects}
          connected={!isBrowserDashboard || realtimeConnected}
          targetDeviceId={selectedPeer?.local ? undefined : selectedPeer?.id}
          sendAction={sendAction} onOpenSession={selectCliSession}
        /></div> : null}
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
        <section class="section" hidden={browserPath === '/tasks'}>
          <div class="hero">
            <div class="brand">
              <img class="brand-logo" src={snapshot.logoUri} alt="" aria-hidden="true" width="28" height="28" />
              <div class="brand-copy">
                <h1>Codex Manager</h1>
                <p>{brandSubtitle}</p>
              </div>
            </div>
            <div class="hero-settings">
              {selectedPeer && pcOptions.length > 1 ? (
                <PcPickerControl
                  peers={pcOptions}
                  accountsByPeerId={Object.fromEntries(
                    pcOptions.map((peer) => [
                      peer.id,
                      peer.local ? snapshot.accounts : (snapshot.peerAccounts?.[peer.id] ?? [])
                    ])
                  )}
                  selectedPeerId={selectedPeer.id}
                  lang={snapshot.lang}
                  privacyMode={state.privacyMode}
                  open={pcPickerOpen}
                  onToggle={() => {
                    setCliSessionsMenuOpen(false);
                    setPcPickerOpen((current) => !current);
                  }}
                  onClose={() => setPcPickerOpen(false)}
                  onChange={(peerId) => {
                    setSelectedPeerId(peerId);
                    const peer = pcOptions.find(peer => peer.id === peerId)!;
                    const name = getSensitiveDisplayValue(peer.name, state.privacyMode, "name");
                    showNotice({ level: peer.connected ? "info" : "warning", message: peer.connected ? `Showing ${name} dashboard.` : `${name} is offline. Showing saved dashboard data.` });
                  }}
                  onOpenBrowser={!isBrowserDashboard ? () => sendAction("openWebDashboard") : undefined}
                />
              ) : null}
              {isBrowserDashboard && realtimeConnected ? (
                <span class="dashboard-live-status" role="status" title="Live updates are active">
                  <span aria-hidden="true"></span>
                  Live
                </span>
              ) : null}
              {snapshot.settings.cliIntegrationEnabled === true ? (
                <CliSessionsMenu
                  browser={isBrowserDashboard}
                  autoResumeEnabled={snapshot.settings.autoResumeEnabled === true}
                  onAutoResume={(session, enabled) => requestSessionAction("setCodexSessionAutoResume", session, { autoResumeEnabled: enabled })}
                  onQueue={(session, enabled, priority) => requestSessionAction("setCodexSessionQueue", session, { queueEnabled: enabled, sessionQueuePriority: priority ?? 0 })}
                  sessions={runningCliSessions}
                  peers={pcOptions}
                  ready={liveSessionListReceived.current}
                  error={cliSessionsError}
                  connected={!isBrowserDashboard || realtimeConnected}
                  loading={isActionPending("listCodexCliSessions")}
                  actionPending={isActionPending("resumeCodexSessions") || isActionPending("openCodexCliSession") || isActionPending("setCodexSessionAutoResume") || isActionPending("setCodexSessionQueue")}
                  onOpen={(session) => {
                    if (isBrowserDashboard && session.status === "running") {
                      setCliSessionsMenuOpen(false);
                      navigateDashboardPath(buildCliSessionPath(session), setBrowserPath);
                    } else requestSessionAction(session.status === "running" ? "openCodexCliSession" : "resumeCodexSessions", session, { openInVsCode: true });
                  }}
                  lang={snapshot.lang}
                  privacyMode={state.privacyMode}
                  open={cliSessionsMenuOpen}
                  onToggle={() => {
                    setPcPickerOpen(false);
                    setCliSessionsMenuOpen((current) => !current);
                    if (!cliSessionsMenuOpen) requestCliSessions();
                  }}
                  onClose={() => setCliSessionsMenuOpen(false)}
                  onRetry={() => { setCliSessionsError(undefined); requestCliSessions(true, true); }}
                  onManage={() => {
                    setCliSessionsMenuOpen(false);
                    openCliSessions();
                  }}
                />
              ) : null}
              <button
                id="donateButton"
                class="settings-btn refresh-view-btn action-btn icon-only"
                type="button"
                title="Donate"
                aria-label="Donate"
                onClick={() => setDonationOpen(true)}
              >
                <span class="button-face">
                  <span class="button-label">♡</span>
                </span>
              </button>
              <button
                id="apiOpenButton"
                class="settings-btn action-btn"
                type="button"
                title="API access"
                aria-label="API access"
                onClick={() => setApiTokenOpen(true)}
              >
                <span class="button-face"><span class="button-label">API</span></span>
              </button>
              <button
                id="settingsOpenButton"
                class="settings-btn action-btn icon-only settings-alert-trigger"
                type="button"
                title={snapshot.copy.settingsTitle}
                aria-label={snapshot.copy.settingsTitle}
                aria-description={snapshot.encryptedSyncNeedsConfiguration ? "Password required" : undefined}
                onClick={() => dispatch({ type: "open-settings" })}
              >
                <span class="button-face">
                  <span class="button-icon">⚙</span>
                </span>
                {snapshot.encryptedSyncNeedsConfiguration ? <span class="settings-alert-badge" aria-hidden="true">!</span> : null}
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
              <DashboardMobileActions
                lang={snapshot.lang}
                privacyMode={state.privacyMode}
                privacyToggleLabel={privacyToggleLabel}
                privacyPending={isActionPending("setPrivacyMode")}
                syncPending={syncPending}
                settingsTitle={snapshot.copy.settingsTitle}
                passwordRequired={snapshot.encryptedSyncNeedsConfiguration === true}
                aboutTitle={resolveAboutTitle(snapshot.lang)}
                onPrivacyToggle={handlePrivacyToggle}
                onSync={handleSyncNow}
                onSettings={() => dispatch({ type: "open-settings" })}
                onAbout={() => setAboutOpen(true)}
              />
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
            privacyPending={isActionPending("setPrivacyMode")}
            onPrivacyToggle={handlePrivacyToggle}
            disabled={snapshot.indexHealth.status === "corrupted_unrecoverable"}
            addPending={prepareOAuthPending}
            refreshAllPending={isActionPending("refreshAll")}
            consumeResetCreditPending={Boolean(
              overviewAccount && isActionPending("consumeResetCredit", overviewAccount.id)
            )}
            emptyAccountContent={!overviewAccount ? renderAddAccount(true, true) : undefined}
            metricPriority={uiPreferences.metricPriority}
            usageGraphData={usageGraphDataSourceRef.current === selectedPeerId ? usageGraphData : undefined}
            usageGraphError={usageGraphError}
            usageGraphPending={isActionPending("getUsageGraph")}
            usageGraphRevision={`${snapshot.usageSummary?.revision ?? 0}:${usageGraphVersion}:${snapshot.settings.tokenHistoryRetentionDays ?? 30}`}
            usageGraphSource={selectedPeerId}
            usageGraphPaused={isBrowserDashboard && isCliSessionsPath(browserPath)}
            onLoadUsageGraph={(query) => {
              setUsageGraphError(undefined);
              usageGraphSourceRef.current = selectedPeerId;
              usageGraphRequestRef.current = sendAction("getUsageGraph", undefined, { usageGraph: query });
            }}
            dailyUsagePending={Boolean(overviewAccount && isActionPending("getDailyUsage", overviewAccount.id))}
            tokenHistoryRefresh={tokenHistoryRefresh}
            onSetAutoSwitchLock={handleAutoSwitchLock}
            onAddAccount={
              overviewAccount
                ? modals.openAddAccountModal
                : () => document.querySelector<HTMLInputElement>("#inline-add-account-panel .oauth-link-input")?.focus()
            }
            onOnboard={() => {
              setOnboardingError(undefined);
              setOnboardingStep("agreement");
              setOnboardingImportCompleted(false);
              setOnboardingOpen(true);
            }}
            onRefreshAll={() => sendAction("refreshAll")}
            onConfigureSync={handleConfigureEncryptedSync}
            onSyncNow={handleSyncNow}
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
            onOpenCodex={() => sendAction("openNewCodexWebview")}
            onResumeSessions={() => sendAction("resumeCodexSessions")}
            resumeSessionsPending={isActionPending("resumeCodexSessions")}
            codexOpenPending={isActionPending("openNewCodexWebview")}
          />

        </section>
        {displayedAccounts.length > 0 && browserPath !== '/tasks' ? (
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
                      {resolveUiText("total", snapshot.lang)} {searchedAccounts.length}
                    </button>
                    {shouldShowAccountCountFilter(accountEnablement.enabled, searchedAccounts.length) ? (
                      <button
                        class={`header-count-badge is-enabled header-count-link ${uiPreferences.filter === "enabled" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "enabled"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "enabled" }))}
                      >
                        {resolveUiText("enabled", snapshot.lang)} {accountEnablement.enabled}
                      </button>
                    ) : null}
                    {shouldShowAccountCountFilter(accountEnablement.disabled, searchedAccounts.length) ? (
                      <button
                        class={`header-count-badge is-disabled header-count-link ${uiPreferences.filter === "disabled" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "disabled"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "disabled" }))}
                      >
                        {resolveUiText("disabled", snapshot.lang)} {accountEnablement.disabled}
                      </button>
                    ) : null}
                    {shouldShowAccountCountFilter(claimedAccountCount, searchedAccounts.length) ? (
                      <button
                        class={`header-count-badge is-claimed header-count-link ${uiPreferences.filter === "claimed" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "claimed"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "claimed" }))}
                      >
                        {resolveUiText("claimed", snapshot.lang)} {claimedAccountCount}
                      </button>
                    ) : null}
                    {shouldShowAccountCountFilter(validAccountCount, searchedAccounts.length) ? (
                      <button
                        class={`header-count-badge is-valid header-count-link ${uiPreferences.filter === "healthy" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "healthy"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "healthy" }))}
                      >
                        {resolveUiText("valid", snapshot.lang)} {validAccountCount}
                      </button>
                    ) : null}
                    {shouldShowAccountCountFilter(invalidAccountCount, searchedAccounts.length) ? (
                      <button
                        class={`header-count-badge header-count-link ${invalidAccountCount ? "is-invalid" : ""} ${uiPreferences.filter === "attention" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "attention"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "attention" }))}
                      >
                        {resolveUiText("invalid", snapshot.lang)} {invalidAccountCount}
                      </button>
                    ) : null}
                    {shouldShowAccountCountFilter(capableAccountCount, searchedAccounts.length) ? (
                      <button
                        class={`header-count-badge is-capable header-count-link ${uiPreferences.filter === "capable" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "capable"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "capable" }))}
                      >
                        {resolveUiText("capable", snapshot.lang)} {capableAccountCount}
                      </button>
                    ) : null}
                    {shouldShowAccountCountFilter(incapableAccountCount, searchedAccounts.length) ? (
                      <button
                        class={`header-count-badge header-count-link ${incapableAccountCount ? "is-incapable" : ""} ${uiPreferences.filter === "incapable" ? "is-selected" : ""}`}
                        type="button"
                        aria-pressed={uiPreferences.filter === "incapable"}
                        onClick={() => setUiPreferences((current) => ({ ...current, filter: "incapable" }))}
                      >
                        {resolveUiText("incapable", snapshot.lang)} {incapableAccountCount}
                      </button>
                    ) : null}
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
                />
              ) : null}
            </div>
            <div class="dashboard-account-toolbar">
              <label class="account-search-control">
                <span aria-hidden="true">⌕</span>
                <input
                  ref={searchInputRef}
                  name="account-search"
                  type="text"
                  role="searchbox"
                  inputMode="search"
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
                      {metric.label} ·{" "}
                      {metricAveragePercent(metric.key) == null ? "—" : `${metricAveragePercent(metric.key)}%`}
                    </option>
                  ))}
                </select>
              </label>
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
                    ? `当前查看：${getSensitiveDisplayValue(selectedPeer.name, state.privacyMode, "name")} · ${selectedPeer.sessionCount} 个会话 · 操作通过安全连接转发。`
                    : snapshot.lang === "zh-hant"
                      ? `目前檢視：${getSensitiveDisplayValue(selectedPeer.name, state.privacyMode, "name")} · ${selectedPeer.sessionCount} 個工作階段 · 操作會透過安全連線轉送。`
                      : `Viewing ${getSensitiveDisplayValue(selectedPeer.name, state.privacyMode, "name")} · ${selectedPeer.sessionCount} sessions · actions are relayed over the secure connection.`}
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
                  busy={(isBrowserDashboard && !realtimeConnected) || state.pendingActions.some(request => request.accountId === account.id)}
                  unloadAuthPending={isActionPending("unloadAuth")}
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
                  consumeResetCreditPending={isActionPending("consumeResetCredit", account.id)}
                  exportPending={isActionPending("shareTokens") || isActionPending("exportAuthFile")}
                  selected={selectedAccountIds.has(account.id)}
                  metricPriority={uiPreferences.metricPriority}
                  compactRow={uiPreferences.view === "list"}
                  onToggleSelected={() => dispatch({ type: "toggle-select", accountId: account.id })}
                  onExportAuth={() => handleExportAccount(account.id)}
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
        connected={!isBrowserDashboard || realtimeConnected}
        onSetCrossPcSyncEnabled={(enabled) => sendAction("setCrossPcSyncEnabled", undefined, { enabled })}
        crossPcSyncPending={isActionPending("setCrossPcSyncEnabled")}
        open={state.settingsOpen}
        copy={snapshot.copy}
        lang={snapshot.lang}
        settings={snapshot.settings}
        tokenAutomation={snapshot.tokenAutomation}
        encryptedSyncNeedsConfiguration={Boolean(snapshot.encryptedSyncNeedsConfiguration)}
        encryptedSyncNeedsSettingsSync={Boolean(snapshot.encryptedSyncNeedsSettingsSync)}
        usageHistoryCount={snapshot.usageSummary?.count ?? 0}
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
        onClearUsageHistory={() => {
          postMessageToHost({ type: "dashboard:usage-history", samples: [] });
          try {
            window.localStorage.removeItem(USAGE_HISTORY_STORAGE_KEY);
          } catch {
            /* optional */
          }
        }}
        onExportBackup={handleExportBackup}
        onShowLogs={() => setLogConsoleOpen(true)}
        sendAction={sendAction}
        targetDeviceId={selectedPeer?.local ? undefined : selectedPeer?.id}
        targetName={getSensitiveDisplayValue(selectedPeer?.name ?? "This system", state.privacyMode, "name")}
        onImportBackup={modals.openImportModal}
        onConfigureSync={handleConfigureEncryptedSync}
        onSyncNow={handleSyncNow}
        syncPending={syncPending}
        onSetRegistryOverride={handleRegistryOverride}
        registryOverridePending={isActionPending("setEncryptedSyncRegistryOverride")}
      />

      <ModalShell open={logConsoleOpen} title="System Log" closeLabel={snapshot.copy.closeModal} onClose={() => setLogConsoleOpen(false)} className="log-console-modal">
        <div class="settings-note">Recent redacted logs refresh every 2 seconds while open.</div>
        {logConsoleError && <div role="status" class="settings-note">{logConsoleError}</div>}
        {logConsoleLimited && <div class="settings-note">Showing up to 1,000 recent records; older logs exceed the display limit.</div>}
        <SystemLogConsole records={logConsoleRecords} loading={isActionPending("viewLogs")} emptyMessage={logConsoleError && !logConsoleRecords.length ? "No records loaded." : undefined} />
        <div class="settings-actions">
          <button class="settings-action-btn" type="button" disabled={isActionPending("viewLogs")} onClick={refreshLogConsole}>Refresh</button>
          <button class="settings-action-btn" type="button" disabled={isActionPending("downloadLogs")} onClick={() => { logDownloadRequestRef.current = sendAction("downloadLogs"); }}>Download</button>
          <button class="settings-action-btn" type="button" disabled={isActionPending("clearLogs")} onClick={() => sendAction("clearLogs")}>{isActionPending("clearLogs") ? "Clearing…" : "Clear"}</button>
        </div>
      </ModalShell>

      {isBrowserDashboard && !isCliSessionsPath(browserPath) && !state.settingsOpen && <BrowserNotifications offerOnLoad />}
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
        onOpenExternal={openExternalLink}
        onFinish={finishOnboarding}
      />

      <ModalShell
        open={donationOpen}
        title="Donate to Codex Manager"
        closeLabel={snapshot.copy.closeModal}
        className="dashboard-modal-compact"
        onClose={() => setDonationOpen(false)}
      >
        <DonationDetails onOpenExternal={openExternalLink} />
      </ModalShell>

      <AboutModal
        open={aboutOpen}
        lang={snapshot.lang}
        logoUri={snapshot.logoUri}
        version={packageJson.version}
        onClose={() => setAboutOpen(false)}
        onOpenExternal={openExternalLink}
      />

      <ApiTokenModal
        open={apiTokenOpen}
        token={apiToken}
        tokens={apiTokens}
        projects={cliComposerConfig?.projects}
        connected={!isBrowserDashboard || realtimeConnected}
        enabled={snapshot.settings.apiAccessEnabled === true}
        pending={isActionPending("generateApiToken") || isActionPending("revokeApiToken") || isActionPending("listApiTokens")}
        onClose={() => setApiTokenOpen(false)}
        onGenerate={(name, projectPath, permissions) => sendAction('generateApiToken', undefined, { tokenName: name, projectPath, tokenPermissions: permissions, targetDeviceId: undefined })}
        onRevoke={tokenId => { sendAction('revokeApiToken', undefined, { tokenId, targetDeviceId: undefined }); }}
      />

      <AccountInfoModal
        account={isBrowserDashboard ? accountInfoAccount : undefined}
        lang={snapshot.lang}
        privacyMode={state.privacyMode}
        closeLabel={snapshot.copy.closeModal}
        onClose={() => setAccountInfoAccountId(undefined)}
      />

      {
        <BrowserActionModal
          request={browserActionRequest}
          accounts={
            browserActionRequest?.kind === "switch"
              ? browserActionRequest.targetDeviceId ? (snapshot.peerAccounts?.[browserActionRequest.targetDeviceId] ?? []) : snapshot.accounts
              : displayedAccounts
          }
          lang={snapshot.lang}
          privacyMode={state.privacyMode}
          closeLabel={snapshot.copy.closeModal}
          onCancel={cancelBrowserAction}
          onConfirm={confirmBrowserAction}
          presentation={isBrowserDashboard ? "modal" : "popover"}
        />
      }

      {isBrowserDashboard && hasBrowserWorkspaceShell(browserPath)
        ? createPortal(
            <CliSessionsPage
              dashboardMode={browserPath === "/" || browserPath === "/tasks"}
              taskBoardEnabled={snapshot.settings.taskBoardEnabled !== false}
              onTasks={() => navigateDashboardPath('/tasks', setBrowserPath)}
              onApi={() => setApiTokenOpen(true)}
              showLogout={document.documentElement.dataset["dashboardRemote"] === "true"}
              privacyMode={state.privacyMode}
              autoResumeEnabled={snapshot?.settings.autoResumeEnabled === true}
              sessions={cliSessions}
              selectedSession={selectedCliSession}
              messages={combineCliLiveMessages(cliSessionMessages, selectedCliSession && !historicalStreams.current.has(cliLiveStates[cliSessionTargetKey(selectedCliSession)]?.streamId ?? "") ? cliLiveStates[cliSessionTargetKey(selectedCliSession)] : undefined)}
              liveState={selectedCliSession ? cliLiveStates[cliSessionTargetKey(selectedCliSession)] : undefined}
              liveStates={cliLiveStates}
              connected={realtimeConnected && !["offline", "unreachable", "degraded", "reconnecting"].includes(browserHostStage) && (!selectedCliSession?.deviceId || pcOptions.some((peer) => peer.id === selectedCliSession.deviceId && peer.connected)) && (!selectedCliSession || !cliLiveStates[cliSessionTargetKey(selectedCliSession)] || liveAuthority.current.has(cliSessionTargetKey(selectedCliSession)))}
              submissionResults={submissionResults}
              steering={isActionPending("steerCodexCliSessionTurn")}
              composerConfig={cliComposerConfig}
              loading={isActionPending("listCodexCliSessions")}
              starting={isActionPending("startCodexCliSession")}
              messagesLoading={isActionPending("getCodexCliSessionMessages")}
              sending={isActionPending("sendCodexCliSessionMessage") && [...turnRequests.current.values()].some((target) => sameCliSessionTarget(target, selectedCliSession))}
              stopping={isActionPending("cancelCodexCliSessionTurn")}
              mutating={(isBrowserDashboard && !realtimeConnected) || [
                "openNewCodexWebview",
                "openCodexCliSession",
                "renameCodexCliSession",
                "forkCodexCliSession",
                "archiveCodexCliSession",
                "unarchiveCodexCliSession",
                "deleteCodexCliSession"
              ].some((action) => isActionPending(action as DashboardActionName))}
              goalUpdating={isActionPending("setCodexSessionGoalStatus")}
              onGoalStatus={(status) => selectedCliSession && requestSessionAction("setCodexSessionGoalStatus", selectedCliSession, { goalStatus: status })}
              onAutoResume={(session, enabled) => requestSessionAction("setCodexSessionAutoResume", session, { autoResumeEnabled: enabled })}
              onQueue={(session, enabled, priority) => requestSessionAction("setCodexSessionQueue", session, { queueEnabled: enabled, sessionQueuePriority: priority ?? 0 })}
              error={cliSessionsError}
              agentMessages={agentMessages}
              onReadAgent={(agent) => {
                const key = cliSessionTargetKey(agent);
                if ([...agentRequests.current.values()].includes(key)) return;
                const requestId = sendAction("getCodexSubAgentMessages", undefined, { sessionId: agent.id, targetDeviceId: agent.deviceId, projectPath: agent.projectPath });
                if (requestId) {
                  agentRequests.current.set(requestId, key);
                  setAgentMessages((current) => ({ ...current, [key]: { ...current[key], error: undefined, loading: true } }));
                }
              }}
              messagesError={cliSessionMessagesError}
              feedback={cliSessionFeedback}
              environment={workspaceEnvironment}
              terminalResults={terminalResults.filter((result) => selectedPeer?.local !== false ? !result.deviceId : result.deviceId === selectedPeer.id)}
              terminalLiveOutputs={Object.values(terminalLiveOutputs).filter((output) => selectedPeer?.local !== false ? !output.deviceId : output.deviceId === selectedPeer.id)}
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
              onSettings={() => dispatch({ type: "open-settings" })}
              switchingAccount={state.pendingActions.some(request => request.action === "switch")}
              peers={pcOptions}
              selectedPeerId={selectedPeer?.id ?? selectedPeerId}
              peerAccounts={snapshot.peerAccounts}
              onPeerChange={setSelectedPeerId}
              onDashboard={() => navigateDashboardPath("/", setBrowserPath)}
              onRefresh={() => {
                explicitCliRefreshRef.current = requestCliSessions(true, true);
              }}
              onSelect={selectCliSession}
              onBackToList={() => {
                navigateDashboardPath("/workspace", setBrowserPath);
                messageViewRevision.current++;
                selectedCliSessionRef.current = undefined;
                setSelectedCliSession(undefined);
                setCliSessionMessages([]);
                setCliSessionMessagesError(undefined);
              }}
              onRefreshMessages={() =>
                selectedCliSession &&
                requestCliSessionMessages(selectedCliSession.id, selectedCliSession.deviceId, true, false)
              }
              onRefreshEnvironment={(projectPath, includeBranchDiff) => {
                if (includeBranchDiff) setWorkspaceEnvironment((current) => current ? { ...current, branchDiff: undefined, branchDiffBase: undefined, branchDiffTruncated: undefined } : current);
                lastAutomaticWorkspaceLoadRef.current = undefined;
                requestWorkspaceEnvironment(projectPath, includeBranchDiff);
              }}
              onRunTerminal={(command, projectPath, terminalId) =>
                sendAction("runWorkspaceTerminalCommand", undefined, { sessionId: selectedCliSession?.id, command, projectPath, terminalId, targetDeviceId: workspaceTargetDeviceId })
              }
              onListTerminals={requestWorkspaceTerminals}
              onCreateTerminal={(profile, projectPath) =>
                sendAction("createWorkspaceTerminal", undefined, { sessionId: selectedCliSession?.id, terminalProfile: profile, projectPath, targetDeviceId: workspaceTargetDeviceId })
              }
              onFocusTerminal={(terminalId) => sendAction("focusWorkspaceTerminal", undefined, { terminalId, targetDeviceId: workspaceTargetDeviceId })}
              onCancelTerminal={(terminalId) => sendAction("cancelWorkspaceTerminalCommand", undefined, { terminalId, targetDeviceId: workspaceTargetDeviceId })}
              onCommitWorkspace={(commitMessage, projectPath) =>
                sendAction("commitWorkspaceChanges", undefined, { sessionId: selectedCliSession?.id, commitMessage, projectPath, confirmed: true, targetDeviceId: workspaceTargetDeviceId })
              }
              onPushWorkspace={(projectPath) =>
                sendAction("pushWorkspaceBranch", undefined, { sessionId: selectedCliSession?.id, projectPath, confirmed: true, targetDeviceId: workspaceTargetDeviceId })
              }
              onClearTerminal={() => dispatchTerminalActivity({ clear: true, deviceId: workspaceTargetDeviceId ?? "local" })}
              onListFiles={(projectPath) =>
                sendAction("listWorkspaceFiles", undefined, {
                  sessionId: selectedCliSession?.id,
                  projectPath,
                  targetDeviceId: workspaceTargetDeviceId
                })
              }
              onReadFile={(filePath, projectPath) =>
                sendAction("readWorkspaceFile", undefined, {
                  filePath,
                  sessionId: selectedCliSession?.id,
                  projectPath,
                  targetDeviceId: workspaceTargetDeviceId
                })
              }
              onClearFile={() => setWorkspaceFilesByPath({})}
              onDeleteFile={(filePath, projectPath) =>
                sendAction("deleteWorkspaceFile", undefined, {
                  filePath,
                  sessionId: selectedCliSession?.id,
                  projectPath,
                  confirmed: true,
                  targetDeviceId: workspaceTargetDeviceId
                })
              }
              onSaveFile={(filePath, fileContent, fileRevision, projectPath) =>
                sendAction("saveWorkspaceFile", undefined, {
                  filePath,
                  fileContent,
                  fileRevision,
                  sessionId: selectedCliSession?.id,
                  projectPath,
                  targetDeviceId: workspaceTargetDeviceId
                })
              }
              onStart={(input) => sendAction("startCodexCliSession", undefined, { ...input, targetDeviceId: selectedPeer?.local ? undefined : selectedPeer?.id })}
              onSteer={(input) => selectedCliSession ? sendAction("steerCodexCliSessionTurn", undefined, { ...input, sessionId: selectedCliSession.id, targetDeviceId: selectedCliSession.deviceId, projectPath: selectedCliSession.projectPath }) : undefined}
              onSend={(input) => {
                if (!selectedCliSession) return;
                const requestId = sendAction("sendCodexCliSessionMessage", undefined, {
                  sessionId: selectedCliSession.id,
                  targetDeviceId: selectedCliSession.deviceId,
                  ...input
                });
                if (requestId) turnRequests.current.set(requestId, selectedCliSession);
                return requestId;
              }}
              onStop={(session) =>
                sendAction("cancelCodexCliSessionTurn", undefined, {
                  sessionId: session.id,
                  targetDeviceId: session.deviceId
                })
              }
              onRename={(name) =>
                selectedCliSession &&
                requestSessionAction("renameCodexCliSession", selectedCliSession, { text: name })
              }
              onFork={() =>
                selectedCliSession &&
                requestSessionAction("forkCodexCliSession", selectedCliSession)
              }
              onCopyLink={() => {
                void navigator.clipboard.writeText(window.location.href).then(
                  () => showCliSessionFeedback({ key: Date.now(), level: "info", message: "Session link copied." }),
                  () =>
                    showCliSessionFeedback({
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
                      () => showCliSessionFeedback({ key: Date.now(), level: "info", message: "Session link shared." }),
                      (error: unknown) =>
                        showCliSessionFeedback({
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
                      showCliSessionFeedback({
                        key: Date.now(),
                        level: "info",
                        message: "Sharing is unavailable, so the session link was copied instead."
                      }),
                    () =>
                      showCliSessionFeedback({
                        key: Date.now(),
                        level: "error",
                        message: "Sharing is unavailable and the link could not be copied."
                      })
                  );
                }
              }}
              onArchive={(session) =>
                requestSessionAction("archiveCodexCliSession", session)
              }
              onOpenInCodex={(session) => requestSessionAction("openCodexCliSession", session)}
              onUnarchive={(session) =>
                requestSessionAction("unarchiveCodexCliSession", session)
              }
              onDelete={(session) =>
                requestSessionAction("deleteCodexCliSession", session, { confirmed: true })
              }
            />,
            document.body
          )
        : null}

      {overviewAccount ? renderAddAccount(false, modals.addAccountModalOpen) : null}

      <ConfirmCancelOauthModal
        open={modals.confirmCancelOauthOpen}
        title={resolveAccountModalTitle(
          snapshot.copy.addAccountModalTitle,
          getSensitiveDisplayValue(modals.reauthorizeEmail, state.privacyMode, "email")
        )}
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

function DashboardMobileActions(props: {
  lang: string;
  privacyMode: boolean;
  privacyToggleLabel: string;
  privacyPending: boolean;
  syncPending: boolean;
  settingsTitle: string;
  passwordRequired: boolean;
  aboutTitle: string;
  onPrivacyToggle: () => void;
  onSync: () => void;
  onSettings: () => void;
  onAbout: () => void;
}) {
  const closeMenu = (event: MouseEvent): void => {
    (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
  };
  const menuLabel = props.lang === "zh" ? "更多操作" : props.lang === "zh-hant" ? "更多操作" : "More actions";
  return (
    <details class="dashboard-mobile-actions">
      <summary class="settings-btn action-btn icon-only settings-alert-trigger" aria-label={menuLabel} title={menuLabel} aria-description={props.passwordRequired ? "Password required" : undefined}>
        <span class="button-face"><span class="button-icon" aria-hidden="true">•••</span></span>
        {props.passwordRequired ? <span class="settings-alert-badge" aria-hidden="true">!</span> : null}
      </summary>
      <div class="dashboard-mobile-actions-menu" role="menu" aria-label={menuLabel}>
        <button type="button" role="menuitem" onClick={(event) => { closeMenu(event); props.onPrivacyToggle(); }} disabled={props.privacyPending}>
          <span aria-hidden="true">{props.privacyMode ? <EyeOffIcon /> : <EyeIcon />}</span>{props.privacyToggleLabel}
        </button>
        <button type="button" role="menuitem" onClick={(event) => { closeMenu(event); props.onSync(); }} disabled={props.syncPending}>
          <span aria-hidden="true">↻</span>Sync now
        </button>
        <button type="button" role="menuitem" onClick={(event) => { closeMenu(event); props.onSettings(); }}>
          <span aria-hidden="true">⚙</span>{props.settingsTitle}
        </button>
        <button type="button" role="menuitem" onClick={(event) => { closeMenu(event); props.onAbout(); }}>
          <span aria-hidden="true"><InfoIcon /></span>{props.aboutTitle}
        </button>
      </div>
    </details>
  );
}

type BrowserConnectionIssue = "unreachable" | "offline";

function BrowserConnectionBanner(props: { stage: BrowserConnectionIssue; lastSyncAt?: number; onRetry: () => void }) {
  const copy = {
    unreachable: ["Dashboard host unavailable", "Displayed data may be stale. Check that VS Code is running."],
    offline: ["Browser reports offline", "The local dashboard may still work; check VS Code and retry."]
  }[props.stage];
  return <aside class={`dashboard-connection-banner is-${props.stage}`} role="alert" aria-live="polite">
    <span class="dashboard-connection-indicator" aria-hidden="true" />
    <span class="dashboard-connection-copy"><strong>{copy[0]}</strong><small>{copy[1]}{props.lastSyncAt ? ` Last update ${new Date(props.lastSyncAt).toLocaleTimeString()}.` : ""}</small></span>
    <button type="button" onClick={props.onRetry}>Retry now</button>
  </aside>;
}

function BrowserConnectionRecovery(props: { stage: "unreachable" | "offline"; onRetry: () => void }) {
  return <div class="dashboard-connection-recovery" role="alert">
    <span class="dashboard-connection-recovery-mark" aria-hidden="true"><img src="/assets/codex.svg" alt="" width="38" height="38" /></span>
    <small>Connection paused</small>
    <h1>{props.stage === "offline" ? "Your browser is offline." : "The dashboard host is unavailable."}</h1>
    <p>Keep VS Code and the Codex Manager extension running to see live sessions and account data. This app never stores that data in its offline cache.</p>
    <button type="button" onClick={props.onRetry}>Try connecting again</button>
  </div>;
}

function CodexRequestDialog(props: {
  request: DashboardCodexServerRequest;
  queuedCount: number;
  busy: boolean;
  error?: string;
  onRespond: (decision: "approve" | "decline", answers?: Record<string, string>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const accessibility = useModalAccessibility(true, () => undefined);
  const isQuestion = props.request.kind === "question";
  const complete = !isQuestion || (props.request.questions ?? []).every((question) => Boolean(answers[question.id]?.trim()));
  return <div class="codex-request-backdrop" role="presentation" onPointerDown={accessibility.onBackdropPointerDown} onMouseDown={accessibility.onBackdropMouseDown} onClick={accessibility.onBackdropClick}>
    <section ref={accessibility.modalRef} onKeyDown={accessibility.onKeyDown} tabIndex={-1} class="codex-request-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-request-title" aria-describedby="codex-request-description">
      <div class="codex-request-eyebrow"><span class="codex-request-pulse" /> Codex needs your input{props.queuedCount > 0 ? ` · ${props.queuedCount} more waiting` : ""}</div>
      <h2 id="codex-request-title">{props.request.title}</h2>
      <p id="codex-request-description">{isQuestion ? "Answer to let Codex continue this turn." : "Review this request before Codex continues. Approval applies to this request only."}</p>
      {props.request.cwd ? <div class="codex-request-cwd" title={props.request.cwd}>Project · {props.request.cwd}</div> : null}
      {props.request.detail ? <pre class="codex-request-detail">{props.request.detail}</pre> : null}
      {props.request.questions?.map((question) => <div class="codex-request-question" key={question.id}>
        <label for={`codex-answer-${question.id}`}><span>{question.header || "Question"}</span><strong>{question.question}</strong></label>
        {question.options?.length ? <select id={`codex-answer-${question.id}`} value={answers[question.id] ?? ""} disabled={props.busy} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.currentTarget.value }))}>
          <option value="">Choose an answer…</option>
          {question.options.map((option) => <option key={option.label} value={option.label}>{option.label}{option.description ? ` — ${option.description}` : ""}</option>)}
        </select> : <input id={`codex-answer-${question.id}`} type={question.isSecret ? "password" : "text"} value={answers[question.id] ?? ""} disabled={props.busy} maxLength={8_000} onInput={(event) => setAnswers((current) => ({ ...current, [question.id]: event.currentTarget.value }))} />}
      </div>)}
      {props.error ? <p class="codex-request-error" role="alert">{props.error}</p> : null}
      <div class="codex-request-actions">
        <button type="button" class="is-secondary" disabled={props.busy} onClick={() => props.onRespond("decline")}>{isQuestion ? "Dismiss question" : "Decline"}</button>
        <button type="button" class="is-primary" disabled={props.busy || !complete} onClick={() => props.onRespond("approve", answers)}>{props.busy ? "Sending…" : isQuestion ? "Send answer" : "Approve once"}</button>
      </div>
    </section>
  </div>;
}

function sortAccounts(
  accounts: DashboardAccountViewModel[],
  sort: AccountSort,
  metricPriority: MetricPriority,
  capabilityThresholds: AutoQueuePolicy,
  registryOverrideEnabled = false
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
  const compareAutoQueue = (left: DashboardAccountViewModel, right: DashboardAccountViewModel): number => {
    const leftOwned = canRunAccountOnThisPc(left, false, registryOverrideEnabled);
    const rightOwned = canRunAccountOnThisPc(right, false, registryOverrideEnabled);
    const leftEligible = leftOwned && hasDashboardAutoQueueCapability(left, capabilityThresholds);
    const rightEligible = rightOwned && hasDashboardAutoQueueCapability(right, capabilityThresholds);
    if (leftEligible !== rightEligible) return leftEligible ? -1 : 1;
    if (leftOwned !== rightOwned) return leftOwned ? -1 : 1;
    return compareDashboardAutoQueueAccounts(left, right, capabilityThresholds);
  };

  if (sort === "auto-queue") {
    return sortWithQueuedAccount(accounts, compareAutoQueue, false);
  }

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
      return compareDashboardQuotaBalance(left, right, metricPriority);
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

function PcPickerControl(props: {
  peers: DashboardPeerView[];
  accountsByPeerId: Record<string, DashboardAccountViewModel[]>;
  selectedPeerId: string;
  lang: string;
  privacyMode: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onChange: (peerId: string) => void;
  onOpenBrowser?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
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
  const pickerLabel = isZh ? "切换系统面板" : isHant ? "切換系統面板" : "Switch system dashboard";
  const peerName = (peer: DashboardPeerView): string => {
    const name = peer.name.trim() || (peer.local ? localLabel : pickerLabel);
    return getSensitiveDisplayValue(name, props.privacyMode, "name");
  };
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
    const frame = window.requestAnimationFrame(() => (popoverRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? popoverRef.current?.querySelector<HTMLButtonElement>('[role="option"]'))?.focus());
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
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
      if (event.key === "Escape") { props.onClose(); triggerRef.current?.focus(); }
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
        ref={triggerRef}
        id="codexDashboardButton"
        type="button"
        class={`settings-btn action-btn icon-only ${props.open ? "is-active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={props.open}
        aria-label={pickerLabel}
        title={pickerLabel}
        onClick={props.onToggle}
      >
        <span class="button-face"><span class="button-icon"><GridViewIcon /></span></span>
        <span class="cli-running-count dashboard-system-count" aria-label={`${props.peers.length} systems`}>{props.peers.length}</span>
      </button>
      {props.open
        ? createPortal(
            <div
              ref={popoverRef}
              class="dashboard-pc-picker-popover"
              role="dialog"
              aria-label={pickerLabel}
              onKeyDown={(event) => {
                const options = Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
                const index = options.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === "ArrowDown" ? (index + 1) % options.length : event.key === "ArrowUp" ? (index - 1 + options.length) % options.length : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : undefined;
                if (next !== undefined) { event.preventDefault(); options[next]?.focus(); }
              }}
              style={{ top: `${popoverPosition.top}px`, left: `${popoverPosition.left}px` }}
            >
              <div role="listbox" aria-label={pickerLabel}>
              <div class="dashboard-pc-picker-heading">
                {isZh ? "系统面板" : isHant ? "系統面板" : "System dashboards"}
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
                    triggerRef.current?.focus();
                  }}
                >
                  <span class={`dashboard-pc-picker-status ${peer.connected ? "is-online" : ""}`} aria-hidden="true" />
                  <span class="dashboard-pc-picker-copy">
                    <strong>{peerName(peer)}</strong>
                    <small title={peerStatus(peer)}>{peerStatus(peer)}</small>
                  </span>
                </button>
              ))}
              </div>
              {props.onOpenBrowser ? <button type="button" class="cli-sessions-manage" onClick={() => { props.onClose(); props.onOpenBrowser?.(); }}>Open dashboard in browser <span aria-hidden="true">↗</span></button> : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function CliSessionsMenu(props: {
  autoResumeEnabled: boolean;
  onAutoResume: (session: DashboardCliSessionSummary, enabled: boolean) => void;
  onQueue: (session: DashboardCliSessionSummary, enabled: boolean, priority?: 1 | 2 | 3) => void;
  browser: boolean;
  sessions: DashboardCliSessionSummary[];
  peers: DashboardPeerView[];
  ready: boolean;
  error?: string;
  connected: boolean;
  loading: boolean;
  actionPending: boolean;
  onOpen: (session: DashboardCliSessionSummary) => void;
  lang: string;
  privacyMode: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRetry: () => void;
  onManage: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });
  const [now, setNow] = useState(Date.now());
  const isZh = props.lang === "zh";
  const isHant = props.lang === "zh-hant";
  const menuLabel = isZh ? "运行中的会话" : isHant ? "執行中的工作階段" : "Running sessions";
  const manageLabel = isZh ? "会话面板" : isHant ? "工作階段面板" : "Session dashboard";
  const runningCount = props.sessions.filter(session => session.status === "running" && (!session.remote || props.peers.some(peer => peer.id === session.deviceId && peer.connected))).length;

  useEffect(() => {
    if (!props.open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const updatePosition = (): void => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const width = Math.min(380, window.innerWidth - 16);
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
        class={`settings-btn action-btn icon-only cli-sessions-entry ${runningCount > 0 ? "has-running" : ""} ${props.open ? "is-active" : ""}`}
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
        <span class="cli-running-count" aria-label={`${runningCount} running sessions`}>
            {runningCount}
        </span>
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
              <div class="cli-sessions-popover-heading">{menuLabel} · {runningCount}{props.sessions.length > runningCount ? ` · ${props.sessions.length - runningCount} interrupted` : ""}</div>
              {props.error || !props.connected || (!props.ready && props.sessions.length > 0) ? <div class="cli-sessions-list-status" role="status">{props.error ? "Sessions could not refresh. Saved results may be out of date." : !props.connected ? "Connection lost. Running status may be out of date." : "Saved sessions. Checking running status…"}<button type="button" onClick={props.onRetry} disabled={props.loading}>{props.loading ? "Refreshing…" : "Retry"}</button></div> : null}
              <div class="cli-sessions-running-list" role="list" aria-busy={props.loading}>
                {props.sessions.length === 0 ? <p class="cli-sessions-empty" role="status">{props.error ? "Running sessions are unavailable." : !props.connected ? "Reconnect to check running sessions." : !props.ready ? "Loading running sessions…" : "No running sessions."}</p> : null}
                {props.sessions.map((session) => {
                  const peer = props.peers.find(peer => session.remote ? peer.id === session.deviceId : peer.local);
                  const system = getSensitiveDisplayValue(session.deviceName || peer?.name || (session.remote ? "Remote PC" : "This PC"), props.privacyMode, "name");
                  const project = projectDisplayName(session.projectPath?.trim() || "Workspace");
                  const time = typeof session.runningSince === "number" && Number.isFinite(session.runningSince) && session.runningSince > 0 && session.runningSince <= now + 5 * 60_000 ? formatElapsed(Math.max(0, now - session.runningSince)) : "Time unavailable";
                  const detail = `Goal: ${session.goal?.objective || (session.goal === null ? "No goal" : "Unavailable")}\nThinking: ${session.reasoningEffort || "Unavailable"}`;
                  const running = session.status === "running";
                  const destination = running && props.browser ? "browser" : "VS Code";
                  const offline = session.remote && !props.peers.some(peer => peer.id === session.deviceId && peer.connected);
                  return <article class="cli-sessions-running-row" role="listitem" key={cliSessionTargetKey(session)} title={`${session.title}\n${detail}`}>
                    <div class="cli-sessions-running-copy">
                    <strong class="cli-sessions-running-title">{session.title}</strong>
                    <small class="cli-session-row-meta"><span title={system}>{system}</span><span aria-hidden="true">·</span><span title={project}>{project}</span><span aria-hidden="true">·</span><span class="cli-sessions-running-time" aria-label={running ? `Running time: ${time}` : "Interrupted"}>{running ? time : "Interrupted"}</span><span aria-hidden="true">·</span><span title={session.model}>{session.model || "Model unavailable"}</span></small>
                    </div>
                    <div class="cli-running-row-actions">
                    {running ? <button type="button" class={`cli-icon-button ${props.autoResumeEnabled && session.autoResumeEnabled !== false ? "is-active" : ""}`} aria-pressed={props.autoResumeEnabled && session.autoResumeEnabled !== false} aria-label={`Auto Resume for ${session.title}`} title={!props.autoResumeEnabled ? "Auto Resume is off globally" : session.autoResumeEnabled === false ? "Enable Auto Resume" : "Disable Auto Resume"} disabled={!props.connected || !props.autoResumeEnabled || offline || props.actionPending} onClick={() => props.onAutoResume(session, session.autoResumeEnabled === false)}><AutoResumeIcon enabled={props.autoResumeEnabled && session.autoResumeEnabled !== false} goal={!!session.goal} /></button> : <details class="cli-running-queue"><summary aria-label={`Queue priority for ${session.title}`} title="Queue after other sessions finish"><QueueIcon enabled={session.queueEnabled === true} />{session.queueEnabled ? <small>{session.queuePriority ?? 3}</small> : null}</summary><div class="cli-session-queue-menu"><strong>Run after other work</strong>{session.queueError ? <p role="status" class="settings-note">{session.queueError}</p> : null}{([1,2,3] as const).map(priority => <button type="button" disabled={!props.connected || offline || props.actionPending} aria-pressed={session.queueEnabled && session.queuePriority === priority} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); props.onQueue(session, true, priority); }}>Priority {priority}<small>{priority === 1 ? "First" : priority === 2 ? "Next" : "Last"}</small></button>)}<button type="button" disabled={!props.connected || offline || props.actionPending || !session.queueEnabled} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); props.onQueue(session, false); }}>Remove from queue</button></div></details>}
                    <button type="button" class="cli-icon-button" disabled={(!running && !props.connected) || props.actionPending || session.status === "unknown" || offline} aria-label={`${running ? "View" : "Resume"} ${session.title} in ${destination}`} title={offline ? "System offline" : session.status === "unknown" ? "Refresh to verify this session" : running ? `View in ${destination}` : "Resume in VS Code"} onClick={() => props.onOpen(session)}>{running ? <EyeIcon /> : <span aria-hidden="true">↻</span>}</button></div>
                  </article>;
                })}
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

function downloadInBrowser(file: { filename: string; text: string }): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: "application/json" }));
  try {
    const link = document.createElement("a");
    link.href = url; link.download = file.filename; link.click();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1_000); }
}
