(() => {
  const token = location.pathname.split("/").pop();
  if (!token) return;
  const state = document.getElementById("live-state");
  const count = document.getElementById("message-count");
  const conversation = document.getElementById("conversation");
  const escape = (value) => String(value).replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));
  const render = messages => messages.map((message, index) => `<article class="message ${message.role === "user" ? "user" : "assistant"}"><div class="message-head"><span class="avatar">${message.role === "user" ? "Y" : "✦"}</span><strong>${message.role === "user" ? "You" : "Codex"}</strong><span class="message-number">${index + 1}</span></div><div class="message-body">${escape(message.text)}</div></article>`).join("");
  const refresh = async () => {
    try {
      const response = await fetch(`/api/share/${encodeURIComponent(token)}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!Array.isArray(data.messages)) throw new Error();
      conversation.innerHTML = render(data.messages);
      count.textContent = `${data.messages.length} messages`;
      state.textContent = "● Live snapshot";
      state.classList.remove("offline");
    } catch {
      state.textContent = "● Reconnecting";
      state.classList.add("offline");
    }
  };
  setInterval(refresh, 3000);
})();
