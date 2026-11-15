# Connect the packaged Manager MCP server

Start Manager, enable Dashboard API, and create a named token with the projects
and actions the task needs. Browser needs `workspaceBrowser`; native terminal
screen access needs `workspaceTerminal` and `listWorkspaceTerminals`.

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
