import { useEffect, useRef, useState } from "preact/hooks";
import type {
  WorkspaceGitHubItem,
  WorkspaceGitHubRequest,
  WorkspaceGitHubState
} from "../../src/domain/dashboard/types";
import { useWorkspaceRequest } from "./workspaceRequest";
import { WorkspaceDialog } from "./workspaceDialog";
import { ToolIcon } from "./icons";
import { handleTabKeyDown } from "./primitives";
import { createActionRequestId, postMessageToHost } from "./host";

type Form = {
  title: string;
  description: string;
  request: WorkspaceGitHubRequest;
  fields?: Array<{ key: string; label: string; multiline?: boolean; options?: string[]; required?: boolean }>;
};
export function WorkspaceGitHub(props: {
  projectPath?: string;
  targetDeviceId?: string;
  connected: boolean;
  pending?: boolean;
  onPending?: (pending: boolean, message?: string) => void;
}) {
  const request = useWorkspaceRequest(props.projectPath, props.targetDeviceId, props.connected);
  const [section, setSection] = useState<WorkspaceGitHubRequest["section"]>("pulls"),
    [stateFilter, setStateFilter] = useState<"open" | "closed" | "all">("open");
  const [state, setState] = useState<WorkspaceGitHubState>(),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [failed, setFailed] = useState(false);
  const [detail, setDetail] = useState<WorkspaceGitHubItem>(),
    [detailTab, setDetailTab] = useState<"activity" | "files" | "checks">("activity");
  const [form, setForm] = useState<Form>(),
    [values, setValues] = useState<Record<string, string>>({}),
    [formError, setFormError] = useState("");
  const revision = useRef(0);
  useEffect(
    () => () => {
      revision.current++;
    },
    []
  );
  const load = async (query: Partial<WorkspaceGitHubRequest> = {}) => {
    const token = ++revision.current;
    setBusy(true);
    setNotice("Loading GitHub…");
    try {
      const result = await request("workspaceGitHub", {
        githubRequest: { section, operation: "read", state: stateFilter, ...query }
      });
      if (token !== revision.current) {
        return;
      }
      if (!result.workspaceGitHub) {
        throw new Error("GitHub data was not returned. Update the selected system and retry.");
      }
      setState(result.workspaceGitHub);
      setNotice(
        result.workspaceGitHub.warning ??
          (query.operation === "connect" ? "GitHub connected on the selected system." : "")
      );
      setFailed(false);
      setFormError("");
      if (query.operation === "detail") {
        setDetail(result.workspaceGitHub.detail);
        setDetailTab("activity");
      }
    } catch (error) {
      if (token === revision.current) {
        setNotice((error as Error).message);
        setFailed(true);
      }
    } finally {
      if (token === revision.current) {
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    setState(undefined);
    setDetail(undefined);
  }, [section, stateFilter]);
  useEffect(() => {
    if (props.connected && !props.pending) {
      void load();
    } else if (!props.connected) {
      revision.current++;
      setBusy(false);
      setNotice("Disconnected · GitHub actions are unavailable.");
      setFailed(true);
    }
  }, [section, stateFilter, request, props.connected]);
  const open = (url: string) => {
    if (url.startsWith("https://github.com/")) {
      postMessageToHost({
        type: "dashboard:action",
        action: "openExternalUrl",
        requestId: createActionRequestId(),
        payload: { url }
      });
    }
  };
  const showForm = (value: Form, initial: Record<string, string> = {}) => {
    setValues(initial);
    setFormError("");
    setForm(value);
  };
  const submit = async () => {
    if (!form || busy) {
      return;
    }
    for (const field of form.fields ?? []) {
      if (field.required && !values[field.key]?.trim()) {
        setFormError(`Enter ${field.label.toLowerCase()}.`);
        return;
      }
    }
    let inputs: Record<string, string> | undefined;
    if (values["inputs"]?.trim()) {
      try {
        const value: unknown = JSON.parse(values["inputs"]);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.values(value).some((item) => typeof item !== "string")
        ) {
          throw new Error();
        }
        inputs = value as Record<string, string>;
      } catch {
        setFormError("Workflow inputs must be a JSON object with text values.");
        return;
      }
    }
    const token = ++revision.current;
    setBusy(true);
    setFormError("");
    props.onPending?.(true);
    const data = {
      state: stateFilter,
      page: state?.page ?? 1,
      ...form.request,
      ...values,
      ...(inputs ? { inputs } : { inputs: undefined }),
      operationId: crypto.randomUUID()
    } as WorkspaceGitHubRequest;
    if (values["number"]) {
      data.number = Number(values["number"]);
    }
    if (values["draft"]) {
      data.draft = values["draft"] === "Draft";
    }
    if (values["prerelease"]) {
      data.prerelease = values["prerelease"] === "Prerelease";
    }
    try {
      const result = await request("workspaceGitHub", { githubRequest: data, confirmed: true });
      if (!result.workspaceGitHub) {
        throw new Error("GitHub did not confirm this action. Refresh and check its outcome before retrying.");
      }
      props.onPending?.(false, result.workspaceGitHub.warning || `${form.title} completed.`);
      if (token !== revision.current) {
        return;
      }
      const updated = result.workspaceGitHub;
      setState((current) => (updated.refreshFailed && current ? { ...current, warning: updated.warning } : updated));
      setNotice(updated.warning ? `${form.title} completed. ${updated.warning}` : `${form.title} completed.`);
      setFailed(updated.refreshFailed === true);
      setForm(undefined);
      setDetail(undefined);
    } catch (error) {
      props.onPending?.(false, (error as Error).message);
      if (token === revision.current) {
        setFormError((error as Error).message);
        setNotice((error as Error).message);
        setFailed(true);
      }
    } finally {
      if (token === revision.current) {
        setBusy(false);
      }
    }
  };
  const create = () => {
    const title =
      section === "pulls" ? "Create pull request" : section === "issues" ? "Create issue" : "Create release";
    showForm(
      {
        title,
        description: `Create this item in ${state?.repository}.`,
        request: { section, operation: "create" },
        fields: [
          { key: "title", label: "Title", required: true },
          ...(section === "pulls"
            ? [
                { key: "head", label: "Source branch", required: true },
                { key: "base", label: "Target branch", required: true }
              ]
            : section === "releases"
              ? [{ key: "tag", label: "Tag", required: true }]
              : []),
          { key: "body", label: "Description", multiline: true },
          ...(section !== "issues" ? [{ key: "draft", label: "Visibility", options: ["Draft", "Publish"] }] : []),
          ...(section === "releases"
            ? [{ key: "prerelease", label: "Release type", options: ["Stable", "Prerelease"] }]
            : [])
        ]
      },
      { base: state?.defaultBranch ?? "main", draft: "Draft", prerelease: "Stable" }
    );
  };
  const disabled = busy || Boolean(props.pending) || failed || !props.connected;
  const authenticated = state?.authenticated === true,
    canWrite = state?.canWrite === true;
  const itemActions = (item: WorkspaceGitHubItem) => (
    <div class="workspace-github-actions">
      <button type="button" onClick={() => open(item.url)}>
        <ToolIcon kind="external" />
        Open on GitHub
      </button>
      {section === "pulls" || section === "issues" ? (
        <>
          <button
            type="button"
            disabled={disabled || !authenticated}
            onClick={() =>
              showForm({
                title: "Add comment",
                description: `${state?.repository} · #${item.number}`,
                request: { section, operation: "comment", number: item.number },
                fields: [{ key: "body", label: "Comment", multiline: true, required: true }]
              })
            }
          >
            Comment
          </button>
          {item.state !== "merged" ? (
            <button
              type="button"
              disabled={disabled || !authenticated}
              onClick={() =>
                showForm({
                  title: item.state === "closed" ? "Reopen item" : "Close item",
                  description: `${item.title} · #${item.number}`,
                  request: { section, operation: item.state === "closed" ? "reopen" : "close", number: item.number }
                })
              }
            >
              {item.state === "closed" ? "Reopen" : "Close"}
            </button>
          ) : null}
          {section === "pulls" && ["open", "draft"].includes(item.state) ? (
            <>
              <button
                type="button"
                disabled={disabled || !authenticated || !item.headSha}
                onClick={() =>
                  showForm(
                    {
                      title: "Review pull request",
                      description: `Review commit ${item.headSha?.slice(0, 8)}. Your review remains attached to this revision.`,
                      request: { section, operation: "review", number: item.number, expectedHead: item.headSha },
                      fields: [
                        { key: "review", label: "Decision", options: ["COMMENT", "APPROVE", "REQUEST_CHANGES"] },
                        { key: "body", label: "Review", multiline: true }
                      ]
                    },
                    { review: "COMMENT" }
                  )
                }
              >
                Review
              </button>
              <button
                type="button"
                disabled={disabled || !canWrite || item.draft || !item.headSha}
                onClick={() =>
                  showForm(
                    {
                      title: "Merge pull request",
                      description: `Merge #${item.number} into ${item.base}. GitHub must confirm that the head is still ${item.headSha?.slice(0, 8)} and branch protections allow it.`,
                      request: { section, operation: "merge", number: item.number, expectedHead: item.headSha },
                      fields: [{ key: "method", label: "Merge method", options: ["squash", "merge", "rebase"] }]
                    },
                    { method: "squash" }
                  )
                }
              >
                Merge
              </button>
            </>
          ) : null}
        </>
      ) : section === "actions" ? (
        <>
          <button
            type="button"
            disabled={
              disabled ||
              !canWrite ||
              !["queued", "in_progress", "waiting", "pending", "requested"].includes(item.state)
            }
            onClick={() =>
              showForm({
                title: "Cancel workflow run",
                description: item.title,
                request: { section, operation: "cancelRun", number: item.id }
              })
            }
          >
            Cancel run
          </button>
          <button
            type="button"
            disabled={
              disabled || !canWrite || ["queued", "in_progress", "waiting", "pending", "requested"].includes(item.state)
            }
            onClick={() =>
              showForm({
                title: "Rerun workflow",
                description: `${item.title}. This starts another execution and may use GitHub Actions minutes.`,
                request: { section, operation: "rerun", number: item.id }
              })
            }
          >
            Rerun
          </button>
        </>
      ) : (
        <>
          {item.draft ? (
            <button
              type="button"
              disabled={disabled || !canWrite}
              onClick={() =>
                showForm({
                  title: "Publish release",
                  description: `Publish ${item.title}. This makes the draft release visible to repository readers.`,
                  request: { section, operation: "publishRelease", number: item.id, expectedUpdatedAt: item.updatedAt }
                })
              }
            >
              Publish
            </button>
          ) : null}
          <button
            type="button"
            disabled={disabled || !canWrite}
            onClick={() =>
              showForm({
                title: "Delete release",
                description: `Delete ${item.title} and its release assets. The Git tag remains. This action cannot be undone from this panel.`,
                request: { section, operation: "deleteRelease", number: item.id, expectedUpdatedAt: item.updatedAt }
              })
            }
          >
            Delete release
          </button>
        </>
      )}
    </div>
  );
  return (
    <section class="workspace-github" aria-label="GitHub repository tools" aria-busy={busy}>
      <header class="workspace-github-header">
        <ToolIcon kind="github" />
        <span>
          <strong>{state?.repository ?? "GitHub"}</strong>
          <small>
            {authenticated
              ? "Connected on selected system"
              : "Public repository · sign in for private data and actions"}
          </small>
        </span>
        <button
          type="button"
          title="Refresh GitHub"
          aria-label="Refresh GitHub"
          disabled={busy || !props.connected}
          onClick={() => void load()}
        >
          <ToolIcon kind="refresh" />
        </button>
        {!authenticated ? (
          <button type="button" disabled={busy || !props.connected} onClick={() => void load({ operation: "connect" })}>
            Connect
          </button>
        ) : null}
      </header>
      <nav class="workspace-tool-tabs" role="tablist" aria-label="GitHub sections" onKeyDown={handleTabKeyDown}>
        {(["pulls", "issues", "actions", "releases"] as const).map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={section === tab}
            tabIndex={section === tab ? 0 : -1}
            disabled={busy}
            onClick={() => setSection(tab)}
          >
            {tab === "pulls" ? "Pull requests" : tab[0]!.toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>
      {notice ? (
        <p role={failed ? "alert" : "status"} class={`workspace-tool-notice ${failed ? "is-warning" : ""}`}>
          {notice}
        </p>
      ) : null}
      <div class="workspace-list-heading">
        {section === "pulls" || section === "issues" ? (
          <select
            aria-label="GitHub item state"
            disabled={busy}
            value={stateFilter}
            onChange={(event) => setStateFilter(event.currentTarget.value as typeof stateFilter)}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        ) : (
          <strong>{section === "actions" ? "Workflow runs" : "Releases"}</strong>
        )}
        {section !== "actions" ? (
          <button
            type="button"
            disabled={disabled || !authenticated || (section === "releases" && !canWrite)}
            onClick={create}
          >
            <ToolIcon kind="plus" />
            New
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || !canWrite || !state?.workflows?.length}
            onClick={() =>
              showForm(
                {
                  title: "Run workflow",
                  description:
                    "Choose a workflow that supports workflow_dispatch. GitHub validates its branch and inputs.",
                  request: { section, operation: "dispatch" },
                  fields: [
                    {
                      key: "number",
                      label: "Workflow",
                      options: state?.workflows?.filter((item) => item.state === "active").map((item) => `${item.id}`)
                    },
                    { key: "ref", label: "Branch or tag", required: true },
                    { key: "inputs", label: "Inputs (JSON object)", multiline: true }
                  ]
                },
                {
                  number: String(state?.workflows?.find((item) => item.state === "active")?.id ?? ""),
                  ref: state?.defaultBranch ?? "main",
                  inputs: "{}"
                }
              )
            }
          >
            <ToolIcon kind="plus" />
            Run
          </button>
        )}
      </div>
      <div class="workspace-tool-scroll">
        {state?.items.map((item) => (
          <button
            class="workspace-github-row"
            type="button"
            key={item.id}
            disabled={busy || !props.connected}
            title={item.title}
            onClick={() => void load({ operation: "detail", number: item.number ?? item.id, page: state.page })}
          >
            <span>
              <strong>{item.title || "Untitled"}</strong>
              <small>
                {[
                  item.number ? `#${item.number}` : item.ref,
                  item.author,
                  item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : ""
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </span>
            <span class={`workspace-github-state is-${item.state}`}>{item.state}</span>
          </button>
        ))}
        {!state?.items.length ? (
          <div class="workspace-tool-empty">
            <ToolIcon kind="github" />
            <p>
              {busy
                ? "Loading repository…"
                : failed
                  ? "Use Refresh to retry. Previously loaded data stays visible when available."
                  : "No items in this view."}
            </p>
          </div>
        ) : null}
        <footer class="workspace-pagination">
          {state && state.page > 1 ? (
            <button
              type="button"
              disabled={busy || !props.connected}
              onClick={() => void load({ page: state.page - 1 })}
            >
              Newer
            </button>
          ) : null}
          {state?.hasMore ? (
            <button
              type="button"
              disabled={busy || !props.connected}
              onClick={() => void load({ page: state.page + 1 })}
            >
              Older
            </button>
          ) : null}
        </footer>
        {state?.workflows?.length ? (
          <details class="workspace-workflows">
            <summary>Available workflows</summary>
            {state.workflows.map((item) => (
              <p>
                <strong>{item.name}</strong>
                <small>
                  #{item.id} · {item.state}
                </small>
              </p>
            ))}
          </details>
        ) : null}
      </div>
      {detail ? (
        <WorkspaceDialog
          title={detail.title}
          className="workspace-github-detail"
          onClose={() => setDetail(undefined)}
          footer={itemActions(detail)}
        >
          <div class="workspace-github-detail-meta">
            <span>{detail.number ? `#${detail.number}` : detail.ref}</span>
            <span>{detail.state}</span>
            <span>{detail.author}</span>
          </div>
          <nav class="workspace-tool-tabs" role="tablist" aria-label="GitHub item details" onKeyDown={handleTabKeyDown}>
            {(
              [
                "activity",
                ...(section === "pulls" ? ["files", "checks"] : section === "actions" ? ["checks"] : [])
              ] as Array<typeof detailTab>
            ).map((tab) => (
              <button type="button" role="tab" aria-selected={detailTab === tab} onClick={() => setDetailTab(tab)}>
                {tab === "activity" ? "Overview & activity" : tab === "files" ? "Files" : "Checks & jobs"}
              </button>
            ))}
          </nav>
          {state?.warning ? <p role="status">{state.warning}</p> : null}
          {detailTab === "activity" ? (
            <div class="workspace-github-timeline">
              <p class="workspace-github-body">{detail.body || "No description."}</p>
              {state?.comments?.map((comment) => (
                <article key={comment.id}>
                  <header>
                    <strong>{comment.author}</strong>
                    <time>{new Date(comment.createdAt).toLocaleString()}</time>
                  </header>
                  <p>{comment.body}</p>
                </article>
              ))}
            </div>
          ) : detailTab === "files" ? (
            <div class="workspace-github-files">
              {state?.files?.map((file) => (
                <details key={file.path}>
                  <summary>
                    <strong>{file.path}</strong>
                    <small>
                      {file.status} · +{file.additions} −{file.deletions}
                    </small>
                  </summary>
                  <pre>{file.patch || "Binary or large file. Open on GitHub for its full diff."}</pre>
                </details>
              ))}
              <p class="workspace-empty-inline">
                First 100 changed files shown. Open on GitHub for the complete review.
              </p>
            </div>
          ) : (
            <div class="workspace-github-checks">
              {state?.checks?.map((check, index) => (
                <div key={`${check.id}:${index}`}>
                  <strong>{check.name}</strong>
                  <span>{check.status}</span>
                </div>
              ))}
              {!state?.checks?.length ? <p>No checks or jobs available.</p> : null}
              <p class="workspace-empty-inline">Open on GitHub for logs, artifacts and the complete run.</p>
            </div>
          )}
        </WorkspaceDialog>
      ) : null}
      {form ? (
        <WorkspaceDialog
          title={form.title}
          subtitle={form.description}
          onClose={() => {
            if (!busy) {
              setForm(undefined);
              setNotice("GitHub action cancelled.");
            }
          }}
          footer={
            <>
              {failed ? (
                <button type="button" disabled={busy || !props.connected} onClick={() => void load()}>
                  Refresh status
                </button>
              ) : null}
              {failed && /sign-in|Connect GitHub/i.test(formError) ? (
                <button
                  type="button"
                  disabled={busy || !props.connected}
                  onClick={() => void load({ operation: "connect" })}
                >
                  Sign in
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setForm(undefined);
                  setNotice("GitHub action cancelled.");
                }}
              >
                Cancel
              </button>
              <button type="button" disabled={busy || failed || !props.connected} onClick={() => void submit()}>
                {busy ? "Working…" : "Confirm"}
              </button>
            </>
          }
        >
          {form.fields?.map((field) => (
            <label key={field.key}>
              {field.label}
              {field.options ? (
                <select
                  value={values[field.key] ?? field.options[0] ?? ""}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    setValues((current) => ({ ...current, [field.key]: text }));
                  }}
                >
                  {field.options.map((option) => (
                    <option value={option}>
                      {field.key === "number"
                        ? state?.workflows?.find((item) => String(item.id) === option)?.name || option
                        : option}
                    </option>
                  ))}
                </select>
              ) : field.multiline ? (
                <textarea
                  rows={5}
                  maxLength={20_000}
                  value={values[field.key] ?? ""}
                  onInput={(event) => {
                    const text = event.currentTarget.value;
                    setValues((current) => ({ ...current, [field.key]: text }));
                  }}
                />
              ) : (
                <input
                  maxLength={256}
                  value={values[field.key] ?? ""}
                  onInput={(event) => {
                    const text = event.currentTarget.value;
                    setValues((current) => ({ ...current, [field.key]: text }));
                  }}
                />
              )}
            </label>
          ))}
          {!form.fields?.length ? <p>Repository: {state?.repository}</p> : null}
          {formError ? (
            <p role="alert" class="workspace-tool-notice is-warning">
              {formError}
            </p>
          ) : null}
        </WorkspaceDialog>
      ) : null}
    </section>
  );
}
