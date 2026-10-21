(() => {
  let pending = false;
  const reconnect = async () => {
    if (pending || navigator.onLine === false || document.visibilityState === 'hidden') return;
    pending = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("/api/state", { cache: "no-store", signal: controller.signal });
      if (response.ok || response.status === 401) { window.location.reload(); return; }
    } catch { /* The recovery screen remains visible while the host restarts. */ }
    finally { clearTimeout(timer); pending = false; }
    const status = document.getElementById("connection-status");
    if (status) status.textContent = "Waiting for the dashboard host. Return to this page or try connecting again below.";
  };
  window.addEventListener("online", reconnect);
  window.addEventListener("focus", reconnect);
  window.addEventListener("pageshow", reconnect);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void reconnect(); });
  void reconnect();
})();
