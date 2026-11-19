import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { DashboardOfficeView } from "../../src/domain/dashboard/types";

type ChatMessage = { role: "user" | "assistant"; content: string };

export function OfficeUserWorkspace(props: { office: DashboardOfficeView; taskActive?: boolean; onTask: () => void; onSettings: () => void }): JSX.Element {
  const [tab, setTab] = useState<"general" | "task">(props.taskActive ? "task" : "general");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const send = async (retry = 0): Promise<void> => {
    const text = input.trim();
    if (!text || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setInput(""); setMessages(next); setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/office/chat", { method: "POST", headers: { "Content-Type": "application/json", "X-Codex-Dashboard": "1" }, body: JSON.stringify({ messages: next }) });
      const body = await response.json() as { response?: { choices?: Array<{ message?: { content?: unknown } }> }; error?: string; retryAfterMs?: number };
      if (!response.ok) {
        const message = body.error ?? "General chat is temporarily unavailable. Retry shortly.";
        setNotice(message);
        if (/out of credits|temporarily unavailable/i.test(message) && retry < 5) {
          window.setTimeout(() => { setBusy(false); void send(retry + 1); }, Math.max(2_000, body.retryAfterMs ?? 5_000));
          return;
        }
        return;
      }
      const content = body.response?.choices?.[0]?.message?.content;
      setMessages(current => [...current, { role: "assistant", content: typeof content === "string" ? content : "The response was empty." }]);
    } catch { setNotice("General chat is temporarily unavailable. Retry shortly."); }
    finally { setBusy(false); }
  };
  return <section class="office-user-shell" aria-label="Office workspace">
    <header class="office-user-header"><div><strong>{props.office.displayName}</strong><small>Office workspace</small></div><div class="office-user-actions"><button type="button" onClick={props.onSettings}>Settings</button></div></header>
    <nav class="office-user-tabs" aria-label="Workspace tabs"><button type="button" class={tab === "general" ? "active" : ""} onClick={() => { setTab("general"); if (props.taskActive) window.history.pushState({}, "", "/"); }}>General</button><button type="button" class={tab === "task" ? "active" : ""} onClick={() => { setTab("task"); props.onTask(); }}>Task</button></nav>
    {!props.taskActive && tab === "general" ? <div class="office-general-chat"><div class="office-chat-messages" aria-live="polite">{messages.length ? messages.map((message, index) => <div key={index} class={`office-chat-message ${message.role}`}><span>{message.role === "user" ? "You" : "Assistant"}</span><p>{message.content}</p></div>) : <p class="office-chat-empty">Start a general conversation in your office workspace.</p>}</div>{notice ? <p class="office-chat-notice" role="status">{notice}</p> : null}<form onSubmit={event => { event.preventDefault(); void send(); }}><textarea value={input} onInput={event => setInput((event.currentTarget as HTMLTextAreaElement).value)} placeholder="Ask a general question…" rows={3} disabled={busy} /><button type="submit" disabled={!input.trim() || busy}>{busy ? "Checking…" : "Send"}</button></form></div> : null}
  </section>;
}
