import {MobileSectionPicker} from './mobileSectionPicker';
import { WorkspaceMenu } from "./workspaceMenu";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type {
  DashboardNotice,
  DashboardWorkspaceGitHistory,
  WorkspaceGitAuthState,
  WorkspaceGitRequest,
  WorkspaceGitState
} from "../../src/domain/dashboard/types";
import { useWorkspaceRequest } from "./workspaceRequest";
import { WorkspaceDialog } from "./workspaceDialog";
import { ToolIcon } from "./icons";
import { WorkspaceGitHub } from "./workspaceGitHub";
import { handleTabKeyDown } from "./primitives";

export function WorkspaceGit(props: {
  projectPath?: string;
  targetDeviceId?: string;
  connected: boolean;
  draft: string;
  onDraft: (value: string) => void;
  pending?: boolean;
  notice?: string;
  onFeedback: (notice: DashboardNotice) => void;
  onPending: (pending: boolean, message?: string, committedDraft?: string) => void;
  onOpenFile: (path: string) => void;
  renderDiff: (diff: string) => ComponentChildren;
}) {
  const request = useWorkspaceRequest(props.projectPath, props.targetDeviceId, props.connected);
  const [view, setView] = useState<"changes" | "history" | "branches" | "stashes" | "github">("changes");
  const [state, setState] = useState<WorkspaceGitState>(),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [readError, setReadError] = useState(""),
    [stale, setStale] = useState(true),
    [setupRequired, setSetupRequired] = useState(false);
  const [history, setHistory] = useState<DashboardWorkspaceGitHistory>(),
    [selectedCommit, setSelectedCommit] = useState<string>(),
    [diff, setDiff] = useState<{ title: string; content: string; truncated?: boolean }>();
  const draft = props.draft;
  const [dialog, setDialog] = useState<{
    title: string;
    description: string;
    request: WorkspaceGitRequest;
    field?: "name" | "message" | "remote";
    placeholder?: string;
  }>();
  const [field, setField] = useState(""),
    [filter, setFilter] = useState("");
  const [auth, setAuth] = useState<{
    id: string;
    state: WorkspaceGitAuthState;
    ready: boolean;
    cancelling?: boolean;
    statusError?: string;
  }>();
  const [authorizedAttempt, setAuthorizedAttempt] = useState<string>();
  const generation = useRef(0);
  const cancelOnClose = useRef<() => void>();
  const previousPending = useRef(props.pending);
  const ownsPending = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
      cancelOnClose.current?.();
    },
    []
  );
  const read = async () => {
    const token = generation.current;
    setBusy(true);
    setStale(true);
    try {
      const result = await request("workspaceGit", { gitRequest: { operation: "read" } }, (saved) => {
        if (token === generation.current && saved.workspaceGit) {
          setState((current) => current ?? saved.workspaceGit);
          setNotice("");
        }
      });
      if (token !== generation.current) {
        return;
      }
      if (!result.workspaceGit) {
        throw new Error("Git state was not returned. Update the selected system and retry.");
      }
      setState(result.workspaceGit);
      setSetupRequired(false);
      setReadError("");
      setStale(!props.connected);
      setNotice("");
      if (result.workspaceGit.warning) props.onFeedback({ level: "warning", message: result.workspaceGit.warning });
    } catch (error) {
      if (token === generation.current) {
        const message = (error as Error).message;
        const missing = /not a git repository/i.test(message);
        setSetupRequired(missing);
        setReadError(missing ? "" : message);
        setState(undefined);
        setHistory(undefined);
        setStale(true);
      }
    } finally {
      if (token === generation.current) {
        setBusy(false);
      }
    }
  };
  useLayoutEffect(() => {
    void read();
  }, [props.connected, request]);
  useEffect(() => {
    if (previousPending.current && !props.pending && props.connected) {
      if (!ownsPending.current) {
        void read();
      }
      ownsPending.current = false;
    }
    previousPending.current = props.pending;
  }, [props.pending]);
  const requestAuth = async (operation: "authStart" | "authStatus" | "authCancel", id: string) => {
    const result = await request("workspaceGit", { gitRequest: { operation, operationId: id }, confirmed: true });
    if (!result.workspaceGit?.auth) throw new Error("The system did not confirm GitHub authorization. Check its status before retrying.");
    return result.workspaceGit.auth;
  };
  const startAuth = async () => {
    const token = generation.current;
    const id = crypto.randomUUID();
    setAuth({ id, state: { status: "starting" }, ready: false });
    try {
      const state = await requestAuth("authStart", id);
      const cancel = () => { void requestAuth("authCancel", id).catch(() => undefined); };
      const active = state.status === "starting" || state.status === "waiting";
      if (token === generation.current) {
        if (active) cancelOnClose.current = cancel;
        setAuth({ id, state, ready: true });
      } else if (active) {
        cancel();
      }
    } catch (error) {
      if (token === generation.current) setAuth({ id, state: { status: "failed", message: (error as Error).message }, ready: true });
    }
  };
  const authActive = auth?.state.status === "starting" || auth?.state.status === "waiting";
  useEffect(() => {
    if (!auth || !auth.ready || !authActive || auth.cancelling || !props.connected) return;
    let current = true;
    const timer = setTimeout(() => {
      void requestAuth("authStatus", auth.id).then((state) => {
        if (current) setAuth({ ...auth, state, statusError: undefined });
      }, (error: Error) => {
        if (current) setAuth({ ...auth, statusError: error.message });
      });
    }, 1500);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [auth, authActive, request, props.connected]);
  useEffect(() => {
    if (!authActive) cancelOnClose.current = undefined;
    if (auth?.state.status === "completed") setAuthorizedAttempt(auth.id);
  }, [auth, authActive]);
  const cancelAuth = async () => {
    if (!auth || !auth.ready || auth.cancelling) return;
    setAuth({ ...auth, cancelling: true });
    try {
      const state = await requestAuth("authCancel", auth.id);
      setAuth({ ...auth, state, cancelling: false, statusError: undefined });
    } catch (error) {
      setAuth({ ...auth, cancelling: false, statusError: (error as Error).message });
    }
  };
  const run = async (operation: WorkspaceGitRequest) => {
    if (!state || stale || busy || props.pending) {
      return;
    }
    const token = generation.current;
    setBusy(true);
    setNotice("");
    const submittedDraft = draft;
    ownsPending.current = true;
    props.onPending(true);
    try {
      const result = await request("workspaceGit", {
        gitRequest: { ...operation, revision: state.revision, operationId: crypto.randomUUID() },
        confirmed: true
      });
      if (!result.workspaceGit) {
        throw new Error("Git did not confirm the operation. Refresh before retrying.");
      }
      props.onPending(
        false,
        result.workspaceGit.warning || result.workspaceGit.output || "Git operation completed.",
        operation.operation === "commit" ? submittedDraft : undefined
      );
      if (token !== generation.current) {
        return;
      }
      setState(result.workspaceGit);
      setStale(Boolean(result.workspaceGit.warning));
      setNotice(result.workspaceGit.output ?? "");
      if (result.workspaceGit.warning) props.onFeedback({ level: "warning", message: result.workspaceGit.warning });
      setDialog(undefined);
    } catch (error) {
      props.onPending(false, (error as Error).message);
      if (token === generation.current) {
        props.onFeedback({ level: "error", message: (error as Error).message });
        setStale(true);
      }
    } finally {
      if (token === generation.current) {
        setBusy(false);
      }
    }
  };
  const preview = async (path?: string, staged = false) => {
    setBusy(true);
    const token = generation.current;
    try {
      const result = await request("workspaceGit", { gitRequest: { operation: "diff", path, staged } });
      if (!result.workspaceGit) throw new Error("Git diff was not returned. Refresh to retry.");
      if (token === generation.current) {
        setDiff({
          title: path ?? (staged ? "Staged changes" : "Working tree changes"),
          content: result.workspaceGit.diff ?? "",
          truncated: result.workspaceGit.truncated
        });
      }
    } catch (error) {
      if (token === generation.current) {
        props.onFeedback({ level: "error", message: (error as Error).message });
      }
    } finally {
      if (token === generation.current) {
        setBusy(false);
      }
    }
  };
  const loadHistory = async (offset = 0, commit?: string) => {
    const token = generation.current;
    setBusy(true);
    try {
      const result = await request(
        "getWorkspaceEnvironment",
        {
          gitHistory: commit ? { commit } : { offset, ...(offset ? { ref: history?.ref } : {}) }
        },
        (saved) => {
          if (token === generation.current && !commit && saved.workspaceEnvironment?.gitHistory)
            setHistory(saved.workspaceEnvironment.gitHistory);
        }
      );
      if (token !== generation.current) {
        return;
      }
      if (commit && result.workspaceEnvironment?.gitCommit) {
        setSelectedCommit(commit);
        setDiff({
          title: `Commit ${commit.slice(0, 8)}`,
          content: result.workspaceEnvironment.gitCommit.diff,
          truncated: result.workspaceEnvironment.gitCommit.truncated
        });
      } else if (result.workspaceEnvironment?.gitHistory) {
        setHistory(result.workspaceEnvironment.gitHistory);
      } else {
        throw new Error("Git history was not returned. Refresh to retry.");
      }
    } catch (error) {
      if (token === generation.current) {
        props.onFeedback({ level: "error", message: (error as Error).message });
      }
    } finally {
      if (token === generation.current) {
        setBusy(false);
      }
    }
  };
  const confirm = (value: NonNullable<typeof dialog>) => {
    setField(value.field === "message" ? draft : "");
    setDialog(value);
  };
  const addRemote = () => confirm({
    title: "Add GitHub remote",
    description: "Add this URL as origin. You can use Git locally and add a remote without signing in.",
    request: { operation: "addRemote" },
    field: "remote",
    placeholder: "https://github.com/owner/repository.git"
  });
  const closeDialog = () => {
    if (busy) return;
    if (dialog?.request.operation === "addRemote") setNotice("Add remote cancelled.");
    setDialog(undefined);
  };
  const initializeRepository = async () => {
    if (busy || !props.connected) return;
    setBusy(true);
    try {
      const result = await request("workspaceGit", {
        gitRequest: { operation: "init", operationId: crypto.randomUUID() },
        confirmed: true
      });
      if (!result.workspaceGit) throw new Error("Git repository initialization was not confirmed. Refresh and retry.");
      setNotice(result.workspaceGit.warning || "Git repository initialized.");
      if (result.workspaceGit.warning) props.onFeedback({ level: "warning", message: result.workspaceGit.warning });
      await read();
      setNotice(result.workspaceGit.warning || "Git repository initialized.");
    } catch (error) {
      props.onFeedback({ level: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || Boolean(props.pending) || stale || !props.connected || !state?.environment?.isGitRepository;
  const environment = state?.environment;
  const hasOrigin = environment?.hasOriginRemote ?? environment?.hasRemote;
  const ownershipBlocked = /detected dubious ownership/i.test(readError);
  const changed = environment?.changedFiles ?? [];
  const staged = changed.filter((file) => file.index !== " " && file.index !== "?" && file.index !== "!");
  const working = changed.filter((file) => file.worktree !== " " || file.index === "?");
  return (
    <section class="workspace-git" aria-label="Git and GitHub" aria-busy={busy}>
      <header class="workspace-tool-toolbar">
        <ToolIcon kind="branch" />
        <strong title={state?.branch ?? ""}>{state?.branch || "Repository"}</strong>
        <span
          class="workspace-tool-meta"
          title={`${environment?.ahead ?? 0} outgoing · ${environment?.behind ?? 0} incoming`}
        >
          ↑{environment?.ahead ?? 0} ↓{environment?.behind ?? 0}
        </span>

        <WorkspaceMenu label="Repository actions" icon={<ToolIcon kind="more" />}>
          <div>
            <button type="button" disabled={busy || !props.connected || !props.projectPath} onClick={() => void read()}>Refresh Git</button>
            {!hasOrigin && <button type="button" disabled={disabled} onClick={addRemote}>Add GitHub remote</button>}
            {hasOrigin && <button type="button" disabled={disabled || Boolean(authActive)} onClick={() => void startAuth()}>Authorize GitHub HTTPS</button>}
            {(["fetch", "pull", "push"] as const).map((operation) => (
              <button
                type="button"
                disabled={disabled}
                onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                  confirm({
                    title:
                      operation === "fetch" ? "Fetch remotes" : operation === "pull" ? "Pull changes" : "Push branch",
                    description:
                      operation === "pull"
                        ? "Only a fast-forward update is allowed. Local changes and diverged branches are preserved for review."
                        : operation === "push"
                          ? "Push this repository’s current branch. If no upstream exists, set origin as its upstream."
                          : "Fetch all configured remotes and remove obsolete tracking references.",
                    request: { operation }
                  });
                }}
              >
                {operation === "fetch"
                  ? "Fetch all remotes"
                  : operation === "pull"
                    ? "Pull · fast-forward only"
                    : "Push branch"}
              </button>
            ))}
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                confirm({
                  title: "Abort merge?",
                  description:
                    "Git will attempt to restore the state before the active merge. Save any work made during conflict resolution first.",
                  request: { operation: "abortMerge" }
                })
              }
            >
              Abort merge
            </button>
          </div>
        </WorkspaceMenu>
      </header>
      <MobileSectionPicker label="Git view" value={view} options={(['changes','history','branches','stashes','github'] as const).map(value=>({value,label:value==='github'?'GitHub':value[0]!.toUpperCase()+value.slice(1)}))} onChange={value=>{setView(value);setFilter('');if(value==='history'&&!history&&environment?.isGitRepository)void loadHistory();}}/>
      <nav class="workspace-tool-tabs" aria-label="Git views" role="tablist" onKeyDown={handleTabKeyDown}>
        {(["changes", "history", "branches", "stashes", "github"] as const).map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={view === tab}
            tabIndex={view === tab ? 0 : -1}
            onClick={() => {
              setView(tab);
              setFilter("");
              if (tab === "history" && !history && environment?.isGitRepository) {
                void loadHistory();
              }
            }}
          >
            {tab === "github" ? "GitHub" : tab[0]!.toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>
      {notice ? <pre class="workspace-tool-output" aria-label="Git output" role="status">{notice}</pre> : null}
      {view === "github" && !readError && (state || setupRequired) ? (
        <WorkspaceGitHub
          {...props}
          hasOrigin={hasOrigin}
          authorizedAttempt={authorizedAttempt}
          canAddRemote={!disabled}
          onAddRemote={addRemote}
          onRepositoryInitialized={() => void read()}
        />
      ) : (
        <div class="workspace-tool-scroll">
          {!state || !environment?.isGitRepository ? (
            <div class="workspace-tool-empty">
              <ToolIcon kind="branch" />
              <strong>{busy ? "Reading repository…" : setupRequired ? "No Git repository" : ownershipBlocked ? "Git blocked this repository" : "Repository unavailable"}</strong>
              <p>{setupRequired ? "Initialize Git in this project to use source control." : ownershipBlocked ? "Git sees a different owner for this checkout. Run Codex Manager under the account that owns the project, then refresh." : "Select a Git project, or refresh when its folder is available."}</p>
              {readError && !busy ? <pre class="workspace-tool-output" role="alert">{ownershipBlocked ? readError.split(/\r?\n/)[0] : readError}</pre> : null}
              {setupRequired ? (
                <button type="button" disabled={busy || !props.connected} onClick={() => void initializeRepository()}>
                  Initialize repository
                </button>
              ) : (
                <button type="button" disabled={busy || !props.connected || !props.projectPath} onClick={() => void read()}>
                  Refresh Git
                </button>
              )}
            </div>
          ) : view === "changes" ? (
            <>
              <form
                class="workspace-commit"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run({ operation: "commit", message: draft, staged: true });
                }}
              >
                <label>
                  Commit message
                  <textarea
                    aria-label="Commit message"
                    value={draft}
                    maxLength={2000}
                    rows={2}
                    placeholder="Describe your changes…"
                    onInput={(event) => props.onDraft(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="submit"
                  disabled={disabled || !draft.trim() || !staged.length}
                  class="workspace-icon-action"
                  title="Commit staged changes"
                  aria-label="Commit staged changes"
                >
                  <ToolIcon kind="check" />
                </button>
              </form>
              {(
                [
                  ["Staged changes", staged, true],
                  ["Changes", working, false]
                ] as const
              ).map(([title, files, index]) => (
                <section class="workspace-file-group">
                  <header>
                    <strong>{title}</strong>
                    <small>{files.length}</small>
                    <button
                      type="button"
                      disabled={disabled || !files.length}
                      title={index ? "Unstage all" : "Stage all"}
                      aria-label={index ? "Unstage all" : "Stage all"}
                      onClick={() => void run({ operation: index ? "unstage" : "stage" })}
                    >
                      <ToolIcon kind={index ? "minus" : "plus"} />
                    </button>
                    <button
                      type="button"
                      title={`View ${title.toLowerCase()}`}
                      aria-label={`View ${title.toLowerCase()}`}
                      disabled={busy || !props.connected}
                      onClick={() => void preview(undefined, index)}
                    >
                      <ToolIcon kind="search" />
                    </button>
                  </header>
                  {files.map((file) => (
                    <div class="workspace-git-file" key={file.path}>
                      <button
                        type="button"
                        class="workspace-file-name"
                        title={file.path}
                        onClick={() =>
                          file.index === "?"
                            ? props.onOpenFile(file.path.endsWith("/") ? "" : file.path)
                            : void preview(file.path, index)
                        }
                      >
                        <span>{file.path.split("/").filter(Boolean).pop()}</span>
                        <small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</small>
                      </button>
                      <code title={`Index ${file.index} · working tree ${file.worktree}`}>
                        {index ? file.index : file.worktree === "?" ? "U" : file.worktree}
                      </code>
                      <button
                        type="button"
                        title="Open file"
                        aria-label={`Open ${file.path}`}
                        onClick={() => props.onOpenFile(file.path)}
                      >
                        <ToolIcon kind="external" />
                      </button>
                      {!index && file.index !== "?" ? (
                        <button
                          type="button"
                          title="Discard unstaged changes"
                          aria-label={`Discard changes in ${file.path}`}
                          disabled={disabled}
                          onClick={() =>
                            confirm({
                              title: "Discard file changes?",
                              description: `Restore ${file.path} to its staged version. Unstaged edits will be lost.`,
                              request: { operation: "discard", path: file.path }
                            })
                          }
                        >
                          <ToolIcon kind="clear" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        title={index ? "Unstage file" : "Stage file"}
                        aria-label={`${index ? "Unstage" : "Stage"} ${file.path}`}
                        disabled={disabled}
                        onClick={() => void run({ operation: index ? "unstage" : "stage", path: file.path })}
                      >
                        <ToolIcon kind={index ? "minus" : "plus"} />
                      </button>
                    </div>
                  ))}
                  {!files.length ? (
                    <p class="workspace-empty-inline">
                      {!environment
                        ? "Repository state unavailable"
                        : index
                          ? "No staged changes"
                          : "Working tree clean"}
                    </p>
                  ) : null}
                </section>
              ))}
            </>
          ) : view === "history" ? (
            <section class="workspace-history">
              <header>
                <strong>Project history</strong>

              </header>
              {history?.commits.map((commit) => (
                <button
                  class="workspace-history-row"
                  type="button"
                  key={commit.hash}
                  title={`${commit.subject}\n${commit.author} · ${commit.date}`}
                  disabled={busy || !props.connected}
                  onClick={() => void loadHistory(0, commit.hash)}
                >
                  <span>
                    <strong>{commit.subject}</strong>
                    <small>
                      {commit.author} · {new Date(commit.date).toLocaleDateString()}
                    </small>
                  </span>
                  <code>{commit.hash.slice(0, 7)}</code>
                </button>
              ))}
              {!history?.commits.length ? (
                <p class="workspace-empty-inline">{busy ? "Reading commits…" : "No project commits loaded."}</p>
              ) : null}
              <footer>
                {history && history.offset > 0 ? (
                  <button
                    type="button"
                    disabled={busy || !props.connected}
                    onClick={() => void loadHistory(Math.max(0, history.offset - 50))}
                    class="workspace-icon-action"
                    title="Newer page"
                    aria-label="Newer page"
                  >
                    <ToolIcon kind="left" />
                  </button>
                ) : null}
                {history?.hasMore ? (
                  <button
                    type="button"
                    disabled={busy || !props.connected}
                    onClick={() => void loadHistory(history.offset + 50)}
                    class="workspace-icon-action"
                    title="Older page"
                    aria-label="Older page"
                  >
                    <ToolIcon kind="right" />
                  </button>
                ) : null}
              </footer>
            </section>
          ) : view === "branches" ? (
            <>
              <div class="workspace-list-heading">
                <input
                  aria-label="Filter branches"
                  value={filter}
                  placeholder="Filter branches…"
                  onInput={(event) => setFilter(event.currentTarget.value)}
                />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    confirm({
                      title: "Create branch",
                      description: "Create and switch to a new branch from the current HEAD.",
                      request: { operation: "createBranch" },
                      field: "name",
                      placeholder: "feature/branch-name"
                    })
                  }
                  class="workspace-icon-action"
                  title="New"
                  aria-label="New"
                >
                  <ToolIcon kind="plus" />
                </button>
              </div>
              {(state?.branches ?? [])
                .filter((branch) => branch.name.toLowerCase().includes(filter.toLowerCase()))
                .map((branch) => (
                  <div class="workspace-branch-row" key={branch.name}>
                    <ToolIcon kind="branch" />
                    <span>
                      <strong>{branch.name}</strong>
                      <small>
                        {branch.current ? "Current branch" : branch.remote ? "Remote tracking branch" : "Local branch"}
                      </small>
                    </span>
                    {branch.current ? (
                      <ToolIcon kind="check" />
                    ) : !branch.remote ? (
                      <WorkspaceMenu label={`Actions for ${branch.name}`} icon={<ToolIcon kind="more" />}>
                        <div>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() =>
                              confirm({
                                title: "Switch branch?",
                                description: `Switch this repository to ${branch.name}. Git will preserve changes or report a conflict.`,
                                request: { operation: "switch", ref: branch.name }
                              })
                            }
                          >
                            Switch branch
                          </button>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() =>
                              confirm({
                                title: "Merge branch?",
                                description: `Merge ${branch.name} into ${state?.branch}. Conflicts remain available for resolution.`,
                                request: { operation: "merge", ref: branch.name }
                              })
                            }
                          >
                            Merge into current
                          </button>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() =>
                              confirm({
                                title: "Rename branch",
                                description: branch.name,
                                request: { operation: "renameBranch", ref: branch.name },
                                field: "name"
                              })
                            }
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() =>
                              confirm({
                                title: "Delete branch?",
                                description: `Delete ${branch.name} only if Git confirms it has been merged. Force deletion is not used.`,
                                request: { operation: "deleteBranch", ref: branch.name }
                              })
                            }
                          >
                            Delete merged branch
                          </button>
                        </div>
                      </WorkspaceMenu>
                    ) : (
                      <button
                        type="button"
                        disabled={disabled}
                        title="Create a local branch from this remote reference"
                        onClick={() =>
                          confirm({
                            title: "Track remote branch",
                            description: `Create a local branch from ${branch.name}.`,
                            request: { operation: "createBranch", ref: branch.name },
                            field: "name",
                            placeholder: branch.name.replace(/^[^/]+\//, "")
                          })
                        }
                      >
                        <ToolIcon kind="plus" />
                      </button>
                    )}
                  </div>
                ))}
              {state?.truncated ? (
                <p role="status">First 500 branches shown. Open VS Code for the complete list.</p>
              ) : null}
            </>
          ) : (
            <>
              <div class="workspace-list-heading">
                <strong>Saved work</strong>
                <button
                  type="button"
                  disabled={disabled || !changed.length}
                  onClick={() =>
                    confirm({
                      title: "Stash working changes",
                      description:
                        "Save tracked and untracked changes, then restore a clean working tree. Ignored files stay in place.",
                      request: { operation: "stash" },
                      field: "message",
                      placeholder: "Describe this work"
                    })
                  }
                  class="workspace-icon-action"
                  title="Create stash"
                  aria-label="Create stash"
                >
                  <ToolIcon kind="archive" />
                </button>
              </div>
              {(state?.stashes ?? []).map((stash) => (
                <div class="workspace-stash-row" key={stash.hash}>
                  <span>
                    <strong>{stash.subject}</strong>
                    <small>
                      {stash.name} · {stash.hash.slice(0, 8)}
                    </small>
                  </span>
                  <WorkspaceMenu label={`Actions for ${stash.name}`} icon={<ToolIcon kind="more" />}>
                    <div>
                      {(["applyStash", "popStash", "dropStash"] as const).map((operation) => (
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            confirm({
                              title:
                                operation === "applyStash"
                                  ? "Apply stash?"
                                  : operation === "popStash"
                                    ? "Apply and remove stash?"
                                    : "Delete stash?",
                              description:
                                operation === "dropStash"
                                  ? `${stash.subject} will be removed. This cannot be undone from this panel.`
                                  : `Apply ${stash.subject}. Conflicting work is preserved for review.`,
                              request: { operation, ref: stash.hash }
                            })
                          }
                        >
                          {operation === "applyStash"
                            ? "Apply · keep stash"
                            : operation === "popStash"
                              ? "Pop · remove after applying"
                              : "Delete stash"}
                        </button>
                      ))}
                    </div>
                  </WorkspaceMenu>
                </div>
              ))}
              {!state?.stashes.length ? <p class="workspace-empty-inline">No saved stashes.</p> : null}
              <p class="workspace-empty-inline">Latest 50 stashes shown.</p>
            </>
          )}
        </div>
      )}
      {dialog ? (
        <WorkspaceDialog
          title={dialog.title}
          subtitle={dialog.description}
          onClose={closeDialog}
          footer={
            <>
              <button type="button" disabled={busy} onClick={closeDialog}>
                Cancel
              </button>
              <button
                type="button"
                disabled={disabled || Boolean(dialog.field && !field.trim())}
                onClick={() => void run({ ...dialog.request, ...(dialog.field ? { [dialog.field]: field } : {}) })}
              >
                {busy ? "Working…" : dialog.field === "remote" ? "Add remote" : "Confirm"}
              </button>
            </>
          }
        >
          {dialog.field ? (
            <label>
              {dialog.field === "name" ? "Branch name" : dialog.field === "remote" ? "GitHub remote URL" : "Message"}
              <input
                autoFocus
                maxLength={dialog.field === "name" ? 240 : dialog.field === "remote" ? 2048 : 2000}
                value={field}
                placeholder={dialog.placeholder}
                onInput={(event) => setField(event.currentTarget.value)}
              />
            </label>
          ) : (
            <p>Project: {environment?.projectName}</p>
          )}
          {stale ? <p>Refresh the repository before retrying.</p> : null}
        </WorkspaceDialog>
      ) : null}
      {auth ? (
        <WorkspaceDialog
          title="Authorize GitHub HTTPS"
          onClose={() => { if (!authActive) setAuth(undefined); else void cancelAuth(); }}
          footer={authActive ? (
            <button type="button" disabled={!props.connected || !auth.ready || auth.cancelling || Boolean(auth.state.message)} onClick={() => void cancelAuth()}>Cancel</button>
          ) : <button type="button" onClick={() => setAuth(undefined)}>Close</button>}
        >
          {auth.state.code ? (
            <>
              <p>Enter this code on GitHub to authorize HTTPS Git on the selected system.</p>
              <p><code>{auth.state.code}</code></p>
              <p><a href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">Open GitHub device verification</a></p>
            </>
          ) : null}
          <p role={auth.state.status === "failed" ? "alert" : "status"}>
            {auth.cancelling ? "Cancelling GitHub authorization…" : auth.state.message ?? (auth.state.code ? "Waiting for GitHub approval…" : "Starting GitHub authorization…")}
          </p>
          {authActive && (!props.connected || auth.statusError) ? (
            <p role="alert">{props.connected ? auth.statusError : "The selected system disconnected. Reconnect to check authorization."}</p>
          ) : null}
        </WorkspaceDialog>
      ) : null}
      {diff ? (
        <WorkspaceDialog
          title={diff.title}
          onClose={() => {
            setDiff(undefined);
            setSelectedCommit(undefined);
          }}
          className="workspace-diff-modal"
          footer={
            <button
              type="button"
              onClick={() => {
                setDiff(undefined);
                setSelectedCommit(undefined);
              }}
            >
              Close
            </button>
          }
        >
          <div class="workspace-diff-meta">
            {selectedCommit ? <code>{selectedCommit}</code> : null}
            {diff.truncated ? <p role="status">Preview limited. Open VS Code for the complete diff.</p> : null}
          </div>
          {diff.content.trim() ? props.renderDiff(diff.content) : <p>No tracked differences.</p>}
        </WorkspaceDialog>
      ) : null}
    </section>
  );
}
