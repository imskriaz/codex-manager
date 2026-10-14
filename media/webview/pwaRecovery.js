(() => {
  let pending = false;
  const reconnect = async () => {
    if (pending || navigator.onLine === false) return;
    pending = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("/api/state", { cache: "no-store", signal: controller.signal });
      if (response.ok || response.status === 401) { window.location.reload(); return; }
    } catch { /* The recovery screen remains visible while the host restarts. */ }
    finally { clearTimeout(timer); pending = false; }
    const status = document.getElementById("connection-status");
    if (status) status.textContent = "Waiting for the dashboard host. Reconnect is automatic; you can also try again below.";
  };
  window.addEventListener("online", reconnect);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void reconnect(); });
  setInterval(reconnect, 5000);
  void reconnect();
})();
