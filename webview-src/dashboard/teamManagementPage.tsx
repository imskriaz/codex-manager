import {UserUsageReview} from './userUsageReview';
import type { OfficeLimits } from "../../src/services/officeQuota";
const unlimitedOfficeLimits = {storageMb: 0, dailyTokens: 0, dailyRequests: 0};
import { useEffect, useRef, useState } from "preact/hooks";
import type { OfficeUser, OfficeMcpServer, OfficeFeature, OfficeRole } from "../../src/services/officeUsers";
import { TeamActivity } from "./teamActivity";
import type { DashboardOfficeView } from "../../src/domain/dashboard/types";
import { request } from "./teamSettingsRequest";
import { SettingsRecordList, SettingsRecordDetails } from "./settingsRecordList";
import { ModalShell } from "./primitives";
export { request } from "./teamSettingsRequest";

export type TeamSettingsSection = "users" | "workspace" | "mcp" | "database" | "logs" | "proxy";
type TeamSettings = { defaultModel: string; globalPrompt: string; maxActiveRequests: number; workspaceRoot: string; databaseProvider: "sqlite" | "postgres"; postgresConfigured: boolean };
type UserDraft = {
  plan?:import('../../src/services/officeUsers').OfficePlan;
  limits?: OfficeLimits;
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
export const TEAM_SETTINGS_SECTIONS: { id: TeamSettingsSection; title: string; description: string }[] = [
  { id: "logs", title: "Logs", description: "See who initiated each action and its outcome." },
  { id: "proxy", title: "Proxy", description: "Monitor requests, user identity, running status, and token use." },
  { id: "users", title: "Users", description: "Manage sign-in, workspace access, and permissions." },
  { id: "workspace", title: "User Workspace", description: "Choose where new Team user workspaces are created." },
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


export function TeamManagementPage(props: { office?: DashboardOfficeView; section: TeamSettingsSection; open?: boolean }) {
  const section = props.section;
  const [userSearch, setUserSearch] = useState("");
  const [users, setUsers] = useState<OfficeUser[]>([]);
  const [servers, setServers] = useState<OfficeMcpServer[]>([]);
  const [settings, setSettings] = useState<TeamSettings>();
  const [defaultModel, setDefaultModel] = useState("");
  const [modelOptions, setModelOptions] = useState<Array<{id: string; label: string}>>([]);
  const [modelsLoading, setModelsLoading] = useState(false), [modelWarning, setModelWarning] = useState("");
  const [modelRetry, setModelRetry] = useState(0);
  useEffect(() => {
    if (props.open === false || section !== "workspace") return;
    let active = true;
    setModelsLoading(true); setModelWarning("");
    void request<{models: Array<{id: string; label: string}>}>("/api/office/models").then(value => {
      if (active) { setModelOptions(value.models); if (!value.models.length) setModelWarning("No models are available right now. Please try again shortly."); }
    }).catch(() => { if (active) setModelWarning("Models could not be loaded. Your saved default is kept."); })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [props.open, section, modelRetry]);
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [maxActiveRequests, setMaxActiveRequests] = useState(2);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [databaseProvider, setDatabaseProvider] = useState<"sqlite" | "postgres">("sqlite");
  const [postgresUrl, setPostgresUrl] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [draft, setDraft] = useState<UserDraft>();
  const [editorError, setEditorError] = useState("");
  const [deleting, setDeleting] = useState<OfficeUser>();
  const [mcpDraft, setMcpDraft] = useState({ id: "", label: "", endpoint: "" });
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpError, setMcpError] = useState("");
  useEffect(() => { if (props.open === false) setMcpOpen(false); }, [props.open]);

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
      setSettings(teamSettings); setDefaultModel(teamSettings.defaultModel ?? ""); setGlobalPrompt(teamSettings.globalPrompt ?? "");
      setWorkspaceRoot(teamSettings.workspaceRoot); setMaxActiveRequests(teamSettings.maxActiveRequests ?? 2);
      setDatabaseProvider(teamSettings.databaseProvider);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Team settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (section !== "logs" && section !== "proxy" && !settings) void load();
  }, [section]);

  const mutate = async (work: () => Promise<void>, success: string, inEditor: boolean | "mcp" = false): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setEditorError("");
    setMcpError("");
    setNotice("");
    try {
      await work();
      setNotice(success);
    } catch (value) {
      const message = value instanceof Error ? value.message : "Your change could not be saved.";
      if (inEditor === "mcp") setMcpError(message);
      else if (inEditor) setEditorError(message);
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
        return;
    }
    if ((!draft.id || draft.password) && (draft.password.length < 8 || draft.password.length > 256)) {
      setEditorError("Use a password between 8 and 256 characters.");
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
  const saveMcp = (next: OfficeMcpServer[], adding = false): void => {
    void mutate(async () => {
      const result = await request<{ servers: OfficeMcpServer[] }>("/api/office/mcp", "PUT", { servers: next });
      setServers(result.servers);
      setMcpDraft({ id: "", label: "", endpoint: "" });
      if (adding) setMcpOpen(false);
    }, adding ? "Data connection added." : "Data connections saved.", adding ? "mcp" : false);
  };
  const saveSettings = (fields: Record<string, string | number>): void => {
    void mutate(async () => {
      const result = await request<TeamSettings>("/api/office/settings", "PUT", fields);
      setSettings(result); setDefaultModel(result.defaultModel ?? ""); setGlobalPrompt(result.globalPrompt ?? "");
      setWorkspaceRoot(result.workspaceRoot); setMaxActiveRequests(result.maxActiveRequests ?? 2);
      setDatabaseProvider(result.databaseProvider);
      setPostgresUrl("");
    }, "Team settings saved.");
  };
  const currentSection = TEAM_SETTINGS_SECTIONS.find((item) => item.id === section)!;
  const filteredUsers = users.filter((user) =>
    `${user.displayName} ${user.username}`.toLowerCase().includes(userSearch.toLowerCase())
  );

  return (
    <div class="team-management-page team-settings-embedded">
        <section class="team-settings-content" aria-label={currentSection.title} hidden={Boolean(draft && section === "users")}>
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
            ) : section === "mcp" ? <button type="button" class="team-button primary" disabled={loading || pending || !settings} onClick={() => { setMcpError(""); setMcpOpen(true); }}>Add connection</button> : null}
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
          {section === "logs" || section === "proxy" ? <TeamActivity key={section} view={section} open={props.open} /> : loading ? (
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
              <SettingsRecordList label="Team users" open={props.open && section === "users"} columns={["Name", "Email", "Role", "Status"]} rows={filteredUsers.map(user => ({id:user.id,label:user.displayName || user.username,cells:[user.displayName || user.username,user.username,roleLabel(user.role),user.enabled ? "Active" : "Disabled"],details:close => <><SettingsRecordDetails fields={[["Name",user.displayName],["Email",user.username],["Role",roleLabel(user.role)],["Status",user.enabled ? "Active" : "Disabled"],["Workspace",user.workspacePath],["Features",user.features.join(", ")],["Data connections",user.mcpServers.join(", ")],["Default prompt",user.defaultPrompt]]}/><div class="team-form-footer"><button class="team-button" type="button" disabled={pending} onClick={() => {close();edit(user);}}>Edit</button><button class="team-button danger" type="button" disabled={pending} onClick={() => {close();setDeleting(user);setError("");}}>Delete</button></div></>}))}/>
                {!filteredUsers.length ? (
                  <div class="team-empty">
                    <strong>{users.length ? "No matching users" : "No Team users yet"}</strong>
                    <p>
                      {users.length
                        ? "Try a different name or email."
                        : "Add a user to give them a private workspace and sign-in."}
                    </p>
                  </div>
                ) : null}
            </>
          ) : section === "workspace" ? (
            <form
              class="team-settings-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveSettings({ workspaceRoot, maxActiveRequests, globalPrompt, defaultModel });
              }}
            >
              <label>
                Default User Workspace model
                <select aria-label="Default User Workspace model" value={defaultModel} disabled={pending || modelsLoading} onChange={event => setDefaultModel(event.currentTarget.value)}>
                  <option value="">Require users to choose</option>
                  {defaultModel && !modelOptions.some(model => model.id === defaultModel) ? <option value={defaultModel}>{defaultModel}</option> : null}
                  {modelOptions.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
                <small>Preselected for new chats. Users can pick another model before sending. Existing conversations keep their selected model.</small>
                {modelsLoading ? <small role="status">Loading models…</small> : null}
                {modelWarning ? <span role="status">{modelWarning} <button type="button" disabled={pending} onClick={() => setModelRetry(value => value + 1)}>Try again</button></span> : null}
              </label><label>
                Global User Workspace Prompt
                <textarea aria-label="Global User Workspace Prompt" rows={7} maxLength={16000} value={globalPrompt} disabled={pending} placeholder="Define your assistant’s purpose, tone, response style, and how it should help every user." onInput={event => setGlobalPrompt(event.currentTarget.value)} />
                <small>Applies to every User Workspace from the next message, including existing conversations. Global guidance comes first, followed by per-user defaults and personal instructions. Workspace permissions remain enforced.</small>
              </label><label>
                Active requests: {maxActiveRequests}
                <input type="range" aria-label="Maximum active workspace requests" min={1} max={20} step={1} value={maxActiveRequests} disabled={pending} onInput={event => setMaxActiveRequests(Number(event.currentTarget.value))} />
                <small>Shared across user workspaces. Extra requests wait in the queue. Lowering the limit lets current work finish.</small>
              </label><label>
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
              <SettingsRecordList label="Data connections" open={props.open && section === "mcp"} columns={["Name", "ID", "Endpoint", "Status"]} rows={servers.map(server => ({id:server.id,label:server.label,cells:[server.label,server.id,server.endpoint,server.enabled ? "Enabled" : "Disabled"],details:close => <><SettingsRecordDetails fields={[["Name",server.label],["ID",server.id],["Endpoint",server.endpoint],["Status",server.enabled ? "Enabled" : "Disabled"],["Allowed roles",server.allowedRoles.join(", ")]]}/><div class="team-form-footer"><button type="button" class="team-button" disabled={pending} onClick={() => {close();saveMcp(servers.map(item => item.id === server.id ? {...item,enabled:!item.enabled} : item));}}>{server.enabled ? "Disable" : "Enable"} connection</button></div></>}))}/>
                {!servers.length ? <p class="team-empty">No data connections configured.</p> : null}


            </>
          )}
        </section>
      <ModalShell open={mcpOpen && section === "mcp" && props.open !== false} title="Add data connection" closeLabel="Close add data connection" className="team-connection-modal" closeDisabled={pending} onClose={() => { setMcpOpen(false); setNotice("Adding a data connection cancelled."); }}>
              <form
                class="team-settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (servers.some((server) => server.id === mcpDraft.id.trim())) {
                    setMcpError("That connection ID is already in use.");
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
                  ], true);
                }}
              >
                {mcpError ? <div class="team-notice is-error" role="alert">{mcpError}</div> : null}
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
                <div class="team-form-footer"><button type="button" class="team-button" disabled={pending} onClick={() => { setMcpOpen(false); setNotice("Adding a data connection cancelled."); }}>Cancel</button>
                  <button type="submit" class="team-button primary" disabled={pending || !settings}>
                    {pending ? "Adding..." : "Add connection"}
                  </button>
                </div>
              </form>
      </ModalShell>
      {draft && section === "users" ? <section class="team-inline-editor" aria-label={draft.id ? `Edit ${draft.username}` : "Add Team user"}>
        <div class="team-section-head"><h2>{draft.id ? "Edit user" : "Add user"}</h2><button class="team-button" type="button" disabled={pending} onClick={closeEditor}>Back to users</button></div>
        {draft ? (
          <>
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
                  aria-label="Profile"
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
                <fieldset class="team-settings-form"><legend>Plan access</legend><label>Plan name<input maxLength={80} value={draft.plan?.name??'Workspace'} onInput={event=>setDraft({...draft,plan:{status:'active',models:[],...draft.plan,name:event.currentTarget.value}})}/></label><label>Status<select value={draft.plan?.status??'active'} onChange={event=>setDraft({...draft,plan:{name:'Workspace',models:[],...draft.plan,status:event.currentTarget.value as 'active'|'paused'}})}><option value="active">Active</option><option value="paused">Paused</option></select></label><label>Access expires (optional)<input type="datetime-local" value={draft.plan?.expiresAt?new Date(draft.plan.expiresAt-new Date(draft.plan.expiresAt).getTimezoneOffset()*60000).toISOString().slice(0,16):''} onInput={event=>setDraft({...draft,plan:{name:'Workspace',status:'active',models:[],...draft.plan,expiresAt:event.currentTarget.value?new Date(event.currentTarget.value).getTime():undefined}})}/></label><label>Included models<input placeholder="All available models" value={draft.plan?.models.join(', ')??''} onInput={event=>setDraft({...draft,plan:{name:'Workspace',status:'active',...draft.plan,models:event.currentTarget.value.split(',').map(model=>model.trim()).filter(Boolean)}})}/></label><small>Enter model IDs separated by commas, or leave empty for all available models. Plans are managed here; payment and recovery email services are not configured.</small></fieldset>
                {draft.id?<UserUsageReview key={draft.id} id={draft.id}/>:null}<fieldset class="team-settings-form"><legend>User allowances</legend><p>Use 0 for unlimited. Daily allowances reset at midnight UTC. A response already running may finish before the token limit takes effect.</p>{([['storageMb', 'File storage (MB)'], ['dailyTokens', 'Tokens per day'], ['dailyRequests', 'Requests per day']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min={0} max={1000000000} step={1} required value={draft.limits?.[key] ?? 0} onInput={event => setDraft({...draft, limits: {...unlimitedOfficeLimits, ...draft.limits, [key]: Number(event.currentTarget.value)}})} /></label>)}</fieldset>
                <details class="team-editor-advanced"><summary>Permissions & data access</summary><p class="settings-note">User Workspace has no host terminal, Git, or GitHub execution. Browser navigation and execution require an isolated runtime. These restrictions protect the host even when a feature was previously enabled.</p>
                <div
                  id="team-editor-panel-permissions"
                  aria-label="Permissions"
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
                          disabled={draft.role === "user" && ["terminal","git","github"].includes(feature.id)}
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
                  aria-label="Data access"
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
                </details>
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
      </section> : null}
      {deleting && section === "users" ? <section class="settings-inline-confirm" aria-label="Delete Team user?">
        <h3>Delete Team user?</h3>
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
      </section> : null}
    </div>
  );
}
