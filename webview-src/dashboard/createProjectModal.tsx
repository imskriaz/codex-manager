import { useEffect, useRef, useState } from "preact/hooks";
import type { DashboardActionResultPayload, DashboardCliProject, DashboardHostMessage, DashboardNotice } from "../../src/domain/dashboard/types";
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
  const browseRequest = useRef<{ id: string; timer: ReturnType<typeof setTimeout> }>();
  const [browsing, setBrowsing] = useState(false), [browserOpen, setBrowserOpen] = useState(false);
  const [listing, setListing] = useState<DashboardActionResultPayload['workspaceFolders']>();
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type === 'dashboard:action-result' && message.requestId === browseRequest.current?.id) {
        clearTimeout(browseRequest.current.timer);
        browseRequest.current = undefined;
        setBrowsing(false);
        if (message.status === 'completed' && message.payload?.workspaceFolders) { setListing(message.payload.workspaceFolders); setError(''); }
        else setError(message.error || 'Folder browsing was not confirmed. Retry when connected.');
        return;
      }
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
      if (browseRequest.current) clearTimeout(browseRequest.current.timer);
      browseRequest.current = undefined;
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
  const browse = (parentFolder?: string) => {
    if (browseRequest.current || pending || props.disabled) return;
    if (!navigator.onLine) { setError('Reconnect before browsing folders on the selected system.'); return; }
    setBrowserOpen(true); setBrowsing(true); setError('');
    const id = createActionRequestId(true);
    const timer = setTimeout(() => { if (browseRequest.current?.id !== id) return; browseRequest.current = undefined; setBrowsing(false); setError('Folder browsing timed out. Reconnect or try another folder.'); }, 12_000);
    browseRequest.current = { id, timer };
    try { postMessageToHost({ type: 'dashboard:action', requestId: id, action: 'browseWorkspaceFolders', payload: { parentFolder, targetDeviceId: props.deviceId, automatic: true } }); }
    catch (failure) { clearTimeout(timer); browseRequest.current = undefined; setBrowsing(false); setError(failure instanceof Error ? failure.message : 'Folder browsing could not be sent.'); }
  };
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
        <button type="button" disabled={pending || browsing || props.disabled} onClick={() => browse(folder.trim() || undefined)}>Browse folders…</button>
        {browserOpen ? <section class="project-folder-browser" aria-label="Folders on selected system" aria-busy={browsing}>
          {browsing ? <p role="status">Loading folders…</p> : null}
          {listing ? <>
            <nav aria-label="Folder locations">{listing.roots.map(root => <button type="button" disabled={browsing || pending} onClick={() => browse(root)}>{root}</button>)}<button type="button" disabled={browsing || pending || listing.parent === listing.path} onClick={() => browse(listing.parent)}>Up</button></nav>
            <code>{listing.path}</code>
            <div class="project-folder-list">{listing.folders.map(item => <button type="button" disabled={browsing || pending} onClick={() => browse(item.path)}>{item.name}</button>)}{!listing.folders.length ? <p>No subfolders.</p> : null}</div>
            {listing.warning ? <p role="status">{listing.warning}</p> : null}
            <button type="button" disabled={browsing || pending} onClick={() => { setFolder(listing.path); setBrowserOpen(false); }}>Select this folder</button>
          </> : null}
          <button type="button" onClick={() => { setBrowserOpen(false); }}>Close browser</button>
        </section> : null}
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
