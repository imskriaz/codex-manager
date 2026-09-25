(() => {
  let realtimeSocket;
  let connectingSocket;
  let reconnectTimer;
  let reconnectDelayMs = 500;
  const maxReconnectDelayMs = 5000;
  let lastSyncAt;
  let lastProbeAt = 0;
  let snapshotInFlight;
  const pendingSocketActions = new Map();

  const dispatch = (message) => {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  };

  const isBrowserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
  const publishStatus = (stage, retryInMs) => {
    dispatch({
      type: "dashboard:host-status",
      stage: stage === "unreachable" && isBrowserOffline() ? "offline" : stage,
      ...(lastSyncAt ? { lastSyncAt } : {}),
      ...(retryInMs ? { retryInMs } : {})
    });
  };

  const parseJsonResponse = async (response, label) => {
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error(`${label} returned an invalid response. Reload the dashboard and sign in again.`);
    }
    return response.json();
  };

  const loadSnapshot = () => {
    if (snapshotInFlight) return snapshotInFlight;
    snapshotInFlight = (async () => {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (response.status === 401) {
        window.location.reload();
        return false;
      }
      if (!response.ok) throw new Error(`Dashboard refresh failed (${response.status})`);
      const state = await parseJsonResponse(response, "Dashboard refresh");
      lastSyncAt = Date.now();
      dispatch({ type: "dashboard:snapshot", state });
      publishStatus(realtimeSocket ? "live" : "degraded");
      return true;
    })().catch((error) => {
      publishStatus("unreachable");
      throw error;
    }).finally(() => { snapshotInFlight = undefined; });
    return snapshotInFlight;
  };

  const failUnconfirmedSocketActions = () => {
    for (const [requestId, action] of pendingSocketActions) {
      dispatch({
        type: "dashboard:action-result",
        requestId,
        action: action.action,
        accountId: action.accountId,
        status: "failed",
        error: "The connection closed before this action was confirmed. Its outcome is unknown; reconnect and verify before retrying."
      });
    }
    pendingSocketActions.clear();
  };

  const scheduleReconnect = () => {
    if (reconnectTimer !== undefined) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxReconnectDelayMs);
    publishStatus("reconnecting", delay);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connectRealtime();
    }, delay);
  };

  const connectRealtime = () => {
    if (connectingSocket || realtimeSocket) return;
    if (typeof window.WebSocket !== "function") {
      dispatch({ type: "dashboard:connection", transport: "websocket", connected: false });
      publishStatus(lastSyncAt ? "degraded" : "connecting");
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    try {
      socket = new window.WebSocket(`${protocol}//${window.location.host}/ws`);
    } catch (error) {
      console.warn("[codex-manager] realtime connection could not start", error);
      scheduleReconnect();
      return;
    }
    connectingSocket = socket;
    socket.addEventListener("open", () => {
      if (connectingSocket !== socket) return;
      connectingSocket = undefined;
      realtimeSocket = socket;
      reconnectDelayMs = 500;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      dispatch({ type: "dashboard:connection", transport: "websocket", connected: true });
      publishStatus("live");
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (!message?.type) return;
        if (message.type === "dashboard:action-result") pendingSocketActions.delete(message.requestId);
        if (message.type === "dashboard:snapshot") {
          lastSyncAt = Date.now();
          publishStatus("live");
        }
        dispatch(message);
      } catch (error) {
        console.error("[codex-manager] realtime dashboard message", error);
      }
    });
    socket.addEventListener("close", (event) => {
      if (realtimeSocket !== socket && connectingSocket !== socket) return;
      if (realtimeSocket === socket) realtimeSocket = undefined;
      if (connectingSocket === socket) connectingSocket = undefined;
      dispatch({ type: "dashboard:connection", transport: "websocket", connected: false });
      failUnconfirmedSocketActions();
      if (event.code === 4001) {
        window.location.reload();
        return;
      }
      scheduleReconnect();
      if (Date.now() - lastProbeAt >= 15_000) {
        lastProbeAt = Date.now();
        void loadSnapshot().catch(() => undefined);
      }
    });
    // A close event follows an error. Closing here can re-enter Chromium's
    // failure dispatch, so the close handler owns retry and action cleanup.
    socket.addEventListener("error", () => undefined);
  };

  const postMessage = async (message) => {
    if (message?.type === "dashboard:ready" || message?.type === "dashboard:retry-connection") {
      const manual = message.type === "dashboard:retry-connection";
      if (manual && !realtimeSocket) {
        if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        publishStatus("connecting");
        connectRealtime();
      }
      try {
        const loaded = await loadSnapshot();
        if (manual && loaded) dispatch({
          type: "dashboard:notice",
          level: realtimeSocket ? "info" : "warning",
          message: realtimeSocket ? "Dashboard reconnected and live updates resumed." : "Dashboard responded. Live updates are still reconnecting."
        });
      } catch (error) {
        console.error("[codex-manager] dashboard refresh", error);
        if (manual) dispatch({ type: "dashboard:notice", level: "error", message: "Dashboard is still unavailable. Check VS Code and try again." });
      }
      return;
    }
    let reachedHost = false;
    try {
      if (realtimeSocket && realtimeSocket.readyState === window.WebSocket.OPEN) {
        if (message?.type === "dashboard:action" && message.requestId) pendingSocketActions.set(message.requestId, message);
        realtimeSocket.send(JSON.stringify(message));
        return;
      }
      const response = await fetch("/api/message", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Dashboard": "1"
        },
        body: JSON.stringify(message)
      });
      reachedHost = true;
      if (response.status === 401) {
        window.location.reload();
        return;
      }
      if (!response.ok) throw new Error(`Dashboard action failed (${response.status})`);
      const payload = await parseJsonResponse(response, "Dashboard action");
      if (!Array.isArray(payload.messages)) throw new Error("Dashboard action returned no result. Reload the dashboard and try again.");
      publishStatus("degraded");
      payload.messages.forEach(dispatch);
    } catch (error) {
      if (!reachedHost) publishStatus("unreachable");
      console.error("[codex-manager] browser dashboard bridge", error);
      const detail = error instanceof Error ? error.message : "The dashboard action failed. Please try again.";
      if (message?.type === "dashboard:action") {
        pendingSocketActions.delete(message.requestId);
        dispatch({
          type: "dashboard:action-result",
          requestId: message.requestId,
          action: message.action,
          accountId: message.accountId,
          status: "failed",
          error: detail
        });
      }
      dispatch({ type: "dashboard:notice", level: "error", message: detail });
    }
  };

  window.acquireVsCodeApi = () => ({
    postMessage,
    getState: () => undefined,
    setState: () => undefined
  });

  if (typeof window.addEventListener === "function") {
    window.addEventListener("online", () => {
      if (realtimeSocket) return;
      publishStatus("connecting");
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      connectRealtime();
      void loadSnapshot().catch(() => undefined);
    });
    window.addEventListener("offline", () => {
      if (!realtimeSocket) publishStatus("unreachable");
    });
  }

  if (typeof navigator !== "undefined" && navigator.serviceWorker && typeof document !== "undefined") {
    const currentScriptUrl = document.currentScript?.src;
    const version = currentScriptUrl ? new URL(currentScriptUrl).searchParams.get("v") : undefined;
    const workerUrl = version ? `/service-worker.js?v=${encodeURIComponent(version)}` : "/service-worker.js";
    const register = () => {
      void navigator.serviceWorker.register(workerUrl, { scope: "/", updateViaCache: "none" })
        .catch((error) => console.warn("[codex-manager] offline shell unavailable", error));
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }

  publishStatus("connecting");
  connectRealtime();
})();
