# Connect the packaged Manager MCP server

Start either the VS Code extension or standalone Manager host. Internal MCP uses
an OS-local named pipe (Windows) or private Unix socket. No API token, dashboard
login, or Dashboard API setting is needed. The browser dashboard may be disabled.

Run the installed extension's tools/codex-manager-mcp.mjs with Node over stdio,
using an absolute script path. Omit CODEX_MANAGER_URL and CODEX_MANAGER_TOKEN.
If the host uses CODEX_MANAGER_STORAGE_ROOT, pass the same directory to the MCP
process. Automatic setup configures this for both VS Code and standalone.

Codex configuration example:

```toml
[mcp_servers.codex-manager]
command = "node"
args = ["/path/to/extension/tools/codex-manager-mcp.mjs"]
```

For an explicit remote HTTP(S) connection, set CODEX_MANAGER_URL and a scoped
CODEX_MANAGER_TOKEN. Enable Dashboard API on that host. Remote access retains
its token, project, action, and origin checks. Internal local access trusts the OS
user and exposes Manager actions without a bearer credential.

For Claude Code, use the same command and arguments under the
`mcpServers.codex-manager` entry in its MCP JSON configuration.

After connecting, `manager_schema` checks host availability and permitted
actions. `manager_browser` with `{"projectPath":"/path/to/project","request":
{"operation":"list"}}` checks shared browser access without opening a page.

For the user's live right panel, call `manager_workspace` with the same project
and `request:{"operation":"list"}`. Use the returned `surfaceId`, session ID and
dashboard host ID. Commands travel to that dashboard over its live WebSocket;
disconnection, background tabs and workspace changes fail visibly to the caller.
The dashboard host and execution PC may differ. An all-project token is required
to route to other PCs; project tokens cannot control a remote execution device.
