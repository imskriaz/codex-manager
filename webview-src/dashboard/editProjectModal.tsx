import { useEffect, useRef, useState } from "preact/hooks";
import type { DashboardCliProject, DashboardHostMessage, DashboardNotice } from "../../src/domain/dashboard/types";
import { createActionRequestId, postMessageToHost } from "./host";
import { ModalShell } from "./primitives";

function PencilIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m4 20 4.2-1 10.4-10.4a2 2 0 0 0-2.8-2.8L5.4 16.2 4 20Z" /><path d="m14.5 5.1 4.4 4.4" /></svg>;
}

function TrashIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>;
}

export function EditProjectModal(props: {
  simple?: boolean;
  project: DashboardCliProject;
  deviceId?: string;
  disabled?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onFeedback: (notice: DashboardNotice) => void;
}) {
  const [name, setName] = useState(props.project.label);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<DashboardNotice>();
  const request = useRef<{ id: string; timer: ReturnType<typeof setTimeout> }>();
  const current = useRef(props);
  current.current = props;
  const feedback = (value: DashboardNotice) => { setNotice(value); current.current.onFeedback(value); };
  const cancel = () => { props.onFeedback({ level: 'info', message: 'Project editing cancelled.' }); props.onClose(); };

  useEffect(() => {
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (!request.current || message?.type !== "dashboard:action-result" || message.requestId !== request.current.id) return;
      clearTimeout(request.current.timer);
      request.current = undefined;
      setPending(false);
      if (message.status === "completed" && (message.action === 'removeWorkspaceProject' || message.payload?.workspaceProject)) {
        current.current.onFeedback(message.payload?.notice ?? { level: "info", message: message.action === "removeWorkspaceProject" ? "Project removed from the list." : "Project renamed." });
        current.current.onChanged();
        current.current.onClose();
      } else {
        feedback({ level: message.status === "cancelled" ? "warning" : "error", message: message.error || "The project change was not confirmed. Refresh the project list and try again." });
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      if (request.current) {
        clearTimeout(request.current.timer);
        request.current = undefined;
        current.current.onFeedback({ level: "warning", message: "The project change was interrupted before confirmation. Refresh the project list before retrying." });
      }
    };
  }, []);

  const submit = (action: "renameWorkspaceProject" | "removeWorkspaceProject", payload: Record<string, unknown>) => {
    if (request.current || props.disabled) return;
    const id = createActionRequestId(true);
    const timer = setTimeout(() => {
      if (request.current?.id !== id) return;
      request.current = undefined;
      setPending(false);
      feedback({ level: "warning", message: "The project change was not confirmed. Refresh the project list before retrying; the request was not replayed." });
    }, 25_000);
    request.current = { id, timer };
    setPending(true);
    setNotice(undefined);
    try {
      postMessageToHost({ type: "dashboard:action", requestId: id, action, payload: { ...payload, projectPath: props.project.path, targetDeviceId: props.deviceId, automatic: true } });
    } catch (error) {
      clearTimeout(timer);
      request.current = undefined;
      setPending(false);
      feedback({ level: "error", message: error instanceof Error ? error.message : "The project change could not be sent." });
    }
  };

  return <ModalShell open title={`Edit ${props.project.label}`} closeLabel="Close project editor" className="edit-project-modal dashboard-modal-compact" closeDisabled={pending} closeOnBackdrop={false} onClose={cancel}>
    <div class="workspace-dialog-fields">
      <p class="workspace-dialog-description">Update the project label or remove this saved project from the list. The folder and conversations stay on the system.</p>
      {notice ? <p role="alert" class="edit-project-notice">{notice.message}</p> : null}
      <label>Project name<input autoFocus value={name} maxLength={120} disabled={pending || props.disabled} onInput={event => setName(event.currentTarget.value)} /></label>
      {!props.simple ? <div class="create-project-destination"><small>PROJECT FOLDER</small><code title={props.project.path}>{props.project.path}</code></div> : null}
      {confirmDelete ? <div class="edit-project-confirm" role="alert"><strong>Remove this project?</strong><span>Only the saved project entry is removed. Files and conversations are kept.</span><div class="dialog-actions"><button type="button" disabled={pending} onClick={() => setConfirmDelete(false)}>Cancel</button><button type="button" class="is-danger" disabled={pending || props.disabled} onClick={() => submit("removeWorkspaceProject", { confirmed: true })}>Remove project</button></div></div> : null}
      <footer class="workspace-dialog-footer"><button type="button" disabled={pending} onClick={cancel}>Cancel</button><button type="button" class="is-danger edit-project-remove" disabled={pending || props.disabled} onClick={() => setConfirmDelete(true)}><TrashIcon /> Remove</button><button type="button" class="primary" disabled={pending || props.disabled || !name.trim()} onClick={() => submit("renameWorkspaceProject", { projectName: name.trim() })}><PencilIcon /> {pending ? "Saving…" : "Save"}</button></footer>
    </div>
  </ModalShell>;
}
