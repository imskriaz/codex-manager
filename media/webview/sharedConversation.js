(() => {
  const token = location.pathname.split("/").pop();
  if (!token) return;
  const state = document.getElementById("live-state");
  const count = document.getElementById("message-count");
  const conversation = document.getElementById("conversation");
  let signature, stopped = false;
  const refresh = async () => {
    if (stopped) return;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/share/${encodeURIComponent(token)}`, { cache: "no-store", signal: controller.signal });
      if (response.status === 404) { stopped = true; window.clearCodexSharedMessages?.(conversation); conversation.replaceChildren(); state.textContent = 'This link expired or was revoked.'; return; }
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!Array.isArray(data.messages)) throw new Error();
      const next = JSON.stringify(data.messages);
      if (next !== signature && window.renderCodexSharedMessages) { window.renderCodexSharedMessages(conversation, data.messages); signature = next; }
      count.textContent = `${data.messages.length} messages`;
      document.getElementById('conversation-title').textContent = data.title;
      state.textContent = "Shared conversation";
      state.classList.remove("offline");
    } catch {
      state.textContent = "● Reconnecting";
      state.classList.add("offline");
    } finally { clearTimeout(timer); if (!stopped) setTimeout(() => { if (!document.hidden) void refresh(); else setTimeout(refresh, 15000); }, 5000); }
  };
  void refresh();
})();
