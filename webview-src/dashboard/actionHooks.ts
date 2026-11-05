import { chatUploadTimeoutMs } from "../../src/domain/chatAttachments";
import { useCallback, useEffect, useRef } from "preact/hooks";
import type { DashboardActionName, DashboardNotice, DashboardSettingKey, DashboardSettings } from "../../src/domain/dashboard/types";
import { noticeFromActionTimeout } from "./actionFeedback";
import { createActionRequestId, getActionTimeoutMs, isAutomaticRequest, postMessageToHost } from "./host";
import type { AppDispatch, SendAction } from "./hookTypes";
import { readBrowserCache, writeBrowserCache, deleteBrowserCache } from './cliSessionCache';
import { OFFLINE_CACHE_READS, offlineReadCacheKey } from './offlinePolicy';
import type { DashboardHostMessage, DashboardActionResultPayload } from '../../src/domain/dashboard/types';
import type { AppState } from "./state";

export function useDashboardActions(
  state: AppState,
  dispatch: AppDispatch,
  onNotice: (notice: DashboardNotice) => void,
  targetDeviceId?: string,
  onActionTimeout?: (action: DashboardActionName, requestId: string) => void,
  connected = true,
  onCachedRead?: (action: DashboardActionName, payload: DashboardActionResultPayload, requestId: string) => void
) {
  const connection = useRef(connected); connection.current = connected;
  const snapshot = useRef(state.snapshot); snapshot.current = state.snapshot;
  const cachedRead = useRef(onCachedRead); cachedRead.current = onCachedRead;
  const readRequests = useRef(new Map<string, string>());
  const latestReads = useRef(new Map<string, string>());
  const fileMutations = useRef(new Map<string, { fileKey: string; treeKey: string }>());
  useEffect(() => {
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const result = event.data; if (result?.type !== 'dashboard:action-result') return;
      const mutation = fileMutations.current.get(result.requestId);
      fileMutations.current.delete(result.requestId);
      if (mutation && result.status === 'completed') {
        latestReads.current.delete(mutation.fileKey); latestReads.current.delete(mutation.treeKey);
        if (result.payload?.workspaceFile) void writeBrowserCache(mutation.fileKey, { workspaceFile: result.payload.workspaceFile });
        else void deleteBrowserCache(mutation.fileKey);
        if (result.payload?.workspaceFiles) void writeBrowserCache(mutation.treeKey, { workspaceFiles: result.payload.workspaceFiles, workspaceFilesWarning: result.payload.workspaceFilesWarning });
        else void deleteBrowserCache(mutation.treeKey);
      }
      const key = readRequests.current.get(result.requestId); if (!key) return;
      readRequests.current.delete(result.requestId);
      if (latestReads.current.get(key) !== result.requestId) return;
      latestReads.current.delete(key);
      if (result.status === 'completed' && result.payload) void writeBrowserCache(key, { ...result.payload, notice: undefined });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  const actionTimeoutsRef = useRef<Map<string, number>>(new Map());
  const onActionTimeoutRef = useRef(onActionTimeout);
  onActionTimeoutRef.current = onActionTimeout;
  const actionFeedbackRef = useRef({ onNotice, accountCount: state.snapshot?.accounts.length ?? 1 });
  actionFeedbackRef.current = { onNotice, accountCount: state.snapshot?.accounts.length ?? 1 };

  useEffect(() => {
    const update = () => { if (document.visibilityState === "visible") dispatch({ type: "tick", now: Date.now() }); };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [dispatch]);

  useEffect(() => {
    const activeRequestIds = new Set(state.pendingActions.map((request) => request.requestId));

    state.pendingActions.forEach((request) => {
      if (actionTimeoutsRef.current.has(request.requestId)) {
        return;
      }

      const timeoutId = window.setTimeout(() => {
        const key = readRequests.current.get(request.requestId);
        if (key && latestReads.current.get(key) === request.requestId) latestReads.current.delete(key);
        readRequests.current.delete(request.requestId);
        fileMutations.current.delete(request.requestId);
        dispatch({ type: "resolve-action", requestId: request.requestId });
        if (!isAutomaticRequest(request.requestId) && request.action !== "getDailyUsage" && request.action !== "getUsageGraph" && request.action !== "listCodexCliSessions") onNotice(noticeFromActionTimeout(request.action));
        onActionTimeoutRef.current?.(request.action, request.requestId);
      }, request.timeoutMs ?? getActionTimeoutMs(request.action));

      actionTimeoutsRef.current.set(request.requestId, timeoutId);
    });

    actionTimeoutsRef.current.forEach((timeoutId, requestId) => {
      if (activeRequestIds.has(requestId)) {
        return;
      }

      window.clearTimeout(timeoutId);
      actionTimeoutsRef.current.delete(requestId);
      const key = readRequests.current.get(requestId);
      if (key && latestReads.current.get(key) === requestId) latestReads.current.delete(key);
      readRequests.current.delete(requestId);
      fileMutations.current.delete(requestId);
    });
  }, [dispatch, isAutomaticRequest, onNotice, state.pendingActions]);

  useEffect(() => {
    return () => {
      actionTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      actionTimeoutsRef.current.clear();
    };
  }, []);

  const patchSettings = useCallback((patch: Partial<DashboardSettings>): void => {
    dispatch({ type: "settings-patch", patch });
  }, [dispatch]);

  const sendAction = useCallback<SendAction>((action, accountId, payload) => {
    const requestId = createActionRequestId(payload?.automatic);
    const routedPayload = action === 'setPrivacyMode' || action === 'setCrossPcSyncEnabled' ? { ...payload, targetDeviceId: undefined } : payload && Object.hasOwn(payload, 'targetDeviceId') ? payload : { ...payload, targetDeviceId: targetDeviceId && targetDeviceId !== 'local' && !snapshot.current?.connectedPeers?.some(item => item.id === targetDeviceId && item.local) ? targetDeviceId : undefined };
    const peer = routedPayload?.targetDeviceId && routedPayload.targetDeviceId !== 'local'
      ? snapshot.current?.connectedPeers?.find(item => item.id === routedPayload.targetDeviceId) : undefined;
    dispatch({
      type: "request-action",
      request: {
        requestId,
        action,
        accountId,
        requestedAt: Date.now(),
        ...(accountId && (action === 'setAccountTags' || action === 'setAccountQueuePriority' || action === 'toggleAccountEnabled') ? { accountEdit: { deviceId: routedPayload?.targetDeviceId && routedPayload.targetDeviceId !== 'local' && !peer?.local ? routedPayload.targetDeviceId : undefined, patch: action === 'setAccountTags' ? { tags: payload?.tags } : action === 'setAccountQueuePriority' ? { queuePriority: payload?.queuePriority === true } : { enabled: payload?.enabled === true } } } : {}),
        timeoutMs: Math.max(getActionTimeoutMs(action, payload?.accountIds?.length ?? (peer && !peer.local ? snapshot.current?.peerAccounts?.[peer.id]?.length : undefined) ?? actionFeedbackRef.current.accountCount), chatUploadTimeoutMs(payload?.attachments ?? payload?.task?.uploads ?? payload?.comment?.uploads))
      }
    });
    const localSystemId = snapshot.current?.connectedPeers?.find(item => item.local)?.id;
    const cacheKey = OFFLINE_CACHE_READS.has(action) && (localSystemId || peer?.id)
      ? offlineReadCacheKey(action, accountId, routedPayload, localSystemId) : undefined;
    if (!connection.current || peer?.connected === false) {
      const key = cacheKey;
      void (key ? readBrowserCache<DashboardActionResultPayload>(key) : Promise.resolve(undefined)).then(cached => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action, accountId, requestId,
          status: cached ? 'completed' : 'failed', ...(cached ? { payload: { ...cached, notice: { level: 'warning', message: 'Offline saved view. Reconnect to verify the latest state.' } } } : { error: 'The host is offline. This operation was not sent or queued. Reconnect and retry.' }) } }));
      });
      return requestId;
    }
    if (cacheKey) {
      readRequests.current.set(requestId, cacheKey);
      latestReads.current.set(cacheKey, requestId);
      if (cachedRead.current) void readBrowserCache<DashboardActionResultPayload>(cacheKey).then(saved => {
        if (saved && readRequests.current.has(requestId) && latestReads.current.get(cacheKey) === requestId) cachedRead.current?.(action, saved, requestId);
      });
    }
    if ((action === 'saveWorkspaceFile' || action === 'deleteWorkspaceFile') && (localSystemId || peer?.id)) {
      const fileKey = offlineReadCacheKey('readWorkspaceFile', undefined, routedPayload, localSystemId);
      const treeKey = offlineReadCacheKey('listWorkspaceFiles', undefined, { ...routedPayload, filePath: undefined }, localSystemId);
      latestReads.current.delete(fileKey); latestReads.current.delete(treeKey);
      fileMutations.current.set(requestId, { fileKey, treeKey });
    }
    try {
      postMessageToHost({
        type: "dashboard:action",
        action,
        accountId,
        requestId,
        payload: routedPayload
      });
    } catch (error) {
      const detail = `The action could not be sent: ${error instanceof Error ? error.message : String(error)}`;
      queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", { data: {
        type: "dashboard:action-result", action, accountId, requestId, status: "failed", error: detail
      } })));
    }
    return requestId;
  }, [dispatch, targetDeviceId]);

  const sendSetting = useCallback((key: DashboardSettingKey, value: string | number | boolean): void => {
    if (!connection.current) { actionFeedbackRef.current.onNotice({ level: 'warning', message: 'Reconnect before changing host settings. This setting was not queued.' }); return; }
    postMessageToHost({
      type: "dashboard:setting",
      key,
      value
    });
  }, []);

  const isActionPending = (action: DashboardActionName, accountId?: string): boolean =>
    state.pendingActions.some((request) => request.action === action && request.accountId === accountId);

  return {
    patchSettings,
    sendAction,
    sendSetting,
    isActionPending,
  };
}
