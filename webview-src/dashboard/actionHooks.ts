import { useCallback, useEffect, useRef } from "preact/hooks";
import type { DashboardActionName, DashboardNotice, DashboardSettingKey, DashboardSettings } from "../../src/domain/dashboard/types";
import { noticeFromActionTimeout } from "./actionFeedback";
import { createActionRequestId, getActionTimeoutMs, isAutomaticRequest, postMessageToHost } from "./host";
import type { AppDispatch, SendAction } from "./hookTypes";
import type { AppState } from "./state";

export function useDashboardActions(
  state: AppState,
  dispatch: AppDispatch,
  onNotice: (notice: DashboardNotice) => void,
  targetDeviceId?: string,
  onActionTimeout?: (action: DashboardActionName, requestId: string) => void
) {
  const actionTimeoutsRef = useRef<Map<string, number>>(new Map());
  const onActionTimeoutRef = useRef(onActionTimeout);
  onActionTimeoutRef.current = onActionTimeout;
  const actionFeedbackRef = useRef({ onNotice, accountCount: state.snapshot?.accounts.length ?? 1 });
  actionFeedbackRef.current = { onNotice, accountCount: state.snapshot?.accounts.length ?? 1 };

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") dispatch({ type: "tick", now: Date.now() });
    }, 30_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [dispatch]);

  useEffect(() => {
    const activeRequestIds = new Set(state.pendingActions.map((request) => request.requestId));

    state.pendingActions.forEach((request) => {
      if (actionTimeoutsRef.current.has(request.requestId)) {
        return;
      }

      const timeoutId = window.setTimeout(() => {
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
    dispatch({
      type: "request-action",
      request: {
        requestId,
        action,
        accountId,
        requestedAt: Date.now(),
        timeoutMs: getActionTimeoutMs(action, payload?.accountIds?.length ?? actionFeedbackRef.current.accountCount)
      }
    });
    try {
      postMessageToHost({
        type: "dashboard:action",
        action,
        accountId,
        requestId,
        payload: action === "setPrivacyMode" || action === "setCrossPcSyncEnabled"
          ? payload
          : payload && Object.hasOwn(payload, "targetDeviceId")
            ? payload
            : targetDeviceId && targetDeviceId !== "local"
              ? { ...(payload ?? {}), targetDeviceId }
              : payload
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
