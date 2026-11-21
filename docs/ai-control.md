# AI control and development browser

Open **+ → Browser** or **+ → Terminal** in the right workspace panel. Both work
in VS Code and the standalone Node host. Native shells appear in the terminal
list and stream their PTY screen without a VS Code process.

Browser opens isolated Chromium pages on the selected host. Enter a development
URL and choose a page. The floating pointer, area, pen and text toolbar marks
feedback; add a design/inspiration URL when useful. **Save feedback** commits
it and a bounded screenshot to Manager SQLite. **Add to instruction** appends it to the composer for
review without sending a turn. Expand enlarges the panel within the dashboard.

The browser uses a periodically refreshed preview, allowing sites that refuse
iframe embedding. Clicks and typing operate the real page through Playwright.
Feedback uses revisions so navigation cannot silently move a mark. Historical
notes survive page closure/reboot; browser login state does not.

The host needs Edge, Chrome, or Playwright Chromium. Windows defaults to Edge;
`CODEX_MANAGER_BROWSER=chrome` or `chromium` selects another channel. Install
Chromium from the installed extension directory with
`node node_modules/playwright-core/cli.js install chromium` on hosts without a
browser. This installs the revision matching the bundled Playwright version.
Missing executables produce an inline error.

## MCP connection

Internal MCP uses a local named pipe or private Unix socket shared by the VS Code
and standalone hosts. No token or Dashboard API setting is required. Automatic
setup preserves independently managed and disabled MCP entries.

Claude Code JSON example (replace the installed extension path locally):

```json
{"mcpServers":{"codex-manager":{"command":"node","args":["/path/to/extension/tools/codex-manager-mcp.mjs"]}}}
```

Codex config.toml:

```toml
[mcp_servers.codex-manager]
command = "node"
args = ["/path/to/extension/tools/codex-manager-mcp.mjs"]
```

If using a custom storage directory, pass the same CODEX_MANAGER_STORAGE_ROOT to
the MCP process. Explicit CODEX_MANAGER_URL connections retain token authentication
and require Dashboard API on the remote host. Local OS transport does not expose
unauthenticated access on the dashboard HTTP listener.

manager_coordination supports list/status/send/read/acknowledge plus
pause/stop/resume/handover/controlStatus. Controls require the calling sessionId,
a toSessionId and a stable operationId. Pause and stop hold automatic recovery.
Unreachable native owners receive a cooperative request; pending means the peer
must read and end its turn, not that execution stopped. Handover adds
handoverToSessionId and text; it requires an idle source before delivering the
summary. start:true also starts an idle unlocked destination. Uncertain starts
are retained and never automatically replayed. Remote tokens additionally need
cancelCodexCliSessionTurn for stopping and sendCodexCliSessionMessage for starting.

The VSIX includes tools/codex-manager-mcp.mjs and the packaged Manager skill.
Restart existing MCP clients after upgrading to load the local transport and tools.

## System Info

**Settings → General → System Info** controls the two-row host summary in Account
Center and the compact system picker. It reports available battery, active network
adapter, CPU, RAM, system-home-volume disk space and uptime without delaying
account actions. Missing sensors are omitted. Disconnected or readings older than
90 seconds are marked Saved. CPU is sampled between updates; network status does
not prove internet reachability. Remote readings require an updated peer host.
The picker retains account/session counts and connection status when System Info
is disabled.

## Browser debugging

Codex can inspect screenshots, rendered HTML and computed CSS; inject and modify
JavaScript, CSS and DOM; read console/errors and event listeners; inspect network
headers, request/response bodies and WebSockets; intercept/mock requests; read or
modify isolated cookies, local/session storage, IndexedDB and cache; and use page
DevTools debugging, profiling and emulation commands. See the bundled
[browser API guide](../skills/codex-manager/references/browser-debugging.md) for
requests, supported domains and limits. This is a bounded page DevTools bridge,
not a claim that every browser-wide or future experimental API is supported.

## Tool coverage

| Tool | Purpose |
| --- | --- |
| `manager_schema` | Available local actions or remote token scope |
| `manager_coordination` | Project mailboxes, pause, stop, resume, handover, and control outcome inspection |
| `manager_state` | Host state or a granted project |
| `manager_action` | Existing session, account, task, file, terminal, Git, backup, sharing and maintenance actions |
| `manager_setting` | Existing global setting updates |
| `manager_browser` | Shared pages, navigation, accessibility, screenshots, diagnostics, selectors, typing, keys, scroll, hover/select/wait, viewport, evaluation and saved feedback |
| `manager_workspace` | Discover connected workspace views, read the visible browser or terminal, and open/select/hide right-panel tabs with dashboard acknowledgements |

Example `manager_browser` arguments:

```json
{"projectPath":"/path/to/project","request":{"operation":"open","url":"http://localhost:3000"}}
```

To control the right panel on a phone or another browser, call `manager_workspace`
with `request:{"operation":"list"}` first. Copy the matching `surfaceId`,
`dashboardHostDeviceId` and session ID. Supply the dashboard host ID as
`targetDeviceId`; it can differ from the PC executing browser or terminal work.
`open` accepts `tab:"browser"` and a URL, or a tool such as `terminal`, `files`,
`git`, `reviews`, `agents` or `env`. `select` takes an existing tab ID. `read`
returns current panel metadata and browser snapshot or terminal screen content.
Browser MCP calls may also supply `surfaceId` to present opened pages in that
view. Commands do not report completion until that view acknowledges them.
Panel and session changes are pushed immediately; the periodic heartbeat only
renews the view's lease. Reads do not wait for animation frames. A workspace
switch, background transition or disconnect fails pending commands promptly,
without retrying a mutation on another connection.
An absent, background, disconnected or changed workspace is never replaced
with a local browser. Project-scoped tokens remain restricted to local execution.

Use returned page IDs and revisions for mutations. Limits: four projects, eight
pages per project, 100 feedback items per project, 1,024 remembered mutations per
host lifetime. Busy projects fail immediately. The same operation ID checks its
previous attempt without executing it again. Storage failures preserve drafts.
A timeout/disconnection is an unknown outcome: inspect before retrying.
Cancelling MCP does not prove the host cancelled a mutation.

This version does not attach personal profiles or automate file
uploads/downloads, stream continuous video, or host a remote MCP endpoint. A
local stdio process uses the OS-local Manager transport; peer WebSockets route
workspace actions to another connected PC and its live dashboard views.
Only existing Manager operations are exposed; private Codex/Claude APIs are not
claimed.

References: [MCP stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[Codex MCP](https://developers.openai.com/codex/mcp/),
[Claude Code MCP](https://code.claude.com/docs/en/mcp),
[Playwright browser lifecycle](https://playwright.dev/docs/api/class-browser).
