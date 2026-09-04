import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
  consolidateSessionMessages,
  consolidatedActivityLabel,
  splitMessageParagraphs,
  filterCliSessionsBySection
} from "../webview-src/dashboard/cliSessionsModal";
import { shouldPatchDashboardSettingOptimistically } from "../webview-src/dashboard/settingsOverlay";

describe("sessions sidebar layout", () => {
  it("keeps Active and Archive session tabs mutually exclusive", () => {
    const sessions = [
      { id: "active", title: "Active", status: "idle" as const },
      { id: "archived", title: "Archived", status: "idle" as const, archived: true },
      { id: "legacy", title: "Legacy", status: "idle" as const, archived: false }
    ];

    expect(filterCliSessionsBySection(sessions, "active").map((session) => session.id)).toEqual(["active", "legacy"]);
    expect(filterCliSessionsBySection(sessions, "archived").map((session) => session.id)).toEqual(["archived"]);
  });

  it("places the project rail below session filters", () => {
    const source = readFileSync("webview-src/dashboard/cliSessionsModal.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    const filters = source.indexOf('class="cli-session-filters"');
    const projects = source.indexOf('class="cli-project-heading"');

    expect(filters).toBeGreaterThan(-1);
    expect(projects).toBeGreaterThan(filters);
    expect(source).not.toContain("<AccountDock");
    expect(source).toContain('class="cli-account-footer"');
    expect(source).toContain('name="project-path"');
    expect(source).toContain('name="sandbox-mode"');
    expect(source).toContain('name="model-reasoning"');
    expect(source).toContain('aria-label="Model and reasoning"');
    expect(source).toContain("modelReasoningOptions");
    const composerStart = source.indexOf("function Composer(");
    const composer = source.slice(composerStart, source.indexOf("function SessionMessage", composerStart));
    expect(composer).not.toContain("<SparkIcon />");
    expect(composer).not.toContain("<ReasoningIcon />");
    expect(source).toContain('class="cli-environment-popover"');
    expect(source).toContain('aria-label="Environment"');
    expect(source).toContain('aria-label="Workspace tools"');
    expect(source).toContain('role="separator"');
    expect(source).toContain('aria-valuenow={Math.round(props.value)}');
    expect(source).toContain('aria-label="Resize message composer"');
    expect(source).toContain("composerHeight");
    expect(source).not.toContain("Session ID</span>");
  });

  it("uses Sessions in navigation while Settings exposes the experimental workspace toggle", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const settings = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");

    expect(main).toContain('"PCs and sessions"');
    expect(main).not.toContain('"PCs and CLI sessions"');
    expect(main).toContain("mergeCachedCliSessions");
    expect(settings).toContain('"Enable workspace (Experimental)"');
    expect(settings).toContain("stored only on this PC");
  });

  it("returns to the workspace list after archive or delete", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const mutationBlockStart = main.indexOf(
      '(message.action === "archiveCodexCliSession" || message.action === "deleteCodexCliSession")'
    );
    const mutationBlock = main.slice(mutationBlockStart, mutationBlockStart + 350);

    expect(mutationBlockStart).toBeGreaterThan(-1);
    expect(mutationBlock).toContain('navigateDashboardPath("/", setBrowserPath)');
  });

  it("keeps archived deep links in the workspace with restore guidance", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const branchStart = main.indexOf("if (routeSession?.archived)");
    const branch = main.slice(branchStart, main.indexOf("} else if (routeSession)", branchStart));

    expect(branchStart).toBeGreaterThan(-1);
    expect(branch).toContain("setSelectedCliSession(routeSession)");
    expect(branch).toContain("This session is archived. Restore it below");
    expect(branch).not.toContain('navigateDashboardPath("/dash", setBrowserPath)');
  });

  it("keeps workspace conversation and rail spacing compact", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    const densityBlockStart = css.indexOf("/* Workspace density v4:");
    const densityBlock = css.slice(densityBlockStart, densityBlockStart + 1_400);

    expect(densityBlockStart).toBeGreaterThan(-1);
    expect(densityBlock).toContain(".cli-workspace .cli-session-messages { gap: 4px; }");
    expect(densityBlock).toContain(".cli-workspace .cli-pc-project-list { gap: 0; }");
    expect(densityBlock).toContain(".cli-workspace .cli-pc-group-children { gap: 0;");
  });

  it("waits for committed CLI integration state before session discovery can start", () => {
    expect(shouldPatchDashboardSettingOptimistically("cliIntegrationEnabled")).toBe(false);
  });

  it("keeps the rail compact and exposes account switching plus session state actions", () => {
    const source = readFileSync("webview-src/dashboard/cliSessionsModal.tsx", "utf8");
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(source).toContain("SwitchAccountIcon");
    expect(source).toContain("props.onSwitchAccount()");
    expect(source).toContain('session.canStop ? <IconButton label={`Stop ${session.title}`}');
    expect(source).toContain('label={`Open ${session.title} in Codex`}');
    expect(source).toContain("props.onOpenInCodex(session)");
    const sessionRowStart = source.indexOf("const renderSession =");
    const sessionRowEnd = source.indexOf("const returnToSessionList", sessionRowStart);
    expect(source.slice(sessionRowStart, sessionRowEnd)).not.toContain('label={`Archive ${session.title}`}');
    expect(source).toContain("props.onArchive()");
    expect(source).toContain('<strong>Thinking</strong><span>for {formatElapsed(elapsed)}</span>');
    expect(source).not.toContain('<strong>Working</strong><span>for {formatElapsed(elapsed)}</span>');
    expect(source).toContain('label: "Recent"');
    expect(source).toContain('class="cli-session-project"');
    expect(source).toContain('class="cli-conversation-project"');
    expect(source).not.toContain('"Current workspace"');
    expect(source).not.toContain('"Open workspace"');
    expect(css).toContain(".cli-session-spinner");
    expect(css).toContain(".cli-project-row:hover .cli-project-new");
    expect(css).toContain(".cli-project-collapse");
    expect(css).toContain(".cli-session-row-main.has-project");
    expect(css).toContain(".cli-conversation-project");
    expect(css).toContain("--cli-rail-width");
    expect(css).toContain("--cli-terminal-width");
    expect(css).toContain(".cli-panel-resizer");
    expect(css).toContain(".cli-environment-popover");
    expect(css).toContain(".cli-terminal-panel");
    expect(css).toContain(".cli-account-footer");
    expect(css).toContain(".cli-workspace .cli-account-footer { margin: 0;");
    expect(css).toContain(".cli-composer-resizer");
    expect(css).toContain("grid-template-rows: auto auto auto auto minmax(0, 1fr) auto");
    expect(css).toContain(".cli-pc-group-heading { position: relative; display: block; }");
    expect(css).toContain(".cli-pc-switch { position: absolute");
    expect(css).toContain(".cli-project-select span { display: flex; align-items: baseline; gap: 6px; }");
    expect(css).toContain(".cli-context-edge-resizer");
    expect(css).toContain(".cli-review-file-list");
    expect(source).toContain('const resolvedFilePath = filePath && tab === "files" ? workspaceRelativePath(filePath, selectedProjectPath) : filePath;');
    expect(source).toContain('onOpenFile={(filePath) => props.onAdd("files", filePath)}');
    expect(source).toContain('currentPath ? "cli-files-workbench is-detail" : "cli-files-workbench is-list"');
    expect(source).toContain('{currentPath ? null : <div class="cli-file-tree">');
    expect(source).toContain('if (props.activePath) return <div class="cli-reviews-view is-detail">');
    expect(css).toContain(".cli-files-workbench.is-detail");
    expect(css).toContain(".cli-review-detail");
    expect(source).toContain('aria-label="Show workspace tools"');
    expect(source).toContain('!props.selectedSession && contextCollapsed');
    expect(source).toContain('.filter((tab) => !props.tabs.includes(tab))');
    expect(main).toContain('onClearFile={() => setWorkspaceFilesByPath({})}');
    expect(main).toContain("setWorkspaceFilesByPath((current) => ({ ...current, [workspaceFile.path]: workspaceFile }))");
    expect(css).toContain('width: min(var(--cli-terminal-width), 92vw)');
    expect(source).toContain('class="cli-session-tabs cli-session-state-toggle"');
    expect(css).toContain('.cli-session-state-toggle');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) !important');
    expect(css).toContain('.cli-workspace .cli-conversation.has-session');
    expect(css).toContain('grid-template-rows: auto minmax(0, 1fr) auto');
    expect(css).toContain('.cli-workspace .cli-activity-status');
    expect(css).toContain('.cli-workspace .cli-message-link');
    expect(source).toContain('cli-message-link');
    expect(css).toMatch(/\.cli-workspace \.cli-session-row-actions \{\r?\n  position: absolute;/);
    expect(css).toContain('.cli-session-row.is-archived:hover .cli-session-row-main small');
    expect(css).toContain('.cli-session-row.is-archived:hover .cli-session-row-main,');
    expect(css).toContain('.cli-session-row:not(.is-archived):hover .cli-session-row-main small');
    expect(css).toContain('.cli-workspace .cli-project-sessions .cli-session-row { min-height: 24px;');
    expect(css).toContain('.cli-workspace .cli-project-group .cli-project-row { min-height: 21px; }');
    expect(css).toContain('.cli-workspace .cli-pc-group-toggle { min-height: 24px;');
    expect(source).toContain('aria-label="Accounts by PC"');
    expect(source).toContain('class="cli-account-submenu"');
    expect(source).toContain("const enabledCount = accounts.filter((account) => account.enabled).length;");
    expect(source).toContain("Running ${quotaDescription(runningAccount)}");
    expect(source).toContain("${account.enabled ? \"Enabled\" : \"Disabled\"}");
    expect(source).toContain("aria-current={selected ? \"true\" : undefined}");
    expect(css).toContain('.cli-account-submenu');
    expect(css).toContain('width: min(360px, calc(100vw - 16px));');
    expect(css).toMatch(/\.cli-account-parent \{\r?\n  position: relative;\r?\n  width: 100%;/);
    expect(css).toContain('.cli-account-menu > .cli-account-parent');
    expect(css).toContain('display: block;');
    expect(css).toContain('.cli-account-menu .cli-account-parent > button > span');
    expect(css).toContain('padding: 0;');
    expect(css).toMatch(/top: auto;\r?\n  bottom: 0;/);
    expect(css).toContain('flex-direction: column;');
    expect(css).toContain('min-height: 34px;');
    expect(css).toContain('.cli-account-entry > span:first-child:last-child');
    expect(css).toContain('.cli-account-parent > button small');
    expect(source).toContain('Switch account on ${getSensitiveDisplayValue(peer.name, props.privacyMode, "name")}');
    expect(source).toContain('class="cli-session-search-line"');
    expect(source).toContain('class="cli-session-search-wrap"><SearchIcon />');
    expect(source).toContain('class="cli-session-tabs cli-session-state-toggle" role="tablist"');
    expect(source).not.toContain("cli-session-tabs-search");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) 28px;");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(css).toContain(".cli-workspace .cli-session-search-wrap > svg");
    expect(css).toContain(".cli-workspace .cli-session-search-line .cli-session-search-wrap");
    expect(css).toContain(".cli-conversation-empty > img");
    expect(css).toContain("width: 30px;");
    expect(css).toContain("height: 30px;");
    expect(css).toContain(":has(.cli-environment-popover) .cli-workspace-feedback");
    expect(source).toContain("</button>})}");
    expect(css).toMatch(/\.cli-workspace \.cli-context-add-menu\s*\{[\s\S]*?right:\s*0;[\s\S]*?left:\s*auto;/);
    expect(css).toContain("width: min(124px, calc(100vw - 16px));");
    expect(css).toContain('.cli-account-popover-wide');
  });

  it("moves Files, Terminal, and Reviews into the tabbed right workbench", () => {
    const source = readFileSync("webview-src/dashboard/cliSessionsModal.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(source).not.toContain('class="cli-tool-tabs"');
    expect(source).toContain("WorkspaceContextPanel");
    expect(source).toContain('["terminal", "files", "reviews"]');
    expect(source).toContain("WorkspaceFilesView");
    expect(source).toContain("WorkspaceReviewsView");
    expect(source).toContain('class="cli-context-tab-scroll"');
    expect(source).toContain('aria-selected={props.activeTab === tab}');
    expect(source).toContain('title="Cut selected code to the clipboard"');
    expect(source).toContain('navigator.clipboard.writeText(view.state.sliceDoc(selection.from, selection.to))');
    expect(source).toContain("onTab={selectContextTab}");
    expect(source).toContain("if (filePath) props.onReadFile(filePath, selectedProjectPath)");
    expect(source).toContain("target.scrollLeft += event.deltaY");
    expect(source).toContain('scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" })');
    expect(source).toContain("SessionShareModal");
    expect(source).toContain("cli-session-images");
    expect(source).toContain("composerBlockedByOwner");
    expect(source).toContain("Composer disabled here until that run finishes.");
    expect(css).toContain("content-visibility: auto");
    expect(css).toContain("contain-intrinsic-size");
    expect(css).toContain(".cli-workspace .cli-context-tab-scroll");
    expect(css).toContain(".cli-workspace .cli-context-tab-scroll > span.is-active::after");
    expect(css).toContain(".cli-workspace .cli-context-tab-scroll > span > button[aria-selected=\"true\"]");
    expect(css).toMatch(/top: auto;\r?\n  bottom: 0;/);
    expect(css).toContain("flex: 0 0 auto; min-width: 0; border-radius: 6px;");
    expect(css).toContain(".cli-context-tab-scroll::-webkit-scrollbar");
    expect(source).toContain("WorkspaceCodeEditor");
    expect(source).toContain("EditorView.lineWrapping");
    expect(source).toContain("parseUnifiedDiff");
    expect(source).toContain("cli-diff-comparator");
    expect(source).toContain("cli-file-image-preview");
    expect(source).toContain('props.file.kind === "audio"');
    expect(source).toContain('props.file.kind === "video"');
    expect(source).toContain("cli-file-pdf-preview");
    expect(source).toContain("cli-file-document-preview");
    expect(css).toContain(".cli-code-editor");
    expect(css).toContain(".cli-workspace .cli-code-editor .cm-content { min-width: 0; }");
    expect(css).toContain(".cli-diff-cell.is-removed");
  });

  it("connects Environment and terminal controls to real host actions", () => {
    const source = readFileSync("webview-src/dashboard/cliSessionsModal.tsx", "utf8");
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const handlers = readFileSync("src/presentation/dashboard/actionHandlers.ts", "utf8");

    expect(source).toContain("props.onRunTerminal(command");
    expect(source).toContain("props.onCommit(message");
    expect(source).toContain("props.onPush(props.projectPath)");
    expect(main).toContain('sendAction("runWorkspaceTerminalCommand"');
    expect(main).toContain('sendAction("commitWorkspaceChanges"');
    expect(main).toContain('sendAction("pushWorkspaceBranch"');
    expect(handlers).toContain('case "getWorkspaceEnvironment"');
    expect(handlers).toContain('case "cancelWorkspaceTerminalCommand"');
  });

  it("keeps the composer available while realtime session lists omit its catalog", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const panel = readFileSync("src/presentation/dashboard/panel.ts", "utf8");

    expect(main).toContain(
      "setCliComposerConfig(message.payload?.cliComposerConfig ?? cliComposerConfig)"
    );
    expect(main).toContain('typeof realtimeRevision === "number"');
    expect(main).toContain("sessionChanged");
    expect(panel).not.toContain("readCodexCliComposerConfig");
    expect(panel).toContain("{ cliSessions: stabilized, realtimeRevision:");
  });

  it("keeps realtime action callbacks stable and isolates the browser workspace route", () => {
    const hooks = readFileSync("webview-src/dashboard/actionHooks.ts", "utf8");
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(hooks).toContain("const sendAction = useCallback<SendAction>");
    expect(hooks).toContain("}, [dispatch, targetDeviceId]);");
    expect(main).toContain('document.body.classList.toggle("is-cli-workspace-route", workspaceRoute)');
    expect(main).toContain('document.body.classList.toggle("is-dashboard-workspace-route", dashboardWorkspaceRoute)');
    expect(main).toContain("hasBrowserWorkspaceShell(browserPath)");
    expect(main).toContain('dashboardMode={browserPath === "/dash"}');
    expect(main).toContain("is-dashboard-workspace-route");
    expect(readFileSync("webview-src/dashboard/cliSessionsModal.tsx", "utf8")).toContain(
      'props.dashboardMode ? "is-dashboard-mode"'
    );
    expect(css).toContain("body.is-cli-workspace-route { overflow: hidden; }");
    expect(css).toContain("body.is-cli-workspace-route #dashboard-main { display: none !important; }");
    expect(css).toContain("body.is-dashboard-workspace-route #dashboard-main {");
    expect(css).toMatch(/body\.is-dashboard-workspace-route #dashboard-main\s*{[^}]*z-index:\s*10010/s);
    expect(css).toContain("var(--cli-shell-divider-width, 5px)");
    expect(css).toMatch(/\.cli-workspace\.is-dashboard-mode \.cli-conversation\s*{[^}]*visibility:\s*hidden/s);
    expect(css).toMatch(/\.cli-workspace\.is-dashboard-mode \.cli-conversation\s*{[^}]*pointer-events:\s*none/s);
    expect(css).toMatch(/\.cli-project-list\s*{[^}]*align-content:\s*start/s);
    expect(css).toMatch(/\.cli-project-list\s*{[^}]*grid-auto-rows:\s*max-content/s);
  });

  it("keeps the tools panel closed for dashboard and new-chat surfaces", () => {
    const source = readFileSync("webview-src/dashboard/cliSessionsModal.tsx", "utf8");
    const styles = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(source).toContain("if (props.dashboardMode)");
    expect(source).toContain("setRailCollapsed(false);");
    expect(source).toContain("if (newChatProject !== undefined)");
    expect(source).toContain("setContextCollapsed(true);");
    expect(source).toContain("if (props.selectedSession && window.innerWidth >= 1180) setContextCollapsed(false);");
    expect(source).toContain("inert={props.dashboardMode || undefined}");
    expect(styles).toMatch(/\.cli-workspace\.is-dashboard-mode \.cli-context-toggle\s*{[^}]*display:\s*none/s);
    expect(styles).toMatch(/body\.is-dashboard-workspace-route #dashboard-main\s*{[^}]*inset:\s*0 0 0 calc/s);
  });

  it("keys automatic workspace environment loads so realtime renders cannot create a request loop", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(main).toContain("lastAutomaticWorkspaceLoadRef.current === loadKey");
    expect(main).toContain("lastAutomaticWorkspaceLoadRef.current = loadKey");
    expect(main).toContain("cliComposerConfig?.projects?.[0]?.path");
    expect(main).not.toContain("[browserPath, cliComposerConfig?.projects, isBrowserDashboard");
  });

  it("consolidates completed turn activity while keeping only the latest live item last", () => {
    const items = consolidateSessionMessages([
      { id: "user-1", kind: "message", role: "user", text: "Start." },
      { id: "assistant-1", kind: "message", role: "assistant", text: "Starting." },
      { id: "change-1", kind: "file-change", text: "Edited a.ts" },
      { id: "command-1", kind: "command", text: "npm test" },
      { id: "thinking-stale", kind: "reasoning", status: "inProgress", text: "Old reasoning" },
      { id: "assistant-2", kind: "message", role: "assistant", text: "Tests passed." },
      { id: "command-2", kind: "command", status: "completed", text: "npm run compile" },
      { id: "thinking-live", kind: "reasoning", status: "inProgress", text: "Reviewing results" },
      { id: "user-2", kind: "message", role: "user", text: "Continue." },
      { id: "command-3", kind: "command", status: "inProgress", text: "npm run build" }
    ]);

    expect(items).toHaveLength(7);
    expect(items[2]).toMatchObject({
      id: "activity-group-change-1",
      messages: [{ id: "change-1" }, { id: "command-1" }, { id: "command-2" }]
    });
    expect(items[3]).toMatchObject({ id: "assistant-2" });
    expect(items[4]).toMatchObject({ id: "thinking-live", status: "inProgress" });
    expect(items[5]).toMatchObject({ id: "user-2" });
    expect(items[6]).toMatchObject({ id: "command-3", status: "inProgress" });
  });

  it("defaults the workspace rail to Active when no session is selected", () => {
    const source = readFileSync("webview-src/dashboard/cliSessionsModal.tsx", "utf8");
    const stateEffectStart = source.indexOf("// A session deep link should open in its matching state tab");
    const stateEffect = source.slice(stateEffectStart, source.indexOf("setDeleteTarget(undefined);", stateEffectStart));

    expect(stateEffectStart).toBeGreaterThan(-1);
    expect(stateEffect).toContain('setSection(props.selectedSession?.archived ? "archived" : "active")');
    expect(stateEffect).not.toContain("if (props.selectedSession)");
  });

  it("uses the root route for the session workspace and keeps the account dashboard at /dash", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(source).toContain('return pathname === "/" || pathname === "/workspace"');
    expect(source).toContain('sendAction("openWebDashboard", undefined, { path: "/" })');
    expect(source).toContain('onDashboard={() => navigateDashboardPath("/dash", setBrowserPath)}');
    expect(source).toContain('type: "dashboard:workspace-presence", viewing');
    expect(source).toContain('return pathname === "/dash" || isCliSessionsPath(pathname);');
    expect(source).toContain("if (!hasBrowserWorkspaceShell(browserPath)) return;");
    expect(source).toContain("if (hasBrowserWorkspaceShell(path)) requestCliSessions();");
    expect(source).toContain("window.setInterval(announceCurrentVisibility, 15_000)");
  });

  it("summarizes completed tools as a compact natural-language group", () => {
    expect(consolidatedActivityLabel([
      { id: "file-1", kind: "file-change", text: "Edited .vscodeignore" },
      { id: "command-1", kind: "command", text: "npm run package" }
    ])).toBe("Edited a file, ran a command");
    expect(consolidatedActivityLabel([
      { id: "command-1", kind: "command", text: "npm test" },
      { id: "command-2", kind: "command", text: "npm run package" },
      { id: "image-1", kind: "image", text: "Viewed screenshot" }
    ])).toBe("Ran 2 commands, viewed an image");
  });

  it("renders command and tool-call details instead of generic placeholders", () => {
    const source = readFileSync("webview-src/dashboard/cliSessionsModal.tsx", "utf8");
    expect(source).toContain('message.command ?? message.text');
    expect(source).toContain('<strong>Arguments</strong>');
    expect(source).toContain('message.title ?? "Ran command"');
  });

  it("keeps line spacing readable while collapsing oversized paragraph gaps", () => {
    expect(splitMessageParagraphs("First paragraph.\n\n\nSecond paragraph.\ncontinued line")).toEqual([
      "First paragraph.",
      "Second paragraph.\ncontinued line"
    ]);
    const styles = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(styles).toContain(".cli-message-paragraph + .cli-message-paragraph { margin-top: .35em; }");
  });

  it("moves a completed live command into the existing turn group", () => {
    const before = consolidateSessionMessages([
      { id: "user-1", kind: "message", role: "user", text: "Start." },
      { id: "command-1", kind: "command", status: "completed", text: "npm test" },
      { id: "command-2", kind: "command", status: "inProgress", text: "npm run build" }
    ]);
    const after = consolidateSessionMessages([
      { id: "user-1", kind: "message", role: "user", text: "Start." },
      { id: "command-1", kind: "command", status: "completed", text: "npm test" },
      { id: "command-2", kind: "command", status: "completed", text: "npm run build" }
    ]);

    expect(before[1]).toMatchObject({ id: "activity-group-command-1", messages: [{ id: "command-1" }] });
    expect(before[2]).toMatchObject({ id: "command-2", status: "inProgress" });
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({
      id: "activity-group-command-1",
      messages: [{ id: "command-1" }, { id: "command-2", status: "completed" }]
    });
  });

  it("keeps image activities separate while grouping the other completed turn tools", () => {
    const items = consolidateSessionMessages([
      { id: "user-1", kind: "message", role: "user", text: "Review this." },
      { id: "command-1", kind: "command", status: "completed", text: "npm test" },
      { id: "image-1", kind: "image", status: "completed", text: "screenshot", images: [{ src: "data:image/png;base64,AA==" }] },
      { id: "tool-1", kind: "tool-call", status: "completed", text: "Searched docs" }
    ]);

    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({ id: "activity-group-command-1", messages: [{ id: "command-1" }, { id: "tool-1" }] });
    expect(items[2]).toMatchObject({ id: "image-1", kind: "image", images: [{ src: "data:image/png;base64,AA==" }] });
  });

  it("shows running thinking but removes it once completed", () => {
    const running = consolidateSessionMessages([
      { id: "user-1", kind: "message", role: "user", text: "Start." },
      { id: "command-1", kind: "command", status: "completed", text: "npm test" },
      { id: "thinking-1", kind: "reasoning", status: "inProgress", text: "Checking" }
    ]);
    const completed = consolidateSessionMessages([
      { id: "user-1", kind: "message", role: "user", text: "Start." },
      { id: "command-1", kind: "command", status: "completed", text: "npm test" },
      { id: "thinking-1", kind: "reasoning", status: "completed", text: "Checked" }
    ]);

    expect(running[2]).toMatchObject({ id: "thinking-1", status: "inProgress" });
    expect(completed).toHaveLength(2);
    expect(completed[1]).toMatchObject({ messages: [{ id: "command-1" }] });
  });

  it("keeps concurrent running tools visible instead of collapsing older calls", () => {
    const items = consolidateSessionMessages([
      { id: "user-1", kind: "message", role: "user", text: "Run both." },
      { id: "tool-1", kind: "tool-call", status: "inProgress", text: "search is running." },
      { id: "tool-2", kind: "tool-call", status: "inProgress", text: "exec is running." }
    ]);

    expect(items).toMatchObject([
      { id: "user-1" },
      { id: "tool-1", status: "inProgress" },
      { id: "tool-2", status: "inProgress" }
    ]);
  });

  it("pauses running-session polling while the dashboard is hidden", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");

    expect(main).toContain('document.visibilityState === "visible"');
    expect(main).toContain('document.addEventListener("visibilitychange", onVisibilityChange)');
    expect(main).toContain('document.removeEventListener("visibilitychange", onVisibilityChange)');
  });
});
