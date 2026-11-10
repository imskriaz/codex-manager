import { useEffect, useRef, useState } from "preact/hooks";
import type { DashboardCliProject, DashboardHostMessage, DashboardNotice } from "../../src/domain/dashboard/types";
import { createActionRequestId, postMessageToHost } from "./host";
import { ModalShell } from "./primitives";

export const CREATE_PROJECT_OPTION = "__create_workspace_project__";

export function CreateProjectModal(props: {
  deviceId?: string;
  initialFolder?: string;
  disabled?: boolean;
  onClose: () => void;
  onCreated: (project: DashboardCliProject) => void;
  onFeedback: (notice: DashboardNotice) => void;
}) {
  const [name, setName] = useState(""),
    [folder, setFolder] = useState(props.initialFolder ?? "");
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const request = useRef<{ id: string; timer: ReturnType<typeof setTimeout> }>();
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== "dashboard:action-result" || message.requestId !== request.current?.id) return;
      clearTimeout(request.current.timer);
      request.current = undefined;
      setPending(false);
      if (message.status === "completed" && message.payload?.workspaceProject) {
        current.current.onCreated(message.payload.workspaceProject);
        current.current.onFeedback(message.payload.notice ?? { level: "info", message: "Project created." });
        current.current.onClose();
      } else setError(message.error || "Project creation was not confirmed. Check the folder before retrying.");
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      if (request.current) {
        clearTimeout(request.current.timer);
        request.current = undefined;
        current.current.onFeedback({
          level: "warning",
          message:
            "The selected workspace changed before creation was confirmed. Check the original system’s folder before retrying."
        });
      }
    };
  }, [props.deviceId]);
  const separator = folder.includes("\\") ? "\\" : "/";
  const destination =
    folder.trim() && name.trim()
      ? `${folder.trim().replace(/[\\/]+$/, "")}${separator}${name.trim()}`
      : "Your new folder will appear here";
  return (
    <ModalShell
      open
      title="Create new project"
      closeLabel="Close create project"
      className="create-project-modal dashboard-modal-compact"
      closeDisabled={pending}
      closeOnBackdrop={false}
      onClose={() => {
        props.onFeedback({ level: "info", message: "Project creation cancelled." });
        props.onClose();
      }}
    >
      <form
        class="workspace-dialog-fields create-project-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (request.current || props.disabled || !name.trim() || !folder.trim()) return;
          if (!navigator.onLine) {
            setError("Reconnect before creating a project. Nothing was sent or queued.");
            return;
          }
          const id = createActionRequestId(true);
          setPending(true);
          setError("");
          const timer = setTimeout(() => {
            if (request.current?.id !== id) return;
            request.current = undefined;
            setPending(false);
            setError(
              "Creation was not confirmed. Check the destination folder before retrying; this request was not replayed."
            );
          }, 25_000);
          request.current = { id, timer };
          try {
            postMessageToHost({
              type: "dashboard:action",
              requestId: id,
              action: "createWorkspaceProject",
              payload: {
                projectName: name.trim(),
                parentFolder: folder.trim(),
                targetDeviceId: props.deviceId,
                automatic: true
              }
            });
          } catch (failure) {
            clearTimeout(timer);
            request.current = undefined;
            setPending(false);
            setError(failure instanceof Error ? failure.message : "The request could not be sent.");
          }
        }}
      >
        <p class="workspace-dialog-description">
          Give your project a name and choose where it lives on the selected system.
        </p>
        <label>
          Project name
          <input
            autoFocus
            required
            maxLength={120}
            value={name}
            disabled={pending}
            placeholder="my-project"
            autoComplete="off"
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          Parent folder
          <input
            aria-label="Parent folder"
            aria-describedby="create-project-parent-help"
            required
            value={folder}
            maxLength={4096}
            disabled={pending}
            placeholder="Absolute path on this system"
            spellcheck={false}
            autoComplete="off"
            onInput={(event) => setFolder(event.currentTarget.value)}
          />
          <small id="create-project-parent-help">A new folder named after your project will be created here.</small>
        </label>
        <div class="create-project-destination">
          <small>PROJECT FOLDER</small>
          <code>{destination}</code>
        </div>
        {error ? (
          <p class="cli-inspector-notice is-error" role="alert">
            {error}
          </p>
        ) : null}
        {props.disabled ? <p role="status">Reconnect to the selected system to create a project.</p> : null}
        <footer class="workspace-dialog-footer">
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              props.onFeedback({ level: "info", message: "Project creation cancelled." });
              props.onClose();
            }}
          >
            Cancel
          </button>
          <button type="submit" class="primary" disabled={pending || props.disabled || !name.trim() || !folder.trim()}>
            {pending ? "Creating…" : "Create project"}
          </button>
        </footer>
      </form>
    </ModalShell>
  );
}
