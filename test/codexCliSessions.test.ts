import { mkdtemp, mkdir, open, readFile, readdir, rm, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as safeReads from '../src/utils/safeFileReads';
import * as fileSystem from 'fs/promises';
vi.mock('fs/promises', {spy:true});
import {
  parseCodexAppServerThreadItems,
  resolveRecordedSessionProject,
  getCodexCliPathCandidates,
  isCodexCliAvailable,
  readCodexCliComposerConfig,
  readCodexCliSessionMessages,
  readCodexCliSessionMessagePage,
  readCodexCliSessionInitialPrompt,
  readCodexCliSessionSummary,
  readNewCodexCliSessionSummary,
  renameCodexCliSession,
  archiveCodexCliSession,
  unarchiveCodexCliSession,
  deleteCodexCliSession,
  readCodexCliSessions,
  readRunningCodexSessionIds,
  readTrackedCliTurns,
  startCodexCliSession,
  sendCodexCliSessionMessage,
  cancelCodexCliSessionTurn
} from "../src/services/codexSessionResume";

const sessionId = "01a04882-d037-7a42-ad24-9afb61901188";
const roots: string[] = [];

beforeEach(() => {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback?: unknown) => key === "codexSessionTransport" ? "cli" : fallback } as vscode.WorkspaceConfiguration);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex session integration", () => {
  it("follows native renamed titles rather than the original prompt or a newer index entry", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-native-title-")); roots.push(home);
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE threads (id TEXT, name TEXT, title TEXT, updated_at INTEGER, updated_at_ms INTEGER)");
      db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(sessionId, "Revised native name", "Original prompt", 100, 100123);
      await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Old index title", updated_at: new Date().toISOString() }) + "\n");
      expect((await readCodexCliSessionSummary(sessionId, home))?.title).toBe("Revised native name");
      db.prepare("UPDATE threads SET name=?").run("Second native revision");
      expect((await readCodexCliSessions(home))[0]?.title).toBe("Second native revision");
      db.prepare("UPDATE threads SET name=NULL").run();
      expect((await readCodexCliSessionSummary(sessionId, home))?.title).toBe("Old index title");
    } finally { db.close(); }
  });
  it('bounds project discovery, shares concurrent reads, and reuses the short cache', async()=>{
    const home=await mkdtemp(path.join(os.tmpdir(),'codex-bounded-projects-'));roots.push(home);
    const folders=Array.from({length:20},(_,index)=>path.join(home,`project-${index}`));
    const db=new DatabaseSync(path.join(home,'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT); CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT)');
    folders.forEach((folder,index)=>db.prepare('INSERT INTO project_roots VALUES (?, ?, ?)').run('p',index,folder));db.close();
    const {stat:original}=await vi.importActual<typeof fileSystem>('fs/promises');let active=0,maxActive=0,probes=0,release!:()=>void;
    const stat=vi.spyOn(fileSystem,'stat').mockImplementation(((file: string,...args:unknown[])=>{
      if(!folders.includes(String(file)))return original(file,...args as []);
      probes++;active++;maxActive=Math.max(maxActive,active);
      return new Promise(resolve=>{
        const done=()=>{active--;resolve({isDirectory:()=>true});};
        if(file===folders[0])release=done;else setTimeout(done,15);
      });
    }) as typeof fileSystem.stat);
    try{
      const [one,two]=await Promise.all([readCodexCliComposerConfig(home),readCodexCliComposerConfig(home)]);
      expect(one).toEqual(two);expect(probes).toBe(20);expect(maxActive).toBeLessThanOrEqual(8);
      expect(one.projects?.map(project=>project.path)).not.toContain(folders[0]);
      expect(one.projects?.filter(project=>folders.includes(project.path))).toHaveLength(19);
      await readCodexCliComposerConfig(home);expect(probes).toBe(20);
    }finally{release?.();stat.mockRestore();}
  });
  it('shares concurrent transcript snapshots without duplicating reads or messages', async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'codex-shared-transcript-'));roots.push(root);await mkdir(path.join(root,'sessions'));
    const file=path.join(root,'sessions',`rollout-${sessionId}.jsonl`);
    await writeFile(file,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Read once'}]}})+'\n');
    const snapshot=safeReads.readSafeFileSnapshot;let reads=0;
    const spy=vi.spyOn(safeReads,'readSafeFileSnapshot').mockImplementation(async(file,options)=>{
      if(options.maxBytes===25*1024*1024){reads++;await new Promise(resolve=>setTimeout(resolve,30));}
      return snapshot(file,options);
    });
    try{
      const [one,two]=await Promise.all([readCodexCliSessionMessages(sessionId,root),readCodexCliSessionMessages(sessionId,root)]);
      expect(reads).toBe(1);expect(one).toEqual(two);expect(one).toHaveLength(1);expect(one[0]?.text).toBe('Read once');
    }finally{spy.mockRestore();}
  });
  it('reads only the initial prompt, excluding injected context and uploaded file bodies', async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),'codex-initial-prompt-'));roots.push(root);await mkdir(path.join(root,'sessions'));
    const record=(text:string)=>JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
    await writeFile(path.join(root,'sessions',`rollout-${sessionId}.jsonl`),[record('# AGENTS.md instructions for project'),record('<environment_context>Private context</environment_context>'),record('Original request\n\n<attached_file name="brief.txt">\nPrivate file body\n</attached_file>'),record('Later follow-up')].join('\n')+'\n');
    expect(await readCodexCliSessionInitialPrompt(sessionId,root)).toBe('Original request');
  });
  it('hydrates local previews sequentially so pending reads cannot exceed the image page budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-image-buffers-')); roots.push(root);
    await mkdir(path.join(root, 'sessions'));
    const images = [0, 1, 2].map(index => path.join(root, `image-${index}.png`));
    for (const image of images) await writeFile(image, Buffer.from('iVBORw0KGgo=', 'base64'));
    const snapshot = safeReads.readSafeFileSnapshot; let active = 0, maximum = 0;
    const spy = vi.spyOn(safeReads, 'readSafeFileSnapshot').mockImplementation(async (file, options) => {
      if (!images.includes(file)) return snapshot(file, options);
      active++; maximum = Math.max(maximum, active);
      try { await new Promise(resolve => setTimeout(resolve, 10)); return await snapshot(file, options); }
      finally { active--; }
    });
    try {
      await writeFile(path.join(root, 'sessions', `rollout-${sessionId}.jsonl`), images.map((image, index) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Image ' + index }, { type: 'input_image', image_url: image }] } })).join('\n') + '\n');
      const page = await readCodexCliSessionMessagePage(sessionId, undefined, root);
      expect(maximum).toBe(1); expect(page.messages).toHaveLength(3);
      for (const message of page.messages) expect(message.images?.[0]?.src).toBe('data:image/png;base64,iVBORw0KGgo=');
    } finally { spy.mockRestore(); }
  });
  it('preserves text upload snapshots beyond the display-text limit in native and saved transcript formats', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-upload-history-')); roots.push(root);
    await mkdir(path.join(root, 'sessions'));
    const content = 'x'.repeat(20000), text = '<attached_file name="brief.txt">\n' + content + '\n</attached_file>';
    const native = parseCodexAppServerThreadItems({ thread: { turns: [{ id: 'turn', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text }] }] }] } });
    expect(native[0]?.text).toHaveLength(12000); expect(native[0]?.textAttachments).toEqual([{ name: 'brief.txt', text: content }]);
    const lines = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: text + '\n\n' } }
    ];
    await writeFile(path.join(root, 'sessions', `rollout-${sessionId}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    const page = await readCodexCliSessionMessagePage(sessionId, undefined, root);
    expect(page.messages.length).toBeGreaterThan(0);
    for (const message of page.messages) expect(message.textAttachments).toEqual([{ name: 'brief.txt', text: content }]);
  });
  it('charges failed image decoding against the page budget instead of scanning an unlimited set of invalid files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-invalid-images-')); roots.push(root);
    await mkdir(path.join(root, 'sessions'));
    const image = path.join(root, 'invalid.png'); await writeFile(image, 'not an image');
    const snapshot = safeReads.readSafeFileSnapshot; let reads = 0;
    const spy = vi.spyOn(safeReads, 'readSafeFileSnapshot').mockImplementation(async (file, options) => {
      const result = await snapshot(file, options);
      if (file !== image) return result;
      reads++; return { ...result, size: 8 * 1024 * 1024 };
    });
    try {
      await writeFile(path.join(root, 'sessions', `rollout-${sessionId}.jsonl`), Array.from({length:8}, (_, index) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Image ' + index }, { type: 'input_image', image_url: image }] } })).join('\n') + '\n');
      expect((await readCodexCliSessionMessagePage(sessionId, undefined, root)).messages).toHaveLength(8);
      expect(reads).toBe(2);
    } finally { spy.mockRestore(); }
  });
  it("pages saved history across oversized records without gaps or a stuck cursor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-history-pages-")); roots.push(root);
    await mkdir(path.join(root, "sessions"));
    const transcript = path.join(root, "sessions", `rollout-${sessionId}.jsonl`);
    const line = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }) + "\n";
    const first = line("Earlier history");
    await writeFile(transcript, first + line("界".repeat(110000)));
    const latest = await readCodexCliSessionMessagePage(sessionId, undefined, root);
    expect(latest.messages.at(-1)?.text).toMatch(/^界/);
    expect(latest.warnings).toEqual([]);
    if (latest.olderThan) {
      const older = await readCodexCliSessionMessagePage(sessionId, latest.olderThan, root);
      expect(older.messages[0]?.text).toBe("Earlier history");
      expect(older.olderThan).toBeUndefined();
    } else expect(latest.messages[0]?.text).toBe("Earlier history");
    await writeFile(transcript, '{"partial":', { flag: "a" });
    const afterPartial = await readCodexCliSessionMessagePage(sessionId, undefined, root);
    expect(afterPartial.messages.some(message => message.text.startsWith("界") || message.text === "Earlier history")).toBe(true);
    await truncate(transcript, 0);
    await expect(readCodexCliSessionMessagePage(sessionId, String(Buffer.byteLength(first)), root)).rejects.toThrow(/changed/);
    await expect(readCodexCliSessionMessagePage(sessionId, "bad", root)).rejects.toThrow(/cursor/);
  });
  it("reads recorded model and thinking settings without requiring newer native columns", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-session-settings-")); roots.push(home);
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE threads (id TEXT, title TEXT, model TEXT, reasoning_effort TEXT)");
      db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(sessionId, "Recorded task", "gpt-5", "high");
    } finally { db.close(); }
    await expect(readCodexCliSessions(home)).resolves.toMatchObject([{ id: sessionId, model: "gpt-5", reasoningEffort: "high" }]);
    await expect(readCodexCliSessionSummary(sessionId, home)).resolves.toMatchObject({ id: sessionId, model: "gpt-5", reasoningEffort: "high" });
  });
  it("lists existing native projects without requiring a running session or an open workspace", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-project-picker-")); roots.push(home);
    const first = path.join(home, "first"), second = path.join(home, "second"), empty = path.join(home, "empty");
    await Promise.all([first, second, empty].map(directory => mkdir(directory)));
    const database = new DatabaseSync(path.join(home, "state_5.sqlite"));
    try {
      database.exec("CREATE TABLE threads (id TEXT, cwd TEXT); CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT)");
      database.prepare("INSERT INTO threads VALUES (?, ?)").run(sessionId, second);
      for (const directory of [empty, first, path.join(home, "missing"), "relative-path"])
        database.prepare("INSERT INTO project_roots VALUES ('project', 0, ?)").run(directory);
    } finally { database.close(); }
    const previousFolders = vscode.workspace.workspaceFolders;
    Object.assign(vscode.workspace, { workspaceFolders: [{ name: "first", uri: { fsPath: first } }] });
    try {
      const config = await readCodexCliComposerConfig(home);
      expect(config.projects?.map(project => project.path).sort()).toEqual([first, second, empty].sort());
    } finally { Object.assign(vscode.workspace, { workspaceFolders: previousFolders }); }
  });



  it("keeps a bounded transcript window and unique sequence IDs across large appends", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-bounded-window-"));
    roots.push(root);
    const directory = path.join(root, "sessions");
    await mkdir(directory);
    const transcript = path.join(directory, `rollout-${sessionId}.jsonl`);
    const line = (index: number) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `message-${index}` }] } });
    await writeFile(transcript, Array.from({ length: 750 }, (_, index) => line(index)).join("\n") + "\n");
    const initial = await readCodexCliSessionMessages(sessionId, root);
    expect(initial).toHaveLength(250);
    expect(initial[0]?.text).toBe("message-500");
    await writeFile(transcript, Array.from({ length: 500 }, (_, index) => line(index + 750)).join("\n") + "\n" + line(1250), { flag: "a" });
    const appended = await readCodexCliSessionMessages(sessionId, root);
    expect(appended).toHaveLength(250);
    expect(appended[0]?.text).toBe("message-1001");
    expect(appended.at(-1)?.id).toMatch(/^1250-/);
    expect(new Set(appended.map((message) => message.id)).size).toBe(250);
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toEqual(appended);
  });

  it("copies a partial record so it cannot retain the entire transcript read buffer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-buffer-retention-"));
    roots.push(root);
    await mkdir(path.join(root, "sessions"));
    const tail = '{"partial":';
    await writeFile(path.join(root, "sessions", `rollout-${sessionId}.jsonl`), " ".repeat(100_000) + "\n" + tail);
    const copy = vi.spyOn(Buffer, "from");
    try {
      await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toEqual([]);
      const index = copy.mock.calls.findIndex(([value]) => Buffer.isBuffer(value) && value.toString() === tail);
      expect(index).toBeGreaterThanOrEqual(0);
      expect((copy.mock.results[index]?.value as Buffer).buffer.byteLength).toBeLessThan(100_000);
    } finally { copy.mockRestore(); }
  });

  it("includes the per-user Windows Codex install and launcher shims", () => {
    const candidates = getCodexCliPathCandidates("win32", {
      LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
      APPDATA: "C:\\Users\\demo\\AppData\\Roaming",
      PATH: "C:\\Windows\\System32;C:\\Users\\demo\\bin"
    });

    expect(candidates).toContain("C:\\Users\\demo\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe");
    expect(candidates).toContain("C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd");
    expect(candidates).toContain("C:\\Users\\demo\\bin\\codex.exe");
  });

  it("launches a configured CLI during availability checks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-availability-"));
    roots.push(root);
    const script = path.join(root, "codex.js");
    const marker = path.join(root, "probes.txt");
    await writeFile(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.exit(process.argv.includes('--version') ? 0 : 1);`, "utf8");
    const previousPath = process.env["CODEX_CLI_PATH"];
    process.env["CODEX_CLI_PATH"] = script;
    const vscodeModule = await import("vscode");
    (vscodeModule as unknown as { extensions: { getExtension: () => undefined } }).extensions = {
      getExtension: () => undefined
    };
    try {
      await expect(isCodexCliAvailable()).resolves.toBe(true);
      await expect(isCodexCliAvailable()).resolves.toBe(true);
      await expect(readFile(marker, "utf8")).resolves.toBe("x");
    } finally {
      if (previousPath === undefined) delete process.env["CODEX_CLI_PATH"];
      else process.env["CODEX_CLI_PATH"] = previousPath;
    }
  });




  it("reads the local running-turn journal and ignores malformed or duplicate entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-running-journal-"));
    roots.push(root);
    await writeFile(path.join(root, "codex-manager-running-turns.json"), JSON.stringify([
      { id: sessionId, projectPath: "D:/repo", startedAt: 123 },
      { id: sessionId, projectPath: "D:/other", startedAt: 456 },
      { id: "not-a-session", projectPath: "D:/repo", startedAt: 123 },
      { id: "01a04882-d037-7a42-ad24-9afb61901189", projectPath: "", startedAt: 123 }
    ]));

    await expect(readTrackedCliTurns(root)).resolves.toEqual([
      { id: sessionId, projectPath: "D:/repo", startedAt: 123 }
    ]);

    await writeFile(path.join(root, "codex-manager-running-turns.json"), "not-json");
    await expect(readTrackedCliTurns(root)).resolves.toEqual([]);

    await writeFile(path.join(root, "codex-manager-running-turns.json"), "x".repeat(300_000));
    await expect(readTrackedCliTurns(root)).resolves.toEqual([]);
  });

  it("maps rich app-server items into expandable dashboard activity", () => {
    const items = parseCodexAppServerThreadItems({
      thread: {
        turns: [{
          id: "turn-1",
          status: "completed",
          startedAt: 1_787_970_000,
          items: [
            { type: "userMessage", id: "user-1", content: [{ type: "text", text: "Build it" }, { type: "image", imageUrl: "data:image/png;base64,aGVsbG8=" }] },
            { type: "reasoning", id: "reason-1", summary: ["Inspecting the implementation"], content: [] },
            { type: "commandExecution", id: "cmd-1", command: ["npm", "test"], cwd: "D:/repo", status: "completed", aggregatedOutput: "42 passed", exitCode: 0, durationMs: 1250 },
            { type: "fileChange", id: "files-1", status: "completed", changes: [{ path: "src/app.ts", kind: "update", diff: "+done" }] },
            { type: "mcpToolCall", id: "tool-1", server: "docs", tool: "search", status: "failed", arguments: { q: "Codex" }, error: { message: "offline" }, durationMs: 40 },
            { type: "ImageView", id: "image-1", path: "file:///tmp/screenshot.png" },
            { type: "agentMessage", id: "agent-1", text: "Completed", phase: "final_answer" }
          ]
        }]
      }
    });

    expect(items).toMatchObject([
      { id: "user-1", kind: "message", role: "user", text: "Build it", images: [{ src: "data:image/png;base64,aGVsbG8=" }] },
      { id: "reason-1", kind: "reasoning", title: "Reasoning", text: "Inspecting the implementation" },
      { id: "cmd-1", kind: "command", command: "npm test", output: "42 passed", exitCode: 0, durationMs: 1250 },
      { id: "files-1", kind: "file-change", title: "Edited 1 file", changes: [{ path: "src/app.ts", kind: "update", diff: "+done" }] },
      { id: "tool-1", kind: "tool-call", title: "search failed", subtitle: "docs", arguments: "{\n  \"q\": \"Codex\"\n}", status: "failed" },
      { id: "image-1", kind: "image", title: "Viewed image", text: "screenshot.png", images: [{ src: "file:///tmp/screenshot.png" }] },
      { id: "agent-1", kind: "message", role: "assistant", text: "Completed" }
    ]);
  });

  it("shows in-progress activity and terminal turn failures", () => {
    const items = parseCodexAppServerThreadItems({
      thread: {
        turns: [{
          id: "turn-failed",
          status: "failed",
          error: { message: "Usage limit reached" },
          items: [{ type: "commandExecution", id: "cmd-running", command: "npm test", cwd: "D:/repo", status: "inProgress" }]
        }]
      }
    });

    expect(items).toMatchObject([
      { id: "cmd-running", kind: "command", title: "Running command", status: "inProgress" },
      { id: "turn-failed-error", kind: "error", title: "Turn failed", status: "failed", text: "Usage limit reached" }
    ]);
  });

  it("keeps every Codex activity family visible with its user-facing payload", () => {
    const items = parseCodexAppServerThreadItems({
      thread: {
        turns: [{
          status: "completed",
          items: [
            { type: "plan", id: "plan-1", plan: [{ text: "Inspect" }, { text: "Fix" }] },
            { type: "collabToolCall", id: "agent-1", tool: "delegate", prompt: "Ask a helper" },
            { type: "webSearch", id: "search-1", query: "Codex docs", result: "Docs result" },
            { type: "enteredReviewMode", id: "review-1", review: "Review the diff" },
            { type: "contextCompaction", id: "compact-1" },
            { type: "Error", id: "error-1", message: "Tool unavailable" },
            { type: "ToolCall", id: "dynamic-1", name: "lookup", input: { q: "Codex" }, result: "Found it" }
          ]
        }]
      }
    });

    expect(items).toMatchObject([
      { id: "plan-1", kind: "plan", text: "Inspect\n\nFix" },
      { id: "agent-1", kind: "collaboration", subtitle: "delegate", text: "Ask a helper" },
      { id: "search-1", kind: "web-search", text: "Codex docs", result: "Docs result" },
      { id: "review-1", kind: "review", title: "Started review" },
      { id: "compact-1", kind: "compaction" },
      { id: "error-1", kind: "error", status: "failed", text: "Tool unavailable" },
      { id: "dynamic-1", kind: "tool-call", subtitle: "Tool", arguments: "{\n  \"q\": \"Codex\"\n}" }
    ]);
  });

  it("shows compaction progress separately from completed compaction", () => {
    const items = parseCodexAppServerThreadItems({
      thread: { turns: [{ status: "inProgress", items: [{ type: "contextCompaction", id: "compact-running" }] }] }
    });
    expect(items).toMatchObject([{ id: "compact-running", kind: "compaction", title: "Compacting context", status: "inProgress" }]);
    const completed = parseCodexAppServerThreadItems({
      thread: { turns: [{ status: "completed", items: [{ type: "contextCompaction", id: "compact-done" }] }] }
    });
    expect(completed).toMatchObject([{ id: "compact-done", kind: "compaction", title: "Context compacted", status: "completed" }]);
  });

  it("preserves named agent lifecycle and status detail without treating waits as completion", () => {
    const items = parseCodexAppServerThreadItems({ thread: { turns: [{ status: "completed", items: [
      { type: "collabToolCall", id: "start", tool: "spawn_agent", agentName: "Reviewer", status: "completed", prompt: "Review", agentsStates: { reviewer: "running" } },
      { type: "collabToolCall", id: "wait", tool: "wait_agent", agentName: "Reviewer", status: "completed", result: "Still running" },
      { type: "collabToolCall", id: "fail", tool: "spawn_agent", agentName: "Reviewer", status: "failed" },
      { type: "collabToolCall", id: "finished", tool: "wait_agent", agentName: "Reviewer", status: "completed", agentsStates: { reviewer: { completed: "Reviewed" } } }
    ] }] } });
    expect(items).toMatchObject([
      { title: "Reviewer started working", result: expect.stringContaining("running") },
      { title: "Reviewer updated", result: "Still running" },
      { title: "Reviewer failed", status: "failed" },
      { title: "Reviewer finished", result: expect.stringContaining("Reviewed") }
    ]);
  });

  it("reads a former Codex-home journal only until the canonical journal exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-journal-migration-"));
    roots.push(root);
    const canonicalRoot = path.join(root, ".codex-manager");
    const legacyPath = path.join(root, ".codex", "codex-manager-running-turns.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify([{ id: sessionId, projectPath: "D:/old", startedAt: 123 }]));

    await expect(readTrackedCliTurns(canonicalRoot, legacyPath)).resolves.toEqual([
      { id: sessionId, projectPath: "D:/old", startedAt: 123 }
    ]);

    await mkdir(canonicalRoot, { recursive: true });
    await writeFile(
      path.join(canonicalRoot, "codex-manager-running-turns.json"),
      JSON.stringify([{ id: sessionId, projectPath: "D:/new", startedAt: 456 }])
    );
    await expect(readTrackedCliTurns(canonicalRoot, legacyPath)).resolves.toEqual([
      { id: sessionId, projectPath: "D:/new", startedAt: 456 }
    ]);
  });

  it("surfaces live custom tool calls and image output", () => {
    const running = parseCodexAppServerThreadItems({
      thread: { turns: [{ status: "inProgress", items: [{ type: "customToolCall", id: "call-1", name: "search", input: "query=Codex" }] }] }
    });
    expect(running).toMatchObject([{ id: "call-1", kind: "tool-call", status: "inProgress", title: "Using search" }]);

    const completed = parseCodexAppServerThreadItems({
      thread: { turns: [{ status: "completed", items: [{ type: "imageGeneration", id: "call-2", output: [{ type: "output_image", image_url: "data:image/png;base64,AA==" }] }] }] }
    });
    expect(completed).toMatchObject([{ id: "call-2", kind: "image", title: "Generated image", images: [{ src: "data:image/png;base64,AA==" }] }]);
  });

  it("decodes raw MCP image content and preserves tool failures", () => {
    const image = parseCodexAppServerThreadItems({
      thread: { turns: [{ status: "completed", items: [{ type: "customToolCall", id: "image-call", name: "image", output: { type: "image", mimeType: "image/png", data: "AA==" } }] }] }
    });
    expect(image).toMatchObject([{ id: "image-call", kind: "image", images: [{ src: "data:image/png;base64,AA==" }] }]);

    const failed = parseCodexAppServerThreadItems({
      thread: { turns: [{ status: "completed", items: [{ type: "customToolCall", id: "failed-call", name: "exec", status: "failed", error: { message: "permission denied" } }] }] }
    });
    expect(failed).toMatchObject([{ id: "failed-call", kind: "tool-call", status: "failed", title: "exec failed" }]);
  });

  it("keeps historical child activities completed when only the turn failed", () => {
    const items = parseCodexAppServerThreadItems({
      thread: {
        turns: [{
          id: "turn-failed-with-history",
          status: "failed",
          error: { message: "The final response failed" },
          items: [{ type: "reasoning", id: "reason-history", summary: ["Reviewed the changes"] }]
        }]
      }
    });

    expect(items).toMatchObject([
      { id: "reason-history", kind: "reasoning", status: "completed" },
      { id: "turn-failed-with-history-error", kind: "error", status: "failed" }
    ]);
  });

  it("maps persisted Codex activities when app-server content is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-activity-"));
    roots.push(root);
    await mkdir(path.join(root, "sessions", "2026", "08", "29"), { recursive: true });
    const transcript = path.join(root, "sessions", "2026", "08", "29", `rollout-${sessionId}.jsonl`);
    await writeFile(transcript, [
      JSON.stringify({ timestamp: "2026-08-29T03:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Check it" }] } }),
      JSON.stringify({ timestamp: "2026-08-29T03:00:01Z", type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "cmd-1", command: "npm test", cwd: "D:/repo", status: "completed", aggregated_output: "43 passed", exit_code: 0, duration: 1000 } } }),
      JSON.stringify({ timestamp: "2026-08-29T03:00:02Z", type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", id: "files-1", status: "completed", changes: { "src/app.ts": { type: "update", unified_diff: "+done" } } } } }),
      JSON.stringify({ timestamp: "2026-08-29T03:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done" }] } })
    ].join("\n"));

    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([
      { role: "user", text: "Check it" },
      { kind: "command", command: "npm test", output: "43 passed", exitCode: 0 },
      { kind: "file-change", changes: [{ path: "src/app.ts", kind: "update", diff: "+done" }] },
      { role: "assistant", text: "Done" }
    ]);
  });

  it("lists sessions with running status and reads only user/assistant messages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-sessions-"));
    roots.push(root);
    await mkdir(path.join(root, "sessions", "2026", "08", "28"), { recursive: true });
    await mkdir(path.join(root, "thread-writer-locks"), { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Demo", updated_at: "2026-08-28T20:50:00Z" }));
    await writeFile(path.join(root, "thread-writer-locks", `${sessionId}.lock`), "");
    const transcript = path.join(root, "sessions", "2026", "08", "28", `rollout-${sessionId}.jsonl`);
    await writeFile(transcript, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "D:/repo", originator: "codex_vscode", source: "vscode" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-08-28T20:50:00Z", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "hidden" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-08-28T20:50:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-08-28T20:50:02Z", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Hi there" }] } })
    ].join("\n"));

    await expect(readCodexCliSessions(root)).resolves.toMatchObject([
      { id: sessionId, title: "Demo", status: "running", projectPath: "D:/repo", sessionSurface: "vscode", runningBy: "another Codex process", canStop: false }
    ]);
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there" }
    ]);
  });

  it("surfaces live transcript activities and replaces them with completion events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-live-activity-"));
    roots.push(root);
    await mkdir(path.join(root, "sessions", "2026", "08", "29"), { recursive: true });
    const transcript = path.join(root, "sessions", "2026", "08", "29", `rollout-${sessionId}.jsonl`);
    await writeFile(transcript, [
      JSON.stringify({ timestamp: "2026-08-29T03:00:00Z", type: "event_msg", payload: { type: "item_started", item: { type: "CommandExecution", id: "cmd-live", command: "npm test", cwd: "D:/repo" } } }),
      JSON.stringify({ timestamp: "2026-08-29T03:00:01Z", type: "event_msg", payload: { type: "item_started", item: { type: "Reasoning", id: "reason-live", summary_text: "Inspecting the failing test" } } })
    ].join("\n"));
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([
      { id: "cmd-live", kind: "command", status: "inProgress" },
      { id: "reason-live", kind: "reasoning", status: "inProgress", text: "Inspecting the failing test" }
    ]);

    await writeFile(transcript, "\n" + JSON.stringify({ timestamp: "2026-08-29T03:00:02Z", type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "cmd-live", command: "npm test", cwd: "D:/repo", status: "completed", aggregated_output: "42 passed", exit_code: 0 } } }), { flag: "a" });
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([
      { id: "cmd-live", kind: "command", status: "completed", output: "42 passed" },
      { id: "reason-live", kind: "reasoning", status: "inProgress", text: "Inspecting the failing test" }
    ]);
  });

  it("reads legacy function calls and replaces starts with correlated completion output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-function-call-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Function", updated_at: "2026-08-30T10:00:00Z" }));
    const transcript = path.join(sessionDirectory, `rollout-${sessionId}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "response_item", timestamp: "2026-08-30T10:00:00Z", payload: { type: "function_call", id: "fc-1", call_id: "call-1", name: "shell_command", arguments: "command=npm test" } }));
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([{ id: "call-1", kind: "tool-call", status: "inProgress", title: "Using shell_command" }]);
    await writeFile(transcript, "\n" + JSON.stringify({ type: "response_item", timestamp: "2026-08-30T10:00:01Z", payload: { type: "function_call_output", call_id: "call-1", output: "42 passed" } }), { flag: "a" });
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([{ id: "call-1", kind: "tool-call", status: "completed", title: "Used shell_command", subtitle: "shell_command", result: "42 passed" }]);
  });

  it("renders legacy tool output errors as failed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-function-error-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Function error", updated_at: "2026-08-30T10:00:00Z" }));
    await writeFile(path.join(sessionDirectory, `rollout-${sessionId}.jsonl`), [
      JSON.stringify({ type: "response_item", timestamp: "2026-08-30T10:00:00Z", payload: { type: "function_call", call_id: "failed-1", name: "exec", arguments: "npm test" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-08-30T10:00:01Z", payload: { type: "function_call_output", call_id: "failed-1", output: "execution error: permission denied" } })
    ].join("\n"));
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([{ id: "failed-1", kind: "tool-call", status: "failed", title: "exec failed", subtitle: "exec" }]);
  });

  it("does not double-count a custom call that also emits a concrete command activity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-correlated-command-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Correlated", updated_at: "2026-08-30T10:00:00Z" }));
    await writeFile(path.join(sessionDirectory, `rollout-${sessionId}.jsonl`), [
      JSON.stringify({ type: "response_item", timestamp: "2026-08-30T10:00:00Z", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "npm test" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-30T10:00:01Z", payload: { type: "item_completed", item: { type: "CommandExecution", id: "exec-1", command: "npm test", status: "completed", aggregated_output: "42 passed", exit_code: 0 } } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-08-30T10:00:02Z", payload: { type: "custom_tool_call_output", call_id: "call-1", output: [{ type: "input_text", text: "Script completed" }] } })
    ].join("\n"));
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([{ id: "call-1", kind: "command", status: "completed", output: "42 passed", result: "Script completed" }]);
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toHaveLength(1);
  });

  it("keeps an incomplete trailing JSONL tool record until it is finished", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-partial-call-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Partial", updated_at: "2026-08-30T10:00:00Z" }));
    const transcript = path.join(sessionDirectory, `rollout-${sessionId}.jsonl`);
    const record = JSON.stringify({ type: "response_item", timestamp: "2026-08-30T10:00:00Z", payload: { type: "custom_tool_call", call_id: "partial-1", name: "exec", input: "npm test" } });
    await writeFile(transcript, record.slice(0, -1));
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toEqual([]);
    await writeFile(transcript, "}", { flag: "a" });
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([{ id: "partial-1", status: "inProgress" }]);
  });

  it("reads event user messages with attached images", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-user-image-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Image prompt", updated_at: "2026-08-30T10:00:00Z" }));
    await writeFile(path.join(sessionDirectory, `rollout-${sessionId}.jsonl`), JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-30T10:00:00Z",
      payload: { type: "item_completed", item: { type: "UserMessage", id: "user-image", content: [{ type: "text", text: "Review this" }, { type: "image", image_url: "data:image/png;base64,AA==" }] } }
    }));
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([{ id: "user-image", role: "user", text: "Review this", images: [{ src: "data:image/png;base64,AA==" }] }]);
  });

  it("deduplicates mirrored item messages and hides injected session context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-message-dedupe-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Dedupe", updated_at: "2026-08-30T10:00:00Z" }));
    await writeFile(path.join(sessionDirectory, `rollout-${sessionId}.jsonl`), [
      JSON.stringify({ type: "response_item", timestamp: "2026-08-30T10:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>internal</recommended_plugins>" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-08-30T10:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review this" }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-30T10:00:01Z", payload: { type: "item_completed", item: { type: "UserMessage", id: "user-rich", content: [{ type: "text", text: "Review this" }, { type: "image", image_url: "data:image/png;base64,AA==" }] } } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-30T10:00:02Z", payload: { type: "item_completed", item: { type: "AgentMessage", id: "agent-event", content: [{ type: "Text", text: "Done" }] } } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-08-30T10:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } })
    ].join("\n"));
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([
      { role: "user", text: "Review this", images: [{ src: "data:image/png;base64,AA==" }] },
      { role: "assistant", text: "Done" }
    ]);
  });

  it("does not report a stopped session as running from a stale writer lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-stale-lock-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Stopped", updated_at: "2026-08-30T10:00:00Z" }));
    const transcript = path.join(sessionDirectory, `rollout-${sessionId}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { cwd: "D:/repo" } }));
    const lock = path.join(root, "thread-writer-locks", `${sessionId}.lock`);
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, "");
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lock, stale, stale);
    await utimes(transcript, stale, stale);
    await expect(readCodexCliSessionSummary(sessionId, root)).resolves.toMatchObject({ id: sessionId, status: "idle", locked: false });
  });

  it("does not report a recently locked session as running after a terminal transcript event", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-terminal-lock-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Completed", updated_at: new Date().toISOString() }));
    const transcript = path.join(sessionDirectory, `rollout-${sessionId}.jsonl`);
    await writeFile(transcript, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
    ].join("\n"));
    await mkdir(path.join(root, "thread-writer-locks"), { recursive: true });
    await writeFile(path.join(root, "thread-writer-locks", `${sessionId}.lock`), "");
    await expect(readCodexCliSessionSummary(sessionId, root)).resolves.toMatchObject({ status: "idle", locked: false });
    await expect(readRunningCodexSessionIds(root)).resolves.toEqual([]);
  });

  it("reads only appended transcript data after the first message load", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-incremental-transcript-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({
      id: sessionId,
      thread_name: "Incremental",
      updated_at: "2026-08-30T10:00:00Z"
    }));
    const transcript = path.join(sessionDirectory, `rollout-${sessionId}.jsonl`);
    await writeFile(transcript, JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-30T10:00:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "First" }] }
    }));
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([{ role: "user", text: "First" }]);
    await writeFile(transcript, "\n" + JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-30T10:00:01Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Second" }] }
    }), { flag: "a" });
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([
      { role: "user", text: "First" },
      { role: "assistant", text: "Second" }
    ]);
  });
  it("hydrates ImageView file URLs into renderable image data for the dashboard", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-image-view-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    const imagePath = path.join(root, "menu.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Image", updated_at: "2026-08-30T10:00:00Z" }));
    await writeFile(path.join(sessionDirectory, `rollout-${sessionId}.jsonl`), JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-30T10:00:00Z",
      payload: { type: "item_completed", item: { type: "ImageView", id: "image-local", path: `file://${imagePath.replace(/\\/g, "/")}` } }
    }));
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([{
      id: "image-local",
      kind: "image",
      text: "menu.png",
      images: [{ src: expect.stringMatching(/^data:image\/png;base64,/) }]
    }]);
  });

  it("keeps Workspace viewing process-free and leaves writer locks unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-read-only-view-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    const lockDirectory = path.join(root, "thread-writer-locks");
    await mkdir(sessionDirectory, { recursive: true });
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({
      id: sessionId,
      thread_name: "Read only",
      updated_at: "2026-08-30T10:00:00Z"
    }));
    await writeFile(path.join(sessionDirectory, `rollout-${sessionId}.jsonl`), JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-30T10:00:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Safe view" }] }
    }));
    const lockPath = path.join(lockDirectory, `${sessionId}.lock`);
    await writeFile(lockPath, "owner-state");
    const marker = path.join(root, "codex-spawned.txt");
    const script = path.join(root, "codex.js");
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.exit(1);`, "utf8");
    const previousHome = process.env["CODEX_HOME"];
    const previousCliPath = process.env["CODEX_CLI_PATH"];
    process.env["CODEX_HOME"] = root;
    process.env["CODEX_CLI_PATH"] = script;
    const locksBefore = await readdir(lockDirectory);
    try {
      await expect(readCodexCliSessionMessages(sessionId)).resolves.toMatchObject([
        { role: "user", text: "Safe view" }
      ]);
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(lockPath, "utf8")).resolves.toBe("owner-state");
      await expect(readdir(lockDirectory)).resolves.toEqual(locksBefore);
    } finally {
      if (previousHome === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = previousHome;
      if (previousCliPath === undefined) delete process.env["CODEX_CLI_PATH"];
      else process.env["CODEX_CLI_PATH"] = previousCliPath;
    }
  });

  it("waits for an active transcript's partial JSON line to become complete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-partial-transcript-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    const transcript = path.join(sessionDirectory, `rollout-${sessionId}.jsonl`);
    const record = JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-30T10:00:00Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Now complete" }] }
    });
    const splitAt = Math.floor(record.length / 2);
    await writeFile(transcript, record.slice(0, splitAt));

    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toEqual([]);
    await writeFile(transcript, record.slice(splitAt), { flag: "a" });
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([
      { role: "assistant", text: "Now complete" }
    ]);
  });

  it("reads an active transcript from memory without blocking its writer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-shared-read-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    const transcript = path.join(sessionDirectory, `rollout-${sessionId}.jsonl`);
    const record = JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-30T10:00:00Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Writer stayed live" }] }
    });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Shared read" }));
    const writer = await open(transcript, "a");
    try {
      await writer.write(record.slice(0, Math.floor(record.length / 2)));
      await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toEqual([]);
      await writer.write(record.slice(Math.floor(record.length / 2)) + "\n");
      await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([
        { role: "assistant", text: "Writer stayed live" }
      ]);
    } finally {
      await writer.close();
    }
    await expect(readFile(transcript, "utf8")).resolves.toBe(record + "\n");
  });

  it("reads a bounded tail from transcripts larger than the viewer window", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-large-transcript-"));
    roots.push(root);
    const sessionDirectory = path.join(root, "sessions", "2026", "08", "30");
    await mkdir(sessionDirectory, { recursive: true });
    const transcript = path.join(sessionDirectory, `rollout-${sessionId}.jsonl`);
    await writeFile(transcript, "");
    await truncate(transcript, 26 * 1024 * 1024);
    await writeFile(transcript, "\n" + JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-30T10:00:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Latest large-session message" }] }
    }), { flag: "a" });

    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([
      { role: "user", text: "Latest large-session message" }
    ]);
  });

  it("detects sessions archived into nested Codex archive folders", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-nested-archive-"));
    roots.push(root);
    await mkdir(path.join(root, "archived_sessions", "2026", "08", "30"), { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Nested archive", updated_at: "2026-08-30T10:00:00Z" }));
    await writeFile(path.join(root, "archived_sessions", "2026", "08", "30", `rollout-${sessionId}.jsonl`), "");

    await expect(readCodexCliSessions(root)).resolves.toMatchObject([{ id: sessionId, archived: true }]);
  });

  it("recovers a persisted project folder from alternate session metadata keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-project-metadata-"));
    roots.push(root);
    await mkdir(path.join(root, "sessions", "2026", "08", "28"), { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({
      id: sessionId,
      thread_name: "Project metadata",
      updated_at: "2026-08-28T20:50:00Z"
    }));
    await writeFile(
      path.join(root, "sessions", "2026", "08", "28", `rollout-${sessionId}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: { project_path: "D:/persisted-project" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] } })
      ].join("\n")
    );

    await expect(readCodexCliSessionSummary(sessionId, root)).resolves.toMatchObject({
      id: sessionId,
      projectPath: "D:/persisted-project"
    });
  });

  it("keeps an archived project's session out of Recent when its first metadata line is oversized", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-large-metadata-"));
    roots.push(root);
    await mkdir(path.join(root, "archived_sessions"), { recursive: true });
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({
      id: sessionId,
      thread_name: "Large project metadata",
      updated_at: "2026-08-28T20:50:00Z"
    }));
    await writeFile(
      path.join(root, "archived_sessions", `rollout-${sessionId}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { cwd: "D:/persisted-project", instructions: "x".repeat(70_000) } })
    );

    await expect(readCodexCliSessionSummary(sessionId, root)).resolves.toMatchObject({
      id: sessionId,
      archived: true,
      projectPath: "D:/persisted-project"
    });
  });

  it("rejects unsafe session identifiers", async () => {
    await expect(readCodexCliSessionMessages("../../auth.json", os.tmpdir())).rejects.toThrow("invalid");
  });

  it("separates archived sessions and still exposes their readable transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-archived-"));
    roots.push(root);
    await mkdir(path.join(root, "archived_sessions"), { recursive: true });
    await writeFile(
      path.join(root, "session_index.jsonl"),
      JSON.stringify({ id: sessionId, thread_name: "Archived demo", updated_at: "2026-08-28T20:50:00Z" })
    );
    await writeFile(
      path.join(root, "archived_sessions", `rollout-${sessionId}.jsonl`),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-28T20:50:01Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Archived hello" }] }
      })
    );

    await expect(readCodexCliSessions(root)).resolves.toMatchObject([
      { id: sessionId, title: "Archived demo", status: "idle", archived: true }
    ]);
    await expect(readCodexCliSessionMessages(sessionId, root)).resolves.toMatchObject([
      { role: "user", text: "Archived hello" }
    ]);
  });

  it("applies the visible limit independently to Active and Archived", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-sections-"));
    roots.push(root);
    await mkdir(path.join(root, "archived_sessions"), { recursive: true });
    const entries = [
      { id: "01a04882-d037-7a42-ad24-9afb61901181", thread_name: "Active newest", updated_at: "2026-08-28T20:54:00Z" },
      { id: "01a04882-d037-7a42-ad24-9afb61901182", thread_name: "Archived newest", updated_at: "2026-08-28T20:53:00Z" },
      { id: "01a04882-d037-7a42-ad24-9afb61901183", thread_name: "Active older", updated_at: "2026-08-28T20:52:00Z" },
      { id: "01a04882-d037-7a42-ad24-9afb61901184", thread_name: "Archived older", updated_at: "2026-08-28T20:51:00Z" }
    ];
    await writeFile(path.join(root, "session_index.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
    await writeFile(path.join(root, "archived_sessions", `rollout-${entries[1].id}.jsonl`), "");
    await writeFile(path.join(root, "archived_sessions", `rollout-${entries[3].id}.jsonl`), "");
    await mkdir(path.join(root, "sessions"));
    for (const entry of [entries[0], entries[2]]) await writeFile(path.join(root, "sessions", `rollout-${entry.id}.jsonl`), "");

    const sessions = await readCodexCliSessions(root, 1);

    expect(sessions.map((session) => [session.title, session.archived])).toEqual([
      ["Active newest", false],
      ["Archived newest", true]
    ]);
  });

  it("resolves an older direct-linked session outside the visible list limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-direct-link-"));
    roots.push(root);
    const olderId = "01a04882-d037-7a42-ad24-9afb61901189";
    await mkdir(path.join(root, "sessions"));
    for (const id of [sessionId, olderId]) await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), "");
    await writeFile(path.join(root, "session_index.jsonl"), [
      JSON.stringify({ id: sessionId, thread_name: "Newest", updated_at: "2026-08-29T03:00:00Z" }),
      JSON.stringify({ id: olderId, thread_name: "Older direct link", updated_at: "2026-08-28T03:00:00Z" })
    ].join("\n"));

    await expect(readCodexCliSessions(root, 1)).resolves.toHaveLength(1);
    await expect(readCodexCliSessionSummary(olderId, root)).resolves.toMatchObject({
      id: olderId,
      title: "Older direct link",
      archived: false
    });
  });

  it("loads visible CLI models and composer defaults from the local Codex configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-config-"));
    roots.push(root);
    await writeFile(
      path.join(root, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-demo",
            display_name: "GPT Demo",
            description: "Demo model",
            visibility: "list",
            default_reasoning_level: "medium",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }]
          },
          // Routers can return the same ID from static and live sources.
          { id: "gpt-demo", display_name: "Duplicate GPT Demo", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] },
          { slug: "hidden-model", display_name: "Hidden", visibility: "hide" }
        ]
      })
    );
    await writeFile(
      path.join(root, "config.toml"),
      'model = "gpt-demo"\nmodel_reasoning_effort = "medium"\nsandbox_mode = "read-only"\n'
    );

    await expect(readCodexCliComposerConfig(root)).resolves.toEqual({
      models: [{
        id: "gpt-demo",
        label: "GPT Demo",
        description: "Demo model",
        defaultReasoningEffort: "medium",
        reasoningEfforts: ["low", "medium"]
      }],
      defaultModel: "gpt-demo",
      defaultReasoningEffort: "medium",
      defaultSandboxMode: "read-only"
    });
  });

  it("accepts provider-qualified OpenAI-style model catalogs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-model-catalog-"));
    roots.push(root);
    await writeFile(path.join(root, "models_cache.json"), JSON.stringify({
      data: [
        {
          id: "cx/gpt-5.2-codex",
          displayName: "GPT-5.2 Codex",
          description: "9router Codex model",
          hidden: false,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }]
        },
        { id: "cx/hidden", hidden: true }
      ]
    }), "utf8");

    await expect(readCodexCliComposerConfig(root)).resolves.toMatchObject({
      models: [{
        id: "cx/gpt-5.2-codex",
        label: "GPT-5.2 Codex",
        defaultReasoningEffort: "high",
        reasoningEfforts: ["medium", "high"]
      }],
      defaultModel: "cx/gpt-5.2-codex"
    });
  });

  it("requires active transcript evidence for recent locks without applying the dashboard display limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cli-running-sessions-"));
    roots.push(root);
    const secondId = "01a04882-d037-7a42-ad24-9afb61901189";
    const lockDirectory = path.join(root, "thread-writer-locks");
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, `${sessionId}.lock`), "");
    await writeFile(path.join(lockDirectory, `${secondId}.lock`), "");
    await writeFile(path.join(lockDirectory, "not-a-session.lock"), "");
    await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", `rollout-${sessionId}.jsonl`), JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));

    await expect(readRunningCodexSessionIds(root)).resolves.toEqual([sessionId]);
  });
});

it('reads a missing recorded project for Environment without weakening command ownership or availability checks', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-missing-recorded-')); roots.push(root);
  const previous=process.env['CODEX_HOME'];process.env['CODEX_HOME']=root;
  try {
    await mkdir(path.join(root,'sessions'));
    const missing=path.join(root,'removed');
    await writeFile(path.join(root,'sessions',`rollout-${sessionId}.jsonl`), JSON.stringify({type:'session_meta',payload:{cwd:missing}})+'\n');
    expect(await resolveRecordedSessionProject(sessionId,undefined,false)).toBe(missing);
    await expect(resolveRecordedSessionProject(sessionId)).rejects.toThrow(/folder is unavailable/);
    await expect(resolveRecordedSessionProject(sessionId,path.join(root,'different'),false)).rejects.toThrow(/different project/);
  } finally { if(previous===undefined)delete process.env['CODEX_HOME'];else process.env['CODEX_HOME']=previous; }
});
