# Connect the packaged Manager MCP server

Start Manager, enable Dashboard API, and create a named token with the projects
and actions the task needs. Browser needs `workspaceBrowser`; native terminal
screen access needs `workspaceTerminal` and `listWorkspaceTerminals`.
Visible panel control also needs `workspacePanel`. The unchanged automatic MCP
grant is upgraded during setup; user-edited token grants are preserved.

Run the installed extension's `tools/codex-manager-mcp.mjs` with Node over stdio.
Supply `CODEX_MANAGER_URL` (default `http://127.0.0.1:39875`) and
`CODEX_MANAGER_TOKEN` in the launching process environment. Use an absolute
path to the script. The bridge does not start Manager or create a token.

Codex configuration example:

```toml
[mcp_servers.codex-manager]
command = "node"
args = ["/path/to/extension/tools/codex-manager-mcp.mjs"]
env_vars = ["CODEX_MANAGER_URL", "CODEX_MANAGER_TOKEN"]
```

For Claude Code, use the same command, arguments and environment under the
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
