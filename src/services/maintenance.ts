import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CODEX_INSPECTIONS, MAINTENANCE_TOOLS, type CodexInspection, type MaintenanceJob, type MaintenancePreview, type MaintenancePage, type MaintenanceTool, type MaintenanceReport, type MaintenanceStorageSummary } from "../domain/maintenance";
import { getCodexHomeStateKey } from "../codex/authFile";
import { readCodexSessionGoals } from "./codexSessionGoals";
import { clearCodexSessionGoal, deleteCodexCliSession, unarchiveCodexCliSession, readCodexCliSessionSummary, readCodexArchiveMaintenanceState, readCodexSessionMaintenanceCandidates, resolveCodexHome, SESSION_ID_PATTERN, withCodexSessionMaintenance } from "./codexSessionResume";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { runWithConcurrencyLimit, waitWithin } from "../utils/concurrency";
import { recordPersistentEvent } from "../utils/persistentLog";
import { normalizeNativePath } from "../utils/nativePaths";
import { publishDashboardRealtime } from './dashboardRealtime';
import { inspectCodexUi } from "./codexUiRecovery";

type Item = { id: string; sessionId?: string; title: string; projectPath?: string; detail?: string; goalOnly?: boolean; snapshot?: { file: string; size: number; mtimeMs: number } };
type Plan = { preview: MaintenancePreview; home: string; items: Item[]; job?: string; jobRequest?: string };
const plans = new Map<string, Plan>();
const jobs = new Map<string, { state: MaintenanceJob; controller: AbortController; home: string; updatedAt: number }>();
const preparing = new Map<string, Promise<MaintenancePreview>>();

export async function inspectMaintenanceStorage(value: unknown = "storage"): Promise<MaintenanceReport> {
  if (!CODEX_INSPECTIONS.some(tool => tool.id === value)) throw new Error("Choose a Codex inspection tool.");
  if (value === "startup") return waitWithin(inspectCodexUi(), 15_000, "Codex UI inspection did not finish. No data was changed; retry after this PC responds.");
  return waitWithin(inspectCodexStorage(value as CodexInspection), 15_000, "Codex storage did not respond. No data was changed; retry when it is available.");
}

async function inspectCodexStorage(kind: CodexInspection): Promise<MaintenanceReport> {
  const home = resolveCodexHome();
  let sessions: Awaited<ReturnType<typeof readCodexSessionMaintenanceCandidates>> = [], inventoryUnavailable = false;
  try { sessions = await readCodexSessionMaintenanceCandidates(home); }
  catch (error) {
    if (kind !== "storage") throw new Error("Codex history could not be read. Run Check Codex storage before retrying; no data was changed.", { cause: error });
    inventoryUnavailable = true;
  }
  const items: MaintenanceReport["items"] = [];
  if (kind === "projects") {
    const projects = new Map<string, number>();
    for (const session of sessions) if (session.projectPath) projects.set(session.projectPath, (projects.get(session.projectPath) ?? 0) + 1);
    let missing = 0, unavailable = 0;
    await runWithConcurrencyLimit([...projects], 8, async ([folder, count]) => {
      if (!path.isAbsolute(folder)) { unavailable++; if (items.length < 50) items.push({ label: folder, value: `${count} chats · Invalid project path` }); return; }
      try {
        if (!(await fs.stat(folder)).isDirectory()) { missing++; if (items.length < 50) items.push({ label: folder, value: `${count} chats · Not a folder` }); }
      } catch (error) {
        const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
        if (absent) missing++; else unavailable++;
        if (items.length < 50) items.push({ label: folder, value: `${count} chats · ${absent ? "Missing" : "Unavailable"}` });
      }
    });
    items.unshift({ label: "Recorded projects checked", value: String(projects.size) }, { label: "Missing projects", value: String(missing) }, { label: "Unavailable projects", value: String(unavailable) }, { label: "Chats without a recorded project", value: String(sessions.filter(session => !session.projectPath).length) });
    return { title: "Project folder check", items };
  }
  if (kind === "large-sessions") {
    const sizes: Array<{ title: string; size: number }> = [];
    let unavailable = 0;
    const root = normalizeNativePath(await fs.realpath(home));
    await runWithConcurrencyLimit(sessions, 8, async session => {
      if (!session.transcriptPath) { unavailable++; return; }
      try {
        const file = normalizeNativePath(await fs.realpath(session.transcriptPath)), relative = path.relative(root, file);
        if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) { unavailable++; return; }
        const stat = await fs.stat(file);
        if (stat.isFile()) sizes.push({ title: session.title, size: stat.size }); else unavailable++;
      } catch { unavailable++; }
    });
    sizes.sort((a, b) => b.size - a.size);
    return { title: "Largest conversations", items: [{ label: "Conversation files checked", value: String(sizes.length) }, { label: "Unavailable files", value: String(unavailable) }, ...sizes.slice(0, 20).map(item => ({ label: item.title, value: formatBytes(item.size) }))] };
  }
  const files = (await fs.readdir(home)).filter(name => /^(?:state|goals|thread_history|logs)_\d+\.sqlite$/.test(name)).sort();
  const moduleName = "node:sqlite";
  type NativeDatabase = { prepare(sql: string): { get(): Record<string, unknown> | undefined }; close(): void };
  const { DatabaseSync } = await import(moduleName) as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => NativeDatabase };
  let totalBytes = 0;
  for (const file of files) {
    const stat = await fs.lstat(path.join(home, file));
    totalBytes += stat.size;
    if (!stat.isFile() || stat.isSymbolicLink()) { items.push({ label: file, value: "Skipped: not a regular database" }); continue; }
    let db: NativeDatabase | undefined;
    try {
      db = new DatabaseSync(path.join(home, file), { readOnly: true });
      const check = db.prepare("PRAGMA quick_check(1)").get()?.["quick_check"];
      items.push({ label: file, value: `${check === "ok" ? "Healthy" : "Needs recovery"} · ${formatBytes(stat.size)}` });
    } catch { items.push({ label: file, value: "Unavailable · No changes made" }); }
    finally { db?.close(); }
  }
  const reportItems = [...(inventoryUnavailable ? [{ label: "Conversation inventory", value: "Unavailable · Review database checks" }] : [{ label: "Indexed conversations", value: String(sessions.length) }, { label: "Indexed archives", value: String(sessions.filter(session => session.archived).length) }]), ...(files.length ? [{ label: "Native database files", value: `${files.length} · ${formatBytes(totalBytes)} total` }] : []), ...items, ...(!files.length ? [{ label: "Native databases", value: "Not created yet" }] : [])];
  return { title: "Codex storage check", items: reportItems, storage: await summarizeCodexStorage(home, sessions, totalBytes) };
}

function formatBytes(size: number): string {
  const unit = size >= 1024 ** 3 ? 3 : size >= 1024 ** 2 ? 2 : size >= 1024 ? 1 : 0;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(size / 1024 ** unit)} ${["B", "KB", "MB", "GB"][unit]}`;
}

async function summarizeCodexStorage(home: string, sessions: Awaited<ReturnType<typeof readCodexSessionMaintenanceCandidates>>, databaseBytes: number): Promise<MaintenanceStorageSummary> {
  const root = path.resolve(home), buckets = new Map<string, number>(), projects = new Map<string, number>(), seen = new Set<string>();
  const add = async (file: string | undefined, bucket: string, project?: string): Promise<void> => {
    if (!file) return;
    try {
      const resolved = await fs.realpath(file), relative = path.relative(root, resolved);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || seen.has(resolved)) return;
      const stat = await fs.lstat(resolved);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      seen.add(resolved);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + stat.size);
      if (project) projects.set(project, (projects.get(project) ?? 0) + stat.size);
    } catch { /* Missing or locked files do not hide the rest of the summary. */ }
  };
  buckets.set("Databases", databaseBytes);
  for (const session of sessions) await add(session.transcriptPath, session.archived ? "Archives" : "Conversations", session.projectPath);
  try {
    for (const name of await fs.readdir(path.join(home, "shell_snapshots"))) await add(path.join(home, "shell_snapshots", name), "Shell snapshots");
  } catch { /* Missing snapshots are normal. */ }
  const bucketRows = [...buckets.entries()].filter(([, bytes]) => bytes > 0).sort((a, b) => b[1] - a[1]);
  const projectRows = [...projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const totalBytes = bucketRows.reduce((total, [, bytes]) => total + bytes, 0);
  return { totalBytes, buckets: bucketRows.map(([label, bytes]) => ({ label, bytes, detail: formatBytes(bytes) })), projects: projectRows.map(([label, bytes]) => ({ label, bytes, detail: formatBytes(bytes) })) };
}

async function shellSnapshots(home: string): Promise<Item[]> {
  const directory = path.join(home, "shell_snapshots");
  let entries: string[];
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Shell snapshots are linked outside Codex storage. No cleanup started.");
    entries = await fs.readdir(directory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (entries.length > 10000) throw new Error("The snapshot folder is too large for one cleanup. No files were changed.");
  const result: Item[] = [];
  await runWithConcurrencyLimit(entries, 8, async name => {
    const sourceId = name.replace(/\.(?:sh|ps1)$/, ""), id = sourceId.toLowerCase();
    if (!SESSION_ID_PATTERN.test(id) || name === sourceId) return;
    const file = path.join(directory, name), stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs >= Date.now() - 7 * 86_400_000) return;
    result.push({ id: name, sessionId: id, title: `Shell snapshot · ${new Date(stat.mtimeMs).toLocaleDateString()}`, detail: `${formatBytes(stat.size)} · ${name}`, snapshot: { file, size: stat.size, mtimeMs: stat.mtimeMs } });
  });
  return result;
}

function prune(): void {
  for (const [id, job] of jobs) if (job.state.status !== "running" && Date.now() - job.updatedAt > 30 * 60_000) jobs.delete(id);
  for (const [token, plan] of plans) if (plan.preview.expiresAt < Date.now() && (!plan.job || jobs.get(plan.job)?.state.status !== "running")) plans.delete(token);
}

export function previewMaintenance(value: unknown): Promise<MaintenancePreview> {
  if (!MAINTENANCE_TOOLS.some(tool => tool.id === value)) return Promise.reject(new Error("Choose a maintenance tool."));
  const home = resolveCodexHome(), key = `${getCodexHomeStateKey(home)}:${String(value)}`;
  const pending = preparing.get(key);
  if (pending) return pending;
  if (preparing.size >= 4) return Promise.reject(new Error("Other Codex tools are still reading storage. Retry when they finish."));
  const task = createMaintenancePreview(value as MaintenanceTool, home).finally(() => { if (preparing.get(key) === task) preparing.delete(key); });
  preparing.set(key, task);
  return task;
}

async function createMaintenancePreview(tool: MaintenanceTool, home: string): Promise<MaintenancePreview> {
  prune();
  for (const [token, plan] of plans) if (!plan.job && plan.home === getCodexHomeStateKey(home) && plan.preview.tool === tool) plans.delete(token);
  if (plans.size >= 8) throw new Error("Too many cleanup previews are open. Finish one or retry in a few minutes.");
  let items: Item[] = [];
  if (tool === "snapshots") items = await waitWithin(shellSnapshots(home), 8_000, "Shell snapshots did not respond. No cleanup started.");
  else {
    const [sessions, goals, files] = await waitWithin(Promise.all([
      readCodexSessionMaintenanceCandidates(home), tool === "archives" ? undefined : readCodexSessionGoals(home, undefined, 10001), tool === "archives" ? [] : fs.readdir(home)
    ]), 15_000, "Session storage did not respond. No cleanup started; retry when it is available.");
    if (!goals && files.some(name => /^goals_\d+\.sqlite$/.test(name))) throw new Error("Goal storage is unavailable. No cleanup started.");
    if ((goals?.size ?? 0) > 10000) throw new Error("More than 10,000 goals need cleanup. Reduce them in Codex before retrying.");
    const titles = new Map(sessions.map(session => [session.id, session.title]));
    if (tool === "goals") items = [...goals?.keys() ?? []].map(id => ({ id, title: titles.get(id) ?? `Codex session ${id.slice(0, 8)}`, detail: goals?.get(id)?.objective.slice(0, 256), goalOnly: true }));
    else {
      items = sessions.filter(session => tool !== "archives" || session.archived).map(session => ({ id: session.id, title: session.title, projectPath: session.projectPath,
        detail: [session.projectPath ? path.basename(session.projectPath) || session.projectPath : "Project unavailable", session.model, session.updatedAt ? new Date(session.updatedAt).toLocaleDateString() : undefined, tool === "sessions" && session.archived ? "Archived" : undefined].filter(Boolean).join(" · ") }));
      if (tool === "sessions") {
        const listed = new Set(items.map(item => item.id));
        for (const id of goals?.keys() ?? []) if (!listed.has(id)) items.push({ id, title: `Codex session ${id.slice(0, 8)}`, detail: "Saved goal · Conversation unavailable", goalOnly: true });
      }
    }
  }
  if (items.length > 10000) throw new Error("More than 10,000 items need cleanup. Use a narrower tool before retrying.");
  if (plans.size >= 8) throw new Error("Too many cleanup previews are open. Finish one or retry in a few minutes.");
  const preview: MaintenancePreview = { token: randomUUID(), tool, count: items.length, expiresAt: Date.now() + 5 * 60_000, titles: items.slice(0, 5).map(item => item.title) };
  plans.set(preview.token, { preview, home: getCodexHomeStateKey(home), items });
  return preview;
}

export function readMaintenancePage(token: string, query = "", offset = 0): MaintenancePage {
  const plan = plans.get(token);
  if (!plan || plan.home !== getCodexHomeStateKey(resolveCodexHome()) || plan.preview.expiresAt < Date.now()) throw new Error("This preview expired. Refresh this tool to review current data.");
  if (typeof query !== "string" || query.length > 256 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error("The tool search or page is invalid.");
  const search = query.trim().toLocaleLowerCase();
  const items = plan.items.filter(item => !search || `${item.title} ${item.detail ?? ""} ${item.projectPath ?? ""}`.toLocaleLowerCase().includes(search));
  return { token, query, offset, total: items.length, items: items.slice(offset, offset + 50).map(item => ({ id: item.id, title: item.title, detail: item.detail ?? (item.projectPath ? path.basename(item.projectPath) : undefined) })) };
}

export function getMaintenanceJob(id: string, cancel = false, previewToken?: string): MaintenanceJob {
  if (!id && !cancel && previewToken) {
    const plan = plans.get(previewToken);
    if (!plan || plan.home !== getCodexHomeStateKey(resolveCodexHome())) throw new Error('This cleanup is no longer available in this window. Review current data before starting a new preview.');
    if (!plan.job) throw new Error('No operation is recorded for this preview. Review current data before retrying.');
    id = plan.job;
  }
  const job = jobs.get(id);
  if (!job || job.home !== getCodexHomeStateKey(resolveCodexHome())) throw new Error("This cleanup is no longer available in this window. Review current data before starting a new preview.");
  if (cancel && job.state.status === "running" && !job.state.cancelRequested) {
    job.controller.abort(); job.state.cancelRequested = true;
    job.state.revision = (job.state.revision ?? 0) + 1;
    publishDashboardRealtime({ type: 'dashboard:maintenance-progress', job: { ...job.state, errors: [...job.state.errors] } });
  }
  return { ...job.state, errors: [...job.state.errors] };
}

export function runMaintenance(token: string, confirmed: boolean, selection?: string[], operation: "delete" | "restore" = "delete"): MaintenanceJob {
  prune();
  const plan = plans.get(token);
  if (!confirmed || !plan || plan.home !== getCodexHomeStateKey(resolveCodexHome())) throw new Error("Review and confirm a cleanup preview for this system first.");
  if (operation !== "delete" && operation !== "restore" || operation === "restore" && plan.preview.tool !== "archives") throw new Error("This operation is unavailable for this tool.");
  const available = new Set(plan.items.map(item => item.id));
  if (selection !== undefined && (!Array.isArray(selection) || !selection.length || selection.length > 10000 || selection.some(id => typeof id !== "string" || !available.has(id)))) throw new Error("Choose items from this preview before continuing.");
  const ids = selection ? new Set(selection) : undefined;
  const fingerprint = JSON.stringify([operation, ids ? [...ids].sort() : "all"]);
  if (plan.job) {
    const existing = getMaintenanceJob(plan.job);
    if (plan.jobRequest !== fingerprint) throw new Error("This preview already started another operation. Refresh after checking its result.");
    return existing;
  }
  if (plan.preview.expiresAt < Date.now()) throw new Error("This cleanup preview expired. Review the current data before retrying.");
  if ([...jobs.values()].some(job => job.home === plan.home && job.state.status === "running")) throw new Error("Another cleanup is still running. Wait for its result or cancel it first.");
  if (jobs.size >= 8) {
    const finished = [...jobs].find(([, job]) => job.state.status !== "running");
    if (finished) jobs.delete(finished[0]);
    else throw new Error("The cleanup queue is full. Wait for a running cleanup before retrying.");
  }
  const id = randomUUID();
  const items = ids ? plan.items.filter(item => ids.has(item.id)) : plan.items;
  const state: MaintenanceJob = { id, previewToken: token, revision: 0, tool: plan.preview.tool, operation, status: "running", total: items.length, processed: 0, cleared: 0, skipped: 0, failed: 0, errors: [] };
  const controller = new AbortController(), job = { state, controller, home: plan.home, updatedAt: Date.now() };
  jobs.set(id, job); plan.job = id; plan.jobRequest = fingerprint;
  let reported = -1;
  const progress = (force = false) => {
    state.revision = (state.revision ?? 0) + 1;
    // Report at most one hundred progress milestones, plus lifecycle changes.
    if (!force && state.processed - reported < Math.max(1, Math.ceil(state.total / 100))) return;
    reported = state.processed;
    publishDashboardRealtime({ type: 'dashboard:maintenance-progress', job: { ...state, errors: [...state.errors] } });
  };
  progress(true);
  const timer = setTimeout(() => {
    state.cancelRequested = true;
    if (state.errors.length < 20) state.errors.push("Cleanup reached its 30 minute limit. Current operations may still finish; remaining items are kept.");
    controller.abort(new Error("Cleanup reached its time limit."));
    progress(true);
  }, 30 * 60_000);
  timer.unref?.();
  void runCrossWindowExclusive(`maintenance:${plan.home}`, "System maintenance", async leaseSignal => {
    const check = () => {
      leaseSignal.throwIfAborted(); controller.signal.throwIfAborted();
      if (getCodexHomeStateKey(resolveCodexHome()) !== plan.home) {
        controller.abort(new Error("The Codex home changed. Remaining data was kept."));
        controller.signal.throwIfAborted();
      }
    };
    check();
    const currentSessions = operation === "delete" && ["archives", "sessions"].includes(plan.preview.tool) ? await readCodexSessionMaintenanceCandidates() : [];
    const children = new Map<string, string[]>();
    for (const session of currentSessions) if (session.parentSessionId) children.set(session.parentSessionId, [...children.get(session.parentSessionId) ?? [], session.id]);
    const selected = new Set(items.map(item => item.id));
    const parents = new Map(currentSessions.map(session => [session.id, session.parentSessionId]));
    const depth = (id: string) => {
      const visited = new Set<string>();
      let parent = parents.get(id);
      while (parent && !visited.has(parent)) { visited.add(parent); parent = parents.get(parent); }
      return visited.size;
    };
    // Native parent deletion cascades; finish selected children before deleting their parent.
    const ordered = currentSessions.length ? [...items].sort((a, b) => depth(b.id) - depth(a.id)) : items;
    await withCodexSessionMaintenance(items.map(item => item.sessionId ?? item.id), () => runWithConcurrencyLimit(ordered, currentSessions.length ? 1 : 3, async item => {
      if (controller.signal.aborted) return;
      try {
        check();
        const current = await waitWithin<{ status: string; archived?: boolean } | undefined>(plan.preview.tool === "archives" ? readCodexArchiveMaintenanceState(item.id) : readCodexCliSessionSummary(item.sessionId ?? item.id), plan.preview.tool === "archives" ? 20_000 : 6_000, "Running state is unavailable; this item was kept.");
        check();
        if (!current && !item.snapshot && !item.goalOnly) { state.skipped++; return; }
        if (current?.status === "running") { state.skipped++; return; }
        if (current?.status === "unknown") throw new Error("Running state is unavailable; this item was kept.");
        if (plan.preview.tool === "archives" && !current?.archived) { state.skipped++; return; }
        if (operation === "restore") { await unarchiveCodexCliSession(item.id); state.cleared++; return; }
        if (item.snapshot) {
          const stat = await fs.lstat(item.snapshot.file), directory = await fs.lstat(path.dirname(item.snapshot.file));
          if (!directory.isDirectory() || directory.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size !== item.snapshot.size || stat.mtimeMs !== item.snapshot.mtimeMs) { state.skipped++; return; }
          check(); await fs.unlink(item.snapshot.file); state.cleared++; return;
        }
        const visited = new Set<string>(), descendants = [...children.get(item.id) ?? []];
        while (descendants.length) {
          const child = descendants.pop()!;
          if (visited.has(child)) continue;
          visited.add(child); descendants.push(...children.get(child) ?? []);
          if (!selected.has(child)) { state.skipped++; if (state.errors.length < 20) state.errors.push(`${item.title}: kept because a child conversation is outside this selection.`.slice(0, 300)); return; }
          const summary = await waitWithin<{ status: string; archived?: boolean } | undefined>(plan.preview.tool === "archives" ? readCodexArchiveMaintenanceState(child) : readCodexCliSessionSummary(child), plan.preview.tool === "archives" ? 20_000 : 6_000, "A child conversation could not be verified; this conversation was kept.");
          if (summary && (summary.status !== "idle" || (plan.preview.tool === "archives" && !summary.archived))) { state.skipped++; if (state.errors.length < 20) state.errors.push(`${item.title}: kept because a child conversation is running, unavailable, or no longer archived.`.slice(0, 300)); return; }
        }
        if (item.goalOnly) await clearCodexSessionGoal(item.id);
        if (!item.goalOnly) { check(); await deleteCodexCliSession(item.id, { archivedOnly: plan.preview.tool === "archives" }); }
        state.cleared++;
      } catch (error) {
        if (controller.signal.aborted || leaseSignal.aborted) { state.skipped++; return; }
        if (item.snapshot && (error as NodeJS.ErrnoException).code === "ENOENT") { state.skipped++; return; }
        state.failed++;
        if (state.errors.length < 20) state.errors.push(`${item.title}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      } finally { state.processed++; job.updatedAt = Date.now(); progress(); }
    }));
  }).then(() => {
    state.status = controller.signal.aborted ? "cancelled" : state.failed ? "failed" : "completed";
  }).catch(error => {
    state.status = controller.signal.aborted ? "cancelled" : "failed";
    if (state.errors.length < 20) state.errors.push((error instanceof Error ? error.message : String(error)).slice(0, 300));
  }).finally(() => {
    clearTimeout(timer); job.updatedAt = Date.now();
    progress(true);
    recordPersistentEvent(state.status === "completed" ? "info" : "warning", "maintenance", "System maintenance finished", state);
  });
  return { ...state, errors: [] };
}
