(() => {
  let realtimeSocket;
  let connectingSocket;
  let handshakeTimer;
  let reconnectTimer;
  let reconnectDelayMs = 500;
  const maxReconnectDelayMs = 5000;
  let lastSyncAt;
  let lastProbeAt = 0;
  let snapshotInFlight;
  let retryInFlight;
  let latestSnapshot;
  const startupLive = new Map();
  let startupPrompts;
  let dashboardReady = false;
  let snapshotRevision = 0;
  let sourceSystemId;
  let sourceGeneration = 0;
  const hostStartedAt = Date.now();
  let socketOpenedAt;
  let firstLiveAt;
  let reconnectStartedAt;
  let reconnectMs;
  const retiredSourceRequests = new Set();
  let authenticationRequired = false;
  const pendingSocketActions = new Map();
  const pendingHttpActions = new Set();
  const baseRequestTimeoutMs = (message) => ["startCodexCliSession", "sendCodexCliSessionMessage", "startProjectTask", "startProjectSubtask"].includes(message?.action)
    ? 15 * 60_000 + 15_000
    : ["addAccount", "importCurrent", "startOAuthAutoFlow"].includes(message?.action)
      ? 10 * 60_000 + 30_000
      : ["refreshAll", "batchRefresh", "batchResyncProfile", "batchSetAccountAutoResetAllowed"].includes(message?.action)
        ? (message.action === "batchSetAccountAutoResetAllowed" ? 30_000 : message.action === "batchResyncProfile" ? 300_000 : 240_000) * Math.max(1, message.payload?.accountIds?.length || peerAccountCounts.get(message.payload?.targetDeviceId) || lastAccountCount) + 15_000
        : ["generateApiToken","listApiTokens","revokeApiToken"].includes(message?.action) ? 20_000 : message?.action === "workspaceTerminal" ? 10_000 : message?.action === "refreshView" ? 8_000 : message?.action === "resyncProfile" ? 315_000 : message?.action === "refresh" ? 255_000 : 135_000;
  const requestTimeoutMs = (message) => {
    const files = message?.payload?.attachments ?? message?.payload?.task?.uploads ?? message?.payload?.comment?.uploads;
    const bytes = Array.isArray(files) ? files.reduce((sum, file) => sum + (Number.isFinite(file?.size) ? Math.max(0,file.size) : 0),0) : 0;
    return Math.max(baseRequestTimeoutMs(message), bytes > 1024 * 1024 ? 300000 : 0);
  };
  let lastAccountCount = 1;
  const peerAccountCounts = new Map();
  const forgetSocketAction = (requestId) => {
    const pending = pendingSocketActions.get(requestId);
    if (pending?.timer !== undefined) window.clearTimeout?.(pending.timer);
    pendingSocketActions.delete(requestId);
  };

  const dispatch = (message) => {
    if (message?.type === "dashboard:action-result" && retiredSourceRequests.has(message.requestId)) return;
    if (message?.type === "dashboard:snapshot") {
      const nextSystem = message.state?.connectedPeers?.find(peer => peer.local)?.id;
      if (nextSystem && sourceSystemId && nextSystem !== sourceSystemId) {
        sourceGeneration++;
        startupLive.clear();
        startupPrompts = undefined;
        const retired = [...pendingSocketActions.keys()];
        failUnconfirmedSocketActions();
        for (const id of retired) retiredSourceRequests.add(id);
        while (retiredSourceRequests.size > 256) retiredSourceRequests.delete(retiredSourceRequests.values().next().value);
      }
      if (nextSystem) sourceSystemId = nextSystem;
      if (message !== latestSnapshot) snapshotRevision++;
      // Retain only the startup replay; IndexedDB owns subsequent recovery data.
      if (!dashboardReady) latestSnapshot = message;
      lastAccountCount = message.state?.accounts?.length || 1;
      peerAccountCounts.clear();
      for (const [id, accounts] of Object.entries(message.state?.peerAccounts || {})) peerAccountCounts.set(id, accounts.length);
    }
    if (!dashboardReady && message?.type === 'dashboard:codex-session-live') {
      const key = `${message.state?.deviceId ?? 'local'}:${message.state?.sessionId}`;
      startupLive.delete(key);
      startupLive.set(key, message);
      while (startupLive.size > 30) startupLive.delete(startupLive.keys().next().value);
    }
    if (!dashboardReady && message?.type === 'dashboard:codex-requests') startupPrompts = message;
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  };

  const isBrowserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false && !['localhost','127.0.0.1','[::1]'].includes(window.location?.hostname);
  const publishStatus = (stage, retryInMs) => {
    const timings = {};
    if (socketOpenedAt !== undefined) timings.socketMs = Math.max(0, socketOpenedAt - hostStartedAt);
    if (firstLiveAt !== undefined) timings.firstLiveMs = Math.max(0, firstLiveAt - hostStartedAt);
    if (reconnectMs !== undefined) timings.reconnectMs = reconnectMs;
    dispatch({
      type: "dashboard:host-status",
      stage: stage === "unreachable" && isBrowserOffline() ? "offline" : stage,
      ...(lastSyncAt ? { lastSyncAt } : {}),
      ...(Object.keys(timings).length ? { timings } : {}),
      ...(retryInMs ? { retryInMs } : {})
    });
  };

  const isRealtimeOpen = () => Boolean(realtimeSocket && realtimeSocket.readyState === window.WebSocket?.OPEN);
  const publishConnection = () => dispatch({ type: "dashboard:connection", transport: "websocket", connected: Boolean(isRealtimeOpen()) });
  const clearHandshake = () => {
    if (handshakeTimer !== undefined) window.clearTimeout?.(handshakeTimer);
    handshakeTimer = undefined;
  };
  const resetConnectingSocket = () => {
    const pending = connectingSocket;
    connectingSocket = undefined;
    clearHandshake();
    try { pending?.close(); } catch { /* Already disconnected. */ }
  };
  const fetchSnapshot = async () => {
    const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
    const timer = controller ? window.setTimeout(() => controller.abort(), 10_000) : undefined;
    try {
      const response = await fetch("/api/state", { cache: "no-store", ...(controller ? { signal: controller.signal } : {}) });
      const state = response.ok ? await parseJsonResponse(response, "Dashboard refresh") : undefined;
      return { response, state };
    } finally { if (timer !== undefined) window.clearTimeout(timer); }
  };

  const parseJsonResponse = async (response, label) => {
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error(`${label} returned an invalid response. Reload the dashboard and sign in again.`);
    }
    return response.json();
  };

  const loadSnapshot = () => {
    if (authenticationRequired) return Promise.resolve(false);
    if (snapshotInFlight) return snapshotInFlight;
    const revision = snapshotRevision;
    snapshotInFlight = (async () => {
      const { response, state } = await fetchSnapshot();
      if (authenticationRequired) return false;
      if (response.status === 401) {
        requireSignIn();
        return false;
      }
      if (!response.ok) throw new Error(`Dashboard refresh failed (${response.status})`);
      lastSyncAt = Date.now();
      if (revision === snapshotRevision) dispatch({ type: "dashboard:snapshot", state });
      publishConnection();
      publishStatus(isRealtimeOpen() ? "live" : "degraded");
      return true;
    })().catch((error) => {
      publishStatus(isRealtimeOpen() ? "live" : "unreachable");
      throw error;
    }).finally(() => { snapshotInFlight = undefined; });
    return snapshotInFlight;
  };

  const failUnconfirmedSocketActions = () => {
    for (const [requestId, pending] of pendingSocketActions) {
      const action = pending.message;
      forgetSocketAction(requestId);
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

  const requireSignIn = () => {
    if (authenticationRequired) return;
    authenticationRequired = true;
    latestSnapshot = undefined;
    startupLive.clear();
    startupPrompts = undefined;
    resetConnectingSocket();
    const active = realtimeSocket;
    realtimeSocket = undefined;
    try { active?.close(); } catch { /* Already disconnected. */ }
    if (reconnectTimer !== undefined) window.clearTimeout?.(reconnectTimer);
    reconnectTimer = undefined;
    failUnconfirmedSocketActions();
    publishConnection();
    dispatch({ type: "dashboard:notice", level: "warning", message: "Dashboard session expired. Sign in again, then verify account state before retrying. Pending actions will not be replayed." });
    window.location.assign(`/login?returnTo=${encodeURIComponent(`${window.location.pathname || "/"}${window.location.search || ""}`)}`);
  };

  const scheduleReconnect = () => {
    if (authenticationRequired) return;
    if (isBrowserOffline()) { publishStatus("offline"); return; }
    if (reconnectTimer !== undefined) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxReconnectDelayMs);
    reconnectStartedAt ??= Date.now();
    publishStatus("reconnecting", delay);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connectRealtime();
    }, delay);
  };

  const connectRealtime = () => {
    if (authenticationRequired) return;
    if (isBrowserOffline()) { publishStatus("offline"); return; }
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
    handshakeTimer = window.setTimeout?.(() => {
      if (connectingSocket !== socket) return;
      resetConnectingSocket();
      publishConnection();
      scheduleReconnect();
      void loadSnapshot().catch(() => undefined);
    }, 10_000);
    socket.addEventListener("open", () => {
      if (connectingSocket !== socket) return;
      connectingSocket = undefined;
      clearHandshake();
      realtimeSocket = socket;
      socketOpenedAt ??= Date.now();
      if (reconnectStartedAt !== undefined) reconnectMs = Math.max(0, Date.now() - reconnectStartedAt);
      reconnectDelayMs = 500;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      dispatch({ type: "dashboard:connection", transport: "websocket", connected: true });
      publishStatus("live");
      reconnectStartedAt = undefined;
    });
    socket.addEventListener("message", (event) => {
      if (realtimeSocket !== socket) return;
      try {
        const message = JSON.parse(event.data);
        if (!message?.type) return;
        if (firstLiveAt === undefined && message.type === 'dashboard:codex-session-live') { firstLiveAt = Date.now(); publishStatus("live"); }
        if (message.type === "dashboard:action-result") forgetSocketAction(message.requestId);
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
      if (connectingSocket === socket) { connectingSocket = undefined; clearHandshake(); }
      dispatch({ type: "dashboard:connection", transport: "websocket", connected: false });
      failUnconfirmedSocketActions();
      if (event.code === 4001) {
        requireSignIn();
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

  const restartRealtime = () => {
    if (connectingSocket) return;
    reconnectStartedAt ??= Date.now();
    resetConnectingSocket();
    const active = realtimeSocket;
    realtimeSocket = undefined;
    try { active?.close(); } catch { /* Already disconnected. */ }
    failUnconfirmedSocketActions();
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    publishConnection();
    publishStatus("connecting");
    connectRealtime();
  };

  const postMessage = async (message) => {
    const generation = sourceGeneration;
    if (message?.type === "dashboard:action" && message.action === "openExternalUrl") {
      let popup;
      try {
        const url = new URL(message.payload?.url?.trim());
        const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (!(url.protocol === "https:" || localHttp) || url.username || url.password)
          throw new Error("Only HTTPS links or local HTTP links without embedded credentials can be opened.");
        popup = window.open("about:blank", "_blank");
        if (!popup) throw new Error("Allow pop-ups for this dashboard, then try the link again.");
        popup.opener = null;
        popup.location.replace(url.href);
        await Promise.resolve();
        dispatch({ type: "dashboard:action-result", requestId: message.requestId, action: message.action, accountId: message.accountId,
          status: "completed", payload: { notice: { level: "info", message: "Opened the link in this browser." } } });
      } catch (error) {
        popup?.close();
        await Promise.resolve();
        dispatch({ type: "dashboard:action-result", requestId: message.requestId, action: message.action, accountId: message.accountId,
          status: "failed", error: error instanceof TypeError ? "This link could not be opened. Check the address and try again." : error.message });
      }
      return;
    }
    if (message?.type === "dashboard:ready" || message?.type === "dashboard:retry-connection") {
      dashboardReady = true;
      const manual = message.type === "dashboard:retry-connection";
      if (manual && retryInFlight) return retryInFlight;
      // Startup snapshots can arrive before the dashboard installs its listener.
      if (latestSnapshot) { const startup = latestSnapshot; latestSnapshot = undefined; dispatch(startup); }
      for (const live of startupLive.values()) dispatch(live);
      startupLive.clear();
      if (startupPrompts) { const prompts = startupPrompts; startupPrompts = undefined; dispatch(prompts); }
      publishConnection();
      if (manual) restartRealtime();
      const refresh = (async () => { try {
        const loaded = await loadSnapshot();
        if (manual && loaded) dispatch({
          type: "dashboard:notice",
          level: "info",
          message: "Dashboard refreshed."
        });
      } catch (error) {
        console.error("[codex-manager] dashboard refresh", error);
        if (manual) dispatch({ type: "dashboard:notice", level: "error", message: isRealtimeOpen() ? "Snapshot refresh failed. The live connection is available; displayed data may be stale." : "Dashboard is still unavailable. Check VS Code and try again." });
      } })();
      if (!manual) return refresh;
      retryInFlight = refresh.finally(() => { retryInFlight = undefined; });
      return retryInFlight;
    }
    let reachedHost = false;
    let timer;
    let httpRequestId;
    let awaitingHttpResponse = false;
    if (message?.type === "dashboard:action" && (pendingSocketActions.has(message.requestId) || pendingHttpActions.has(message.requestId))) return;
    try {
      if (authenticationRequired) throw new Error("Dashboard session expired. This action was not sent. Sign in again before retrying.");
      if (isBrowserOffline()) throw new Error("The browser is offline. This action was not sent; reconnect and try again.");
      if (message?.type === "dashboard:action" && pendingSocketActions.size + pendingHttpActions.size >= 128) throw new Error("The dashboard request queue is full. This action was not sent. Wait for pending actions before retrying.");
      // All dashboard actions use the live socket when available. A disconnected
      // socket still falls back to the existing confirmed HTTP request path.
      if (realtimeSocket && realtimeSocket.readyState === window.WebSocket.OPEN) {
        if (realtimeSocket.bufferedAmount > 4 * 1024 * 1024) throw new Error('The live connection is busy. This action was not sent. Wait for pending data before retrying.');
        reachedHost = true;
        if (message?.type === "dashboard:action" && message.requestId) {
          const actionTimer = window.setTimeout?.(() => {
            forgetSocketAction(message.requestId);
            dispatch({ type: "dashboard:action-result", requestId: message.requestId, action: message.action, accountId: message.accountId, status: "failed", error: "This action was not confirmed in time. Its outcome is unknown; refresh and verify before retrying." });
          }, requestTimeoutMs(message));
          pendingSocketActions.set(message.requestId, { message, timer: actionTimer });
        }
        realtimeSocket.send(JSON.stringify(message));
        return;
      }
      const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
      if (message?.type === "dashboard:action" && message.requestId) {
        httpRequestId = message.requestId;
        pendingHttpActions.add(httpRequestId);
      }
      timer = controller ? window.setTimeout(() => controller.abort(), requestTimeoutMs(message)) : undefined;
      const revision = snapshotRevision;
      awaitingHttpResponse = true;
      const response = await fetch("/api/message", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Dashboard": "1"
        },
        body: JSON.stringify(message),
        ...(controller ? { signal: controller.signal } : {})
      });
      awaitingHttpResponse = false;
      reachedHost = true;
      if (response.status === 401) {
        void response.body?.cancel().catch(() => undefined);
        throw Object.assign(new Error("Dashboard session expired. This action was not performed. Sign in again before retrying."), { authenticationRequired: true });
      }
      if (!response.ok) throw new Error(`Dashboard action failed (${response.status})`);
      const payload = await parseJsonResponse(response, "Dashboard action");
      if (generation !== sourceGeneration) throw new Error("The dashboard host changed before confirmation. Verify this action on the original system before retrying; it was not replayed.");
      if (!Array.isArray(payload.messages)) throw new Error("This action returned no result. Its outcome is unknown; refresh and verify before retrying.");
      if (authenticationRequired) return;
      if (message?.type === "dashboard:action" && !payload.messages.some(result => result?.type === "dashboard:action-result" && result.requestId === message.requestId && ["completed", "failed", "cancelled"].includes(result.status)))
        throw new Error("This action returned no confirmation. Its outcome is unknown; refresh and verify before retrying.");
      publishConnection();
      publishStatus(isRealtimeOpen() ? "live" : "degraded");
      const acceptSnapshot = revision === snapshotRevision;
      payload.messages.forEach(result => { if (result?.type !== "dashboard:snapshot" || acceptSnapshot) dispatch(result); });
    } catch (error) {
      if (!reachedHost && (awaitingHttpResponse || isBrowserOffline())) publishStatus(isRealtimeOpen() ? "live" : "unreachable");
      console.error("[codex-manager] browser dashboard bridge", error);
      const detail = error?.name === "AbortError"
        ? "This action was not confirmed in time. Its outcome is unknown; refresh and verify before retrying."
        : awaitingHttpResponse && httpRequestId ? "The connection failed before this action was confirmed. Its outcome is unknown; reconnect and verify before retrying."
          : error instanceof Error ? error.message : "The dashboard action failed. Please try again.";
      if (message?.type === "dashboard:action") {
        await Promise.resolve();
        forgetSocketAction(message.requestId);
        dispatch({
          type: "dashboard:action-result",
          requestId: message.requestId,
          action: message.action,
          accountId: message.accountId,
          status: "failed",
          error: detail
        });
      }
      // Action failures already have a request-scoped result. Do not emit a
      // second standalone toast for the same failed action.
      if (message?.type !== "dashboard:action" && message?.type !== "dashboard:workspace-presence") dispatch({ type: "dashboard:notice", level: "error", message: detail });
      if (error?.authenticationRequired) requireSignIn();
    } finally {
      if (timer !== undefined) window.clearTimeout?.(timer);
      if (httpRequestId) pendingHttpActions.delete(httpRequestId);
    }
  };

  window.acquireVsCodeApi = () => ({
    postMessage,
    getState: () => undefined,
    setState: () => undefined
  });

  if (typeof window.addEventListener === "function") {
    window.addEventListener("online", () => {
      connectRealtime();
      void loadSnapshot().catch(() => undefined);
    });
    window.addEventListener("offline", () => {
      resetConnectingSocket();
      const active = realtimeSocket;
      realtimeSocket = undefined;
      try { active?.close(); } catch { /* Network already unavailable. */ }
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      failUnconfirmedSocketActions();
      publishConnection();
      publishStatus("unreachable");
    });
  }

  window.addEventListener?.("beforeinstallprompt", (event) => { event.preventDefault(); window.codexInstallPrompt = event; });

  if (typeof navigator !== "undefined" && navigator.serviceWorker && typeof document !== "undefined") {
    document.documentElement.dataset.pushSubscribed = "checking";
    const currentScriptUrl = document.currentScript?.src;
    const version = currentScriptUrl ? new URL(currentScriptUrl).searchParams.get("v") : undefined;
    const workerUrl = version ? `/service-worker.js?v=${encodeURIComponent(version)}` : "/service-worker.js";
    const register = () => {
      void Promise.resolve().then(() => navigator.serviceWorker.register(workerUrl, { scope: "/", updateViaCache: "none" }))
        .then(async (registration) => {
          const subscription = await registration.pushManager?.getSubscription();
          document.documentElement.dataset.pushSubscribed = subscription ? "true" : "false";
        })
        .catch((error) => {
          document.documentElement.dataset.pushSubscribed = "false";
          console.warn("[codex-manager] offline shell unavailable", error);
        });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    publishConnection();
    if (!isRealtimeOpen()) connectRealtime();
    void loadSnapshot().catch(() => undefined);
  });
  publishStatus("connecting");
  connectRealtime();
})();
