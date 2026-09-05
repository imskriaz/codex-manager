(() => {
  let realtimeSocket;
  let reconnectTimer;
  let reconnectDelayMs = 500;
  const maxReconnectDelayMs = 5000;

  const dispatch = (message) => {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  };

  const parseJsonResponse = async (response, label) => {
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error(`${label} returned an invalid response. Reload the dashboard and sign in again.`);
    }
    return response.json();
  };

  const loadSnapshot = async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (response.status === 401) {
      window.location.reload();
      return;
    }
    if (!response.ok) {
      throw new Error(`Dashboard refresh failed (${response.status})`);
    }
    dispatch({ type: "dashboard:snapshot", state: await parseJsonResponse(response, "Dashboard refresh") });
  };

  const connectRealtime = () => {
    if (typeof window.WebSocket !== "function") {
      dispatch({ type: "dashboard:connection", transport: "websocket", connected: false });
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new window.WebSocket(`${protocol}//${window.location.host}/ws`);
    socket.addEventListener("open", () => {
      realtimeSocket = socket;
      reconnectDelayMs = 500;
      dispatch({ type: "dashboard:connection", transport: "websocket", connected: true });
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message?.type) dispatch(message);
      } catch (error) {
        console.error("[codex-manager] realtime dashboard message", error);
      }
    });
    socket.addEventListener("close", (event) => {
      if (realtimeSocket === socket) realtimeSocket = undefined;
      dispatch({ type: "dashboard:connection", transport: "websocket", connected: false });
      if (event.code === 4001) {
        window.location.reload();
        return;
      }
      if (reconnectTimer !== undefined) return;
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxReconnectDelayMs);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connectRealtime();
      }, delay);
    });
    // The platform dispatches a close event after an error. Calling close()
    // from the error callback can re-enter the implementation's failure
    // dispatch (the VS Code host uses the same WebSocket lifecycle), so let
    // the close handler own cleanup and reconnect scheduling.
    socket.addEventListener("error", () => undefined);
  };

  const postMessage = async (message) => {
    try {
      if (message?.type === "dashboard:ready") {
        await loadSnapshot();
        return;
      }
      if (realtimeSocket && typeof window.WebSocket === "function" && realtimeSocket.readyState === window.WebSocket.OPEN) {
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
      if (response.status === 401) {
        window.location.reload();
        return;
      }
      if (!response.ok) {
        throw new Error(`Dashboard action failed (${response.status})`);
      }
      const payload = await parseJsonResponse(response, "Dashboard action");
      if (!Array.isArray(payload.messages)) {
        throw new Error("Dashboard action returned no result. Reload the dashboard and try again.");
      }
      payload.messages.forEach(dispatch);
    } catch (error) {
      console.error("[codex-manager] browser dashboard bridge", error);
      const detail = error instanceof Error ? error.message : "The dashboard action failed. Please try again.";
      if (message?.type === "dashboard:action") {
        dispatch({
          type: "dashboard:action-result",
          requestId: message.requestId,
          action: message.action,
          accountId: message.accountId,
          status: "failed",
          error: detail
        });
      }
      dispatch({
        type: "dashboard:notice",
        level: "error",
        message: detail
      });
    }
  };

  window.acquireVsCodeApi = () => ({
    postMessage,
    getState: () => undefined,
    setState: () => undefined
  });

  connectRealtime();
})();
