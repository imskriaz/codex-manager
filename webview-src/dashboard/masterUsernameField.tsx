import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";
import { CopyIcon, ToolIcon } from "./icons";

export function MasterUsernameField(props: { sendAction: SendAction; authenticatedMaster?: boolean }) {
  const id = useId();
  const local = document.documentElement.dataset['dashboardHost'] !== "browser" || document.documentElement.dataset['dashboardRemote'] === "false";
  const available = local || props.authenticatedMaster === true;
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [confirmRotation, setConfirmRotation] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<{ id: string; action: "getMasterUsername" | "rotateMasterUsername"; timer: number }>();
  const send = useRef(props.sendAction); send.current = props.sendAction;

  const run = (action: "getMasterUsername" | "rotateMasterUsername") => {
    if (request.current) return;
    setPending(true); setConfirmRotation(false);
    setStatus(action === "getMasterUsername" ? "Loading username…" : "Rotating username…");
    const id = send.current(action, undefined, { targetDeviceId: "local", ...(action === "rotateMasterUsername" ? { masterUsername: username, confirmed: true } : {}) });
    const timer = window.setTimeout(() => {
      request.current = undefined; setPending(false); setNeedsReload(true);
      setStatus(action === "rotateMasterUsername" ? "Rotation was not confirmed. Reload the username before retrying." : "The username could not be loaded. Reconnect and retry.");
    }, 10_000);
    request.current = { id, action, timer };
  };

  useEffect(() => {
    if (!available) return;
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const result = event.data, current = request.current;
      if (result?.type === "dashboard:action-result" && result.action === "rotateMasterUsername" && result.status === "completed" && result.payload?.masterUsername) {
        setUsername(result.payload.masterUsername); setNeedsReload(false);
        setStatus("Username rotated. Use this username at your next sign-in.");
      }
      if (result?.type !== "dashboard:action-result" || !current || result.requestId !== current.id) return;
      window.clearTimeout(current.timer); request.current = undefined; setPending(false);
      if (result.status === "completed" && result.payload?.masterUsername) {
        setUsername(result.payload.masterUsername); setNeedsReload(false);
        setStatus(current.action === "rotateMasterUsername" ? "Username rotated. Use this username at your next sign-in." : "");
      } else {
        setNeedsReload(true);
        setStatus(result.error || "The username was not confirmed. Reload it before retrying.");
      }
    };
    window.addEventListener("message", receive);
    run("getMasterUsername");
    return () => {
      window.removeEventListener("message", receive);
      if (request.current) window.clearTimeout(request.current.timer);
    };
  }, [available]);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(username);
      else {
        input.current?.focus(); input.current?.select();
        if (!document.execCommand("copy")) throw new Error("Clipboard access denied");
      }
      setStatus("Master username copied.");
    } catch {
      input.current?.focus(); input.current?.select();
      setStatus("Copy was blocked. The username is selected; copy it with Ctrl+C or your device’s Copy command.");
    }
  };

  if (!available) return null;
  return <div class="master-username-field">
    <label for={id}>Master username</label>
      <div class="master-username-input">
        <input id={id} ref={input} class="modal-input" readOnly value={username} autoComplete="off" spellcheck={false} placeholder={pending ? "Loading…" : "Username unavailable"} />
        <button type="button" title="Copy master username" aria-label="Copy master username" disabled={!username || pending || needsReload} onClick={() => void copy()}><CopyIcon /></button>
        {local || needsReload ? <button type="button" title={needsReload ? "Reload master username" : "Rotate master username"} aria-label={needsReload ? "Reload master username" : "Rotate master username"} disabled={pending} onClick={() => needsReload ? run("getMasterUsername") : setConfirmRotation(true)}><ToolIcon kind="key" /></button> : null}
      </div>
    <small>Generated once. Required with your password for master sign-in.</small>
    {confirmRotation ? <div class="master-username-confirm"><span>Replace this username? The current username will stop working for new sign-ins.</span><div><button type="button" onClick={() => { setConfirmRotation(false); setStatus("Username rotation cancelled."); }}>Cancel</button><button type="button" onClick={() => run("rotateMasterUsername")}>Rotate</button></div></div> : null}
    <div class="master-username-status" role="status" aria-live="polite">{status}</div>
  </div>;
}
