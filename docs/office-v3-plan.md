# Codex Manager 3.0 office workspace

## Product boundary

Codex Manager 3.0 supports an office installation with one unrestricted administrator, administrators, and isolated users. Every user signs in with a username and password, receives a workspace rooted below the configured office folder, and can create projects below that folder. User dashboards expose only General and Task work; account identities, quota details, dashboard controls, terminal, environment, Git, GitHub, and implementation diagnostics stay outside the user role.

## Runtime model

- `office-users` is the durable identity store. Passwords are salted scrypt verifiers; session cookies carry only an opaque token and the server-side user id/role.
- SQLite is the default office database. PostgreSQL is an explicit configuration option and must fail closed with a generic retry message when its connection cannot be established.
- Workspace paths are canonicalized and checked against the assigned user root before every file, project, browser, or Codex action. No user action accepts an arbitrary host path.
- A user has no Codex session until they start a Task. General chat uses the existing proxy protocol through a server-side, user-scoped capability; the proxy key is never sent to the browser.
- Default prompts are injected by the host for user turns and are editable only by an administrator.
- MCP entries are an administrator-managed allow-list. User turns receive only enabled entries assigned to that user.
- Quota/capacity failures become generic user notices (“Out of credits. We’ll retry when capacity is available.”) and are retried with bounded backoff; account, token, provider, and host details remain admin-only.

## UI model

- Master settings becomes a sectioned settings shell with searchable navigation: Office, Users & roles, Features, MCP, Storage, Appearance, Automation, Data, and Tools.
- The admin icon is visible only to admin roles and opens Office management.
- User shell has two top tabs: General (proxy chat) and Task (Codex task workspace). The dashboard/account tab is removed from user navigation.
- User settings contain only theme, language, assigned features, and workspace/project actions. The file explorer uses the Windows-style tree/list treatment and follows the user theme.
- Explicit actions report success, warning, cancellation, and failure in the initiating surface. Technical detail is retained in the admin log only.

## Delivery slices

1. Identity and session role plumbing with master-passphrase compatibility.
2. User workspace and project boundary enforcement.
3. Reduced user snapshot and role-aware navigation/settings.
4. General proxy chat and Task Codex chat with generic quota recovery.
5. Admin user/feature/MCP management and searchable settings sections.
6. SQLite/PostgreSQL configuration and migration checks.
7. Windows-style file explorer/theme polish, tests, VSIX verification and installation.
