import { useEffect, useRef, useState } from "preact/hooks";
import type { OfficeUser, OfficeMcpServer, OfficeFeature, OfficeRole } from "../../src/services/officeUsers";
import { handleTabKeyDown, ModalShell } from "./primitives";

type Section = "users" | "workspace" | "mcp" | "database";
type EditorTab = "profile" | "permissions" | "data";
type TeamSettings = { workspaceRoot: string; databaseProvider: "sqlite" | "postgres"; postgresConfigured: boolean };
type UserDraft = {
  id?: string;
  username: string;
  displayName: string;
  password: string;
  role: OfficeRole;
  enabled: boolean;
  workspacePath: string;
  defaultPrompt: string;
  features: OfficeFeature[];
  mcpServers: string[];
};
const SECTIONS: { id: Section; title: string; description: string }[] = [
  { id: "users", title: "Users", description: "Manage sign-in, workspace access, and permissions." },
  { id: "workspace", title: "Workspace", description: "Choose where new Team user workspaces are created." },
  { id: "mcp", title: "MCP data access", description: "Manage the data connections available to your Team." },
  { id: "database", title: "Database", description: "Configure storage for Team users and data connections." }
];
const FEATURES: { id: OfficeFeature; title: string; description: string }[] = [
  { id: "generalChat", title: "General chat", description: "Everyday conversations in the user workspace." },
  { id: "tasks", title: "Task workspace", description: "Projects and assistant tasks." },
  { id: "files", title: "Files", description: "Browse and edit workspace files." },
  { id: "browser", title: "Browser", description: "Open pages in the workspace browser." },
  { id: "env", title: "Environment", description: "View development environment details." },
  { id: "terminal", title: "Terminal", description: "Access workspace terminals." },
  { id: "git", title: "Git", description: "Use repository and review tools." },
  { id: "github", title: "GitHub", description: "Access GitHub features." }
];
const roleLabel = (role: OfficeRole): string =>
  role === "unrestricted-admin" ? "Unrestricted admin" : role === "admin" ? "Admin" : "User";
const newUser = (): UserDraft => ({
  username: "",
  displayName: "",
  password: "",
  role: "user",
  enabled: true,
  workspacePath: "",
  defaultPrompt: "",
  features: ["generalChat", "tasks", "files", "browser"],
  mcpServers: []
});

export async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      signal: controller.signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok)
      throw new Error(
        result.error ??
          (response.status === 401
            ? "Your session expired. Sign in again."
            : "Team settings could not be loaded. Enable Team workspace in General settings and retry.")
      );
    return result;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        method === "GET"
          ? "Loading timed out. Retry when the host is available."
          : "The result could not be confirmed. Refresh before retrying to avoid duplicate changes."
      );
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export function TeamManagementPage() {
  const [section, setSection] = useState<Section>("users");
  const [sectionSearch, setSectionSearch] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [users, setUsers] = useState<OfficeUser[]>([]);
  const [servers, setServers] = useState<OfficeMcpServer[]>([]);
  const [settings, setSettings] = useState<TeamSettings>();
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [databaseProvider, setDatabaseProvider] = useState<"sqlite" | "postgres">("sqlite");
  const [postgresUrl, setPostgresUrl] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [draft, setDraft] = useState<UserDraft>();
  const [editorTab, setEditorTab] = useState<EditorTab>("profile");
  const [editorError, setEditorError] = useState("");
  const [deleting, setDeleting] = useState<OfficeUser>();
  const [mcpDraft, setMcpDraft] = useState({ id: "", label: "", endpoint: "" });

  const load = async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const [userData, mcpData, teamSettings] = await Promise.all([
        request<{ users: OfficeUser[] }>("/api/office/users"),
        request<{ servers: OfficeMcpServer[] }>("/api/office/mcp"),
        request<TeamSettings>("/api/office/settings")
      ]);
      setUsers(userData.users);
      setServers(mcpData.servers);
      setSettings(teamSettings);
      setWorkspaceRoot(teamSettings.workspaceRoot);
      setDatabaseProvider(teamSettings.databaseProvider);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Team settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const mutate = async (work: () => Promise<void>, success: string, inEditor = false): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setEditorError("");
    setNotice("");
    try {
      await work();
      setNotice(success);
    } catch (value) {
      const message = value instanceof Error ? value.message : "Your change could not be saved.";
      if (inEditor) setEditorError(message);
      else setError(message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const edit = (user?: OfficeUser): void => {
    setDraft(
      user ? { ...user, features: [...user.features], mcpServers: [...user.mcpServers], password: "" } : newUser()
    );
    setEditorTab("profile");
    setEditorError("");
  };
  const closeEditor = (): void => {
    if (!busy.current) {
      setDraft(undefined);
      setNotice("User editing cancelled.");
    }
  };
  const saveUser = (): void => {
    if (!draft) return;
    if (!draft.id && (draft.username.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.username.trim()))) {
      setEditorError("Enter the user's email address. It is their sign-in username.");
      setEditorTab("profile");
      return;
    }
    if ((!draft.id || draft.password) && (draft.password.length < 8 || draft.password.length > 256)) {
      setEditorError("Use a password between 8 and 256 characters.");
      setEditorTab("profile");
      return;
    }
    void mutate(
      async () => {
        const { id, ...fields } = draft;
        const result = await request<{ user: OfficeUser }>(
          id ? `/api/office/users/${encodeURIComponent(id)}` : "/api/office/users",
          id ? "PATCH" : "POST",
          { ...fields, password: fields.password || undefined, workspacePath: fields.workspacePath.trim() || undefined }
        );
        setUsers((current) =>
          id ? current.map((user) => (user.id === id ? result.user : user)) : [...current, result.user]
        );
        setDraft(undefined);
      },
      draft.id ? "User settings saved." : "Team user created.",
      true
    );
  };
  const saveMcp = (next: OfficeMcpServer[]): void => {
    void mutate(async () => {
      const result = await request<{ servers: OfficeMcpServer[] }>("/api/office/mcp", "PUT", { servers: next });
      setServers(result.servers);
      setMcpDraft({ id: "", label: "", endpoint: "" });
    }, "Data connections saved.");
  };
  const saveSettings = (fields: Record<string, string>): void => {
    void mutate(async () => {
      const result = await request<TeamSettings>("/api/office/settings", "PUT", fields);
      setSettings(result);
      setWorkspaceRoot(result.workspaceRoot);
      setDatabaseProvider(result.databaseProvider);
      setPostgresUrl("");
    }, "Team settings saved.");
  };
  const currentSection = SECTIONS.find((item) => item.id === section)!;
  const filteredUsers = users.filter((user) =>
    `${user.displayName} ${user.username}`.toLowerCase().includes(userSearch.toLowerCase())
  );

  return (
    <div class="team-management-page">
      <header class="team-management-head">
        <div>
          <span class="team-eyebrow">Administration</span>
          <h1>Team settings</h1>
          <p>People, workspace access, and shared services.</p>
        </div>
        <a class="team-button" href="/">
          Back to dashboard
        </a>
      </header>
      <div class="team-settings-layout">
        <aside class="team-settings-sidebar">
          <input
            type="search"
            aria-label="Find a section"
            placeholder="Find a section…"
            value={sectionSearch}
            onInput={(event) => setSectionSearch(event.currentTarget.value)}
          />
          <span class="team-eyebrow">Team</span>
          <nav aria-label="Team settings sections">
            {SECTIONS.filter((item) => item.title.toLowerCase().includes(sectionSearch.toLowerCase())).map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => {
                  setSection(item.id);
                  setError("");
                  setNotice("");
                }}
              >
                {item.title}
              </button>
            ))}
          </nav>
        </aside>
        <section class="team-settings-content" aria-label={currentSection.title}>
          <div class="team-section-head">
            <div>
              <h2>{currentSection.title}</h2>
              <p>{currentSection.description}</p>
            </div>
            {section === "users" ? (
              <button
                type="button"
                class="team-button primary"
                disabled={loading || pending || !settings}
                onClick={() => edit()}
              >
                Add user
              </button>
            ) : null}
          </div>
          {notice ? (
            <div class="team-notice" role="status">
              {notice}
            </div>
          ) : null}
          {error ? (
            <div class="team-notice is-error" role="alert">
              {error}
              <button class="team-button" type="button" disabled={pending || loading} onClick={() => void load()}>
                Refresh
              </button>
            </div>
          ) : null}
          {loading ? (
            <p role="status" class="team-empty">
              Loading Team settings…
            </p>
          ) : section === "users" ? (
            <>
              <div class="team-list-toolbar">
                <input
                  type="search"
                  aria-label="Search users"
                  placeholder="Search users…"
                  value={userSearch}
                  onInput={(event) => setUserSearch(event.currentTarget.value)}
                />
                <span>
                  {users.length} {users.length === 1 ? "user" : "users"}
                </span>
              </div>
              <div class="team-user-list" role="list" aria-label="Team users">
                {filteredUsers.map((user) => (
                  <div class="team-user-row" role="listitem" key={user.id}>
                    <div class="team-user-identity">
                      <span class="team-avatar" aria-hidden="true">
                        {(user.displayName || user.username).slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <strong>{user.displayName}</strong>
                        <small>{user.username}</small>
                      </div>
                    </div>
                    <span class="team-role">{roleLabel(user.role)}</span>
                    <span class={`team-status ${user.enabled ? "is-enabled" : ""}`}>
                      {user.enabled ? "Active" : "Disabled"}
                    </span>
                    <div class="team-row-actions">
                      <button
                        type="button"
                        class="team-button"
                        disabled={pending}
                        onClick={() => edit(user)}
                        aria-label={`Edit ${user.username}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        class="team-button danger"
                        disabled={pending}
                        onClick={() => {
                          setDeleting(user);
                          setError("");
                        }}
                        aria-label={`Delete ${user.username}`}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
                {!filteredUsers.length ? (
                  <div class="team-empty">
                    <strong>{users.length ? "No matching users" : "No Team users yet"}</strong>
                    <p>
                      {users.length
                        ? "Try a different name or username."
                        : "Add a user to give them a private workspace and sign-in."}
                    </p>
                  </div>
                ) : null}
              </div>
            </>
          ) : section === "workspace" ? (
            <form
              class="team-settings-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveSettings({ workspaceRoot });
              }}
            >
              <label>
                Workspace root
                <input
                  value={workspaceRoot}
                  onInput={(event) => setWorkspaceRoot(event.currentTarget.value)}
                  required
                />
                <small>New users receive their own folder here. Existing user folders stay in place.</small>
              </label>
              <div class="team-form-footer">
                <button type="submit" class="team-button primary" disabled={pending || !settings}>
                  {pending ? "Saving…" : "Save workspace settings"}
                </button>
              </div>
            </form>
          ) : section === "database" ? (
            <form
              class="team-settings-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveSettings({ databaseProvider, ...(postgresUrl.trim() ? { postgresUrl: postgresUrl.trim() } : {}) });
              }}
            >
              <label>
                Database provider
                <select
                  value={databaseProvider}
                  onChange={(event) => setDatabaseProvider(event.currentTarget.value as "sqlite" | "postgres")}
                >
                  <option value="sqlite">SQLite (default)</option>
                  <option value="postgres">PostgreSQL</option>
                </select>
                <small>SQLite is used when PostgreSQL is not configured or cannot connect.</small>
              </label>
              {databaseProvider === "postgres" ? (
                <label>
                  PostgreSQL connection URL
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={postgresUrl}
                    onInput={(event) => setPostgresUrl(event.currentTarget.value)}
                    placeholder={
                      settings?.postgresConfigured
                        ? "Connection saved — leave blank to keep it"
                        : "postgresql://user:password@host/database"
                    }
                    required={!settings?.postgresConfigured}
                  />
                  <small>Stored on this host. The saved connection URL is never returned to the browser.</small>
                </label>
              ) : null}
              <div class="team-form-footer">
                <button type="submit" class="team-button primary" disabled={pending || !settings}>
                  {pending ? "Saving…" : "Save database settings"}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div class="team-user-list" role="list" aria-label="Data connections">
                {servers.map((server) => (
                  <div class="team-connection-row" role="listitem" key={server.id}>
                    <div>
                      <strong>{server.label}</strong>
                      <small>
                        {server.id} · {server.endpoint}
                      </small>
                    </div>
                    <span class={`team-status ${server.enabled ? "is-enabled" : ""}`}>
                      {server.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <button
                      type="button"
                      class="team-button"
                      disabled={pending}
                      onClick={() =>
                        saveMcp(
                          servers.map((item) => (item.id === server.id ? { ...item, enabled: !item.enabled } : item))
                        )
                      }
                    >
                      {server.enabled ? "Disable" : "Enable"} {server.label}
                    </button>
                  </div>
                ))}
                {!servers.length ? <p class="team-empty">No data connections configured.</p> : null}
              </div>
              <form
                class="team-settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (servers.some((server) => server.id === mcpDraft.id.trim())) {
                    setError("That connection ID is already in use.");
                    return;
                  }
                  saveMcp([
                    ...servers,
                    {
                      id: mcpDraft.id.trim(),
                      label: mcpDraft.label.trim() || mcpDraft.id.trim(),
                      endpoint: mcpDraft.endpoint.trim(),
                      enabled: true,
                      allowedRoles: ["user", "admin", "unrestricted-admin"]
                    }
                  ]);
                }}
              >
                <h3>Add data connection</h3>
                <div class="team-field-grid">
                  <label>
                    Connection ID
                    <input
                      required
                      pattern="[A-Za-z0-9._-]{1,80}"
                      value={mcpDraft.id}
                      onInput={(event) => setMcpDraft((current) => ({ ...current, id: event.currentTarget.value }))}
                    />
                  </label>
                  <label>
                    Display name
                    <input
                      value={mcpDraft.label}
                      onInput={(event) => setMcpDraft((current) => ({ ...current, label: event.currentTarget.value }))}
                    />
                  </label>
                </div>
                <label>
                  MCP endpoint
                  <input
                    type="url"
                    required
                    placeholder="https://server/mcp"
                    value={mcpDraft.endpoint}
                    onInput={(event) => setMcpDraft((current) => ({ ...current, endpoint: event.currentTarget.value }))}
                  />
                </label>
                <div class="team-form-footer">
                  <button type="submit" class="team-button primary" disabled={pending || !settings}>
                    Add connection
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
      <ModalShell
        open={Boolean(draft)}
        title={draft?.id ? `Edit ${draft.username}` : "Add Team user"}
        closeLabel="Close user editor"
        className="team-edit-modal"
        closeDisabled={pending}
        onClose={closeEditor}
      >
        {draft ? (
          <>
            <div class="team-edit-tabs" role="tablist" aria-label="User settings" onKeyDown={handleTabKeyDown}>
              {(
                [
                  ["profile", "Profile"],
                  ["permissions", "Permissions"],
                  ["data", "Data access"]
                ] as const
              ).map(([id, title]) => (
                <button
                  type="button"
                  role="tab"
                  id={`team-editor-tab-${id}`}
                  aria-controls={`team-editor-panel-${id}`}
                  aria-selected={editorTab === id}
                  tabIndex={editorTab === id ? 0 : -1}
                  onClick={() => setEditorTab(id)}
                  key={id}
                >
                  {title}
                </button>
              ))}
            </div>
            {editorError ? (
              <div class="team-notice is-error" role="alert">
                {editorError}
              </div>
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                saveUser();
              }}
            >
              <fieldset class="team-editor-fields" disabled={pending}>
                <div
                  id="team-editor-panel-profile"
                  role="tabpanel"
                  aria-labelledby="team-editor-tab-profile"
                  hidden={editorTab !== "profile"}
                  class="team-settings-form"
                >
                  <div class="team-field-grid">
                    <label>
                      Email
                      <input
                        type={draft.id ? "text" : "email"}
                        maxLength={254}
                        value={draft.username}
                        readOnly={Boolean(draft.id)}
                        autoComplete="off"
                        onInput={(event) => setDraft({ ...draft, username: event.currentTarget.value })}
                      />
                    </label>
                    <label>
                      Display name
                      <input
                        value={draft.displayName}
                        onInput={(event) => setDraft({ ...draft, displayName: event.currentTarget.value })}
                      />
                    </label>
                  </div>
                  <label>
                    {draft.id ? "New password" : "Password"}
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={draft.password}
                      placeholder={draft.id ? "Leave blank to keep current password" : "At least 8 characters"}
                      onInput={(event) => setDraft({ ...draft, password: event.currentTarget.value })}
                    />
                  </label>
                  <label class="team-check">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })}
                    />
                    <span>
                      <strong>Allow sign-in</strong>
                      <small>Disable to suspend this user's access.</small>
                    </span>
                  </label>
                  <label>
                    Workspace folder
                    <input
                      value={draft.workspacePath}
                      placeholder="Use a folder under the Team workspace root"
                      onInput={(event) => setDraft({ ...draft, workspacePath: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    Default prompt
                    <textarea
                      rows={4}
                      maxLength={8000}
                      value={draft.defaultPrompt}
                      onInput={(event) => setDraft({ ...draft, defaultPrompt: event.currentTarget.value })}
                    />
                    <small>Applied automatically to this user's conversations.</small>
                  </label>
                </div>
                <div
                  id="team-editor-panel-permissions"
                  role="tabpanel"
                  aria-labelledby="team-editor-tab-permissions"
                  hidden={editorTab !== "permissions"}
                  class="team-settings-form"
                >
                  <label>
                    Role
                    <select
                      value={draft.role}
                      onChange={(event) => setDraft({ ...draft, role: event.currentTarget.value as OfficeRole })}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                      <option value="unrestricted-admin">Unrestricted admin</option>
                    </select>
                    <small>
                      Admin roles grant host management access. Feature limits below apply to regular users.
                    </small>
                  </label>
                  <div class="team-permission-grid">
                    {FEATURES.map((feature) => (
                      <label class="team-check" key={feature.id}>
                        <input
                          type="checkbox"
                          checked={draft.features.includes(feature.id)}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              features: event.currentTarget.checked
                                ? [...draft.features, feature.id]
                                : draft.features.filter((item) => item !== feature.id)
                            })
                          }
                        />
                        <span>
                          <strong>{feature.title}</strong>
                          <small>{feature.description}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <div
                  id="team-editor-panel-data"
                  role="tabpanel"
                  aria-labelledby="team-editor-tab-data"
                  hidden={editorTab !== "data"}
                  class="team-settings-form"
                >
                  <p>Select which data connections this user can access.</p>
                  {servers.map((server) => (
                    <label class="team-check" key={server.id}>
                      <input
                        type="checkbox"
                        checked={draft.mcpServers.includes(server.id)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            mcpServers: event.currentTarget.checked
                              ? [...draft.mcpServers, server.id]
                              : draft.mcpServers.filter((id) => id !== server.id)
                          })
                        }
                      />
                      <span>
                        <strong>{server.label}</strong>
                        <small>{server.enabled ? "Enabled" : "Disabled globally"}</small>
                      </span>
                    </label>
                  ))}
                  {!servers.length ? (
                    <p class="team-empty">Add an MCP data connection before assigning user access.</p>
                  ) : null}
                </div>
              </fieldset>
              <div class="team-form-footer">
                <button type="button" class="team-button" disabled={pending} onClick={closeEditor}>
                  Cancel
                </button>
                <button type="submit" class="team-button primary" disabled={pending}>
                  {pending ? "Saving…" : draft.id ? "Save changes" : "Create user"}
                </button>
              </div>
            </form>
          </>
        ) : null}
      </ModalShell>
      <ModalShell
        open={Boolean(deleting)}
        title="Delete Team user?"
        closeLabel="Cancel user deletion"
        className="team-edit-modal"
        closeDisabled={pending}
        onClose={() => {
          setDeleting(undefined);
          setNotice("User deletion cancelled.");
        }}
      >
        <p>
          Remove {deleting?.displayName} ({deleting?.username}) and their sign-in access? Their workspace files will be
          kept.
        </p>
        {error ? (
          <div class="team-notice is-error" role="alert">
            {error}
          </div>
        ) : null}
        <div class="team-form-footer">
          <button
            type="button"
            class="team-button"
            disabled={pending}
            onClick={() => {
              setDeleting(undefined);
              setNotice("User deletion cancelled.");
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            class="team-button danger"
            disabled={pending}
            onClick={() => {
              if (deleting)
                void mutate(async () => {
                  await request(`/api/office/users/${encodeURIComponent(deleting.id)}`, "DELETE");
                  setUsers((current) => current.filter((user) => user.id !== deleting.id));
                  setDeleting(undefined);
                }, "User deleted. Workspace files kept.");
            }}
          >
            {pending ? "Deleting…" : "Delete user"}
          </button>
        </div>
      </ModalShell>
    </div>
  );
}
