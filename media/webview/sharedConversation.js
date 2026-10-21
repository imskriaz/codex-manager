(() => {
  const token = location.pathname.split("/").pop();
  if (!token) return;
  const endpoint = `/api/share/${encodeURIComponent(token)}`;
  const header = document.getElementById('shared-header');
  const state = document.getElementById("live-state");
  const conversation = document.getElementById("conversation");
  let signature, stopped = false, loading = false, queued = false, events, epoch = 0;
  const stopEvents = () => { events?.close(); events = undefined; };
  const revoke = () => {
    stopped = true; epoch++; queued = false; stopEvents();
    if (header) { window.clearCodexSharedMessages?.(header); header.replaceChildren(); }
    window.clearCodexSharedMessages?.(conversation); conversation.replaceChildren();
    state.textContent = 'This link expired or was revoked.';
  };
  const connect = () => {
    if (events || stopped || document.hidden || navigator.onLine === false || !window.EventSource) return;
    const source = new EventSource(endpoint + '/events'); events = source;
    const changed = () => { if (events === source) void refresh(); };
    source.addEventListener('ready', changed); source.addEventListener('change', changed);
    source.addEventListener('revoked', () => { if (events === source) revoke(); });
    source.addEventListener('unavailable', () => { if (events === source) { stopEvents(); state.textContent = 'Live updates unavailable. Refresh to retry.'; state.classList.add('offline'); } });
    source.onerror = () => { if (events === source) { state.textContent = 'Reconnecting. Saved conversation retained.'; state.classList.add('offline'); } };
  };
  const refresh = async () => {
    if (stopped || document.hidden || navigator.onLine === false) return;
    if (loading) { queued = true; return; }
    loading = true;
    const current = epoch;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
      if (stopped || current !== epoch) return;
      if (response.status === 404) { revoke(); return; }
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (stopped || current !== epoch) return;
      if (!Array.isArray(data.messages)) throw new Error();
      const next = JSON.stringify(data.messages);
      if (next !== signature && window.renderCodexSharedMessages) {
        const follow = signature === undefined || conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80;
        window.renderCodexSharedMessages(conversation, data.messages); signature = next;
        if (follow) window.requestAnimationFrame?.(() => { conversation.scrollTop = conversation.scrollHeight; });
      }
      if (header && window.renderCodexSharedHeader) window.renderCodexSharedHeader(header, { id: 'shared-session', title: data.title, status: data.status || 'unknown' }, () => { stopEvents(); void refresh(); });
      else { const title = document.getElementById('conversation-title'); if (title) title.textContent = data.title; }
      state.textContent = data.warning || ''; state.classList.remove('offline');
    } catch {
      if (!stopped && current === epoch) { state.textContent = 'Connection unavailable. Saved conversation retained; refresh to retry.'; state.classList.add('offline'); }
    } finally {
      clearTimeout(timer); loading = false;
      if (!stopped && current === epoch) {
        try { connect(); } catch { state.textContent = 'Live updates unavailable. Refresh to retry.'; }
      }
      if (queued && !stopped) { queued = false; void refresh(); }
    }
  };
  const button = document.getElementById('shared-refresh') || document.createElement('button'); button.type = 'button'; button.onclick = () => { stopEvents(); void refresh(); };
  const changed = () => { if (document.hidden || navigator.onLine === false) stopEvents(); else { if (events?.readyState === window.EventSource?.CLOSED) stopEvents(); void refresh(); } };
  window.addEventListener('focus', changed); window.addEventListener('online', changed); window.addEventListener('offline', () => { epoch++; queued = false; stopEvents(); if (!stopped) { state.textContent = 'Offline. Saved conversation retained.'; state.classList.add('offline'); } });
  document.addEventListener('visibilitychange', changed);
  window.addEventListener('pagehide', () => { epoch++; queued = false; stopEvents(); }); window.addEventListener('pageshow', changed);
  void refresh();
})();
