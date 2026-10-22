import { WorkspaceMenu } from "./workspaceMenu";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  DashboardWorkspaceGitHistory,
  WorkspaceGitRequest,
  WorkspaceGitState
} from "../../src/domain/dashboard/types";
import { useWorkspaceRequest } from "./workspaceRequest";
import { WorkspaceDialog } from "./workspaceDialog";
import { ToolIcon } from "./workspaceTerminal";
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
  onPending: (pending: boolean, message?: string, committedDraft?: string) => void;
  onOpenFile: (path: string) => void;
  renderDiff: (diff: string) => ComponentChildren;
}) {
  const request = useWorkspaceRequest(props.projectPath, props.targetDeviceId, props.connected);
  const [view, setView] = useState<"changes" | "history" | "branches" | "stashes" | "github">("changes");
  const [state, setState] = useState<WorkspaceGitState>(),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [stale, setStale] = useState(true);
  const [history, setHistory] = useState<DashboardWorkspaceGitHistory>(),
    [selectedCommit, setSelectedCommit] = useState<string>(),
    [diff, setDiff] = useState<{ title: string; content: string; truncated?: boolean }>();
  const draft = props.draft;
  const [dialog, setDialog] = useState<{
    title: string;
    description: string;
    request: WorkspaceGitRequest;
    field?: "name" | "message";
    placeholder?: string;
  }>();
  const [field, setField] = useState(""),
    [filter, setFilter] = useState("");
  const generation = useRef(0);
  const previousPending = useRef(props.pending);
  const ownsPending = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  const read = async () => {
    const token = generation.current;
    setBusy(true);
    try {
      const result = await request("workspaceGit", { gitRequest: { operation: "read" } });
      if (token !== generation.current) {
        return;
      }
      if (!result.workspaceGit) {
        throw new Error("Git state was not returned. Update the selected system and retry.");
      }
      setState(result.workspaceGit);
      setStale(false);
      setNotice(result.workspaceGit.warning ?? "Repository refreshed.");
    } catch (error) {
      if (token === generation.current) {
        setNotice((error as Error).message);
        setStale(true);
      }
    } finally {
      if (token === generation.current) {
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (props.connected) {
      void read();
    } else if (!props.connected) {
      setStale(true);
      setNotice("Disconnected · reconnect and refresh Git before changing the repository.");
    }
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
  const run = async (operation: WorkspaceGitRequest) => {
    if (!state || stale || busy || props.pending) {
      return;
    }
    const token = generation.current;
    setBusy(true);
    setNotice("Working…");
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
      setNotice(result.workspaceGit.warning || result.workspaceGit.output || "Git operation completed.");
      setDialog(undefined);
    } catch (error) {
      props.onPending(false, (error as Error).message);
      if (token === generation.current) {
        setNotice((error as Error).message);
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
      if (token === generation.current && result.workspaceGit) {
        setDiff({
          title: path ?? (staged ? "Staged changes" : "Working tree changes"),
          content: result.workspaceGit.diff ?? "",
          truncated: result.workspaceGit.truncated
        });
      }
    } catch (error) {
      if (token === generation.current) {
        setNotice((error as Error).message);
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
      const result = await request("getWorkspaceEnvironment", {
        gitHistory: commit ? { commit } : { offset, ...(offset ? { ref: history?.ref } : {}) }
      });
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
        setNotice((error as Error).message);
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
  const disabled = busy || Boolean(props.pending) || stale || !props.connected;
  const environment = state?.environment;
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
        <button
          type="button"
          title="Refresh Git"
          aria-label="Refresh Git"
          disabled={busy || !props.connected}
          onClick={() => void read()}
        >
          <ToolIcon kind="refresh" />
        </button>
        <WorkspaceMenu label="Repository actions" icon={<ToolIcon kind="more" />}>
          <div>
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
              if (tab === "history" && !history) {
                void loadHistory();
              }
            }}
          >
            {tab === "github" ? "GitHub" : tab[0]!.toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>
      {view !== "github" && (notice || props.notice || props.pending) ? (
        <p class={`workspace-tool-notice ${stale ? "is-warning" : ""}`} role={stale ? "alert" : "status"}>
          {props.pending ? "Git operation in progress…" : props.notice || notice}
        </p>
      ) : null}
      {view === "github" ? (
        <WorkspaceGitHub {...props} />
      ) : (
        <div class="workspace-tool-scroll">
          {!state && view !== "changes" ? (
            <div class="workspace-tool-empty">
              <ToolIcon kind="branch" />
              <strong>{busy ? "Reading repository…" : "Repository unavailable"}</strong>
              <p>Select a Git project, or refresh when its folder is available.</p>
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
                <button type="submit" disabled={disabled || !draft.trim() || !staged.length}>
                  <ToolIcon kind="check" />
                  Commit staged <small>{staged.length}</small>
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
                <button type="button" disabled={busy || !props.connected} onClick={() => void loadHistory()}>
                  Refresh
                </button>
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
                  >
                    Newer
                  </button>
                ) : null}
                {history?.hasMore ? (
                  <button
                    type="button"
                    disabled={busy || !props.connected}
                    onClick={() => void loadHistory(history.offset + 50)}
                  >
                    Older
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
                >
                  <ToolIcon kind="plus" />
                  New
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
                >
                  <ToolIcon kind="plus" />
                  Stash
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
          onClose={() => {
            if (!busy) {
              setDialog(undefined);
            }
          }}
          footer={
            <>
              <button type="button" disabled={busy} onClick={() => setDialog(undefined)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={disabled || Boolean(dialog.field && !field.trim())}
                onClick={() => void run({ ...dialog.request, ...(dialog.field ? { [dialog.field]: field } : {}) })}
              >
                {busy ? "Working…" : "Confirm"}
              </button>
            </>
          }
        >
          {dialog.field ? (
            <label>
              {dialog.field === "name" ? "Branch name" : "Message"}
              <input
                autoFocus
                maxLength={dialog.field === "name" ? 240 : 2000}
                value={field}
                placeholder={dialog.placeholder}
                onInput={(event) => setField(event.currentTarget.value)}
              />
            </label>
          ) : (
            <p>Project: {environment?.projectName}</p>
          )}
          {stale ? <p role="alert">{props.pending ? "Git operation in progress…" : props.notice || notice}</p> : null}
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
