import type { DashboardCliSessionMessage, DashboardCodexSessionLiveState } from "./dashboard/types";
import { MAX_CHAT_ATTACHMENTS, MAX_CHAT_TEXT_ATTACHMENT_BYTES } from './chatAttachments';

export const MAX_CODEX_LIVE_STATE_BYTES = 1024 * 1024;
export const MAX_CODEX_LIVE_ITEMS = 200;
const MAX_TEXT = 12_000;
const encoder = new TextEncoder();
const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal = (status: DashboardCodexSessionLiveState["status"]) => status !== "starting" && status !== "running";
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown, max = MAX_TEXT) => typeof value === "string" ? value.slice(0, max) : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function parseCodexTokenUsage(value: unknown): DashboardCodexSessionLiveState['tokenUsage'] {
  const usage = record(value);
  const total = record(usage?.['total'] ?? usage?.['total_token_usage'] ?? usage?.['last'] ?? usage?.['last_token_usage']);
  const last = record(usage?.['last'] ?? usage?.['last_token_usage']);
  if (!usage || !total) return undefined;
  const token = (camel: string, snake: string) => { const value = total[camel] ?? total[snake]; return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined; };
  const context = last?.['totalTokens'] ?? last?.['total_tokens'];
  const limit = usage['modelContextWindow'] ?? usage['model_context_window'];
  return { total: token('totalTokens','total_tokens'), input: token('inputTokens','input_tokens'), cachedInput: token('cachedInputTokens','cached_input_tokens'), output: token('outputTokens','output_tokens'), reasoningOutput: token('reasoningOutputTokens','reasoning_output_tokens'), contextTokens: Number.isSafeInteger(context) && (context as number) >= 0 ? context as number : undefined, contextWindow: Number.isSafeInteger(limit) && (limit as number) > 0 ? limit as number : undefined };
}

/** The peer boundary accepts the same bounded, display-only state as local hosts. */
export function isCodexSessionLiveState(value: unknown): value is DashboardCodexSessionLiveState {
  const state = record(value);
  if (!state || typeof state["sessionId"] !== "string" || !UUID.test(state["sessionId"]) || typeof state["streamId"] !== "string" || !UUID.test(state["streamId"]) || !Number.isSafeInteger(state["sequence"]) || (state["sequence"] as number) < 0 || number(state["updatedAt"]) === undefined || !["starting", "running", "completed", "cancelled", "failed", "disconnected"].includes(String(state["status"]))) return false;
  if (Object.keys(state).some((key) => !["sessionId", "deviceId", "streamId", "sequence", "turnId", "status", "updatedAt", "messages", "plan", "diff", "tokenUsage", "rateLimits", "error", "truncated"].includes(key))) return false;
  if (state["deviceId"] !== undefined && (typeof state["deviceId"] !== "string" || state["deviceId"].length > 256)) return false;
  if (state["turnId"] !== undefined && (typeof state["turnId"] !== "string" || state["turnId"].length > 256)) return false;
  if (!Array.isArray(state["messages"]) || state["messages"].length > MAX_CODEX_LIVE_ITEMS || state["messages"].some((value) => !validMessage(value))) return false;
  if (state["diff"] !== undefined && (typeof state["diff"] !== "string" || state["diff"].length > MAX_TEXT)) return false;
  if (state["error"] !== undefined && (typeof state["error"] !== "string" || state["error"].length > MAX_TEXT)) return false;
  if (state["truncated"] !== undefined && typeof state["truncated"] !== "boolean") return false;
  const plan = record(state["plan"]);
  if (state["plan"] !== undefined && (!plan || Object.keys(plan).some((key) => key !== "explanation" && key !== "steps") || !Array.isArray(plan["steps"]) || plan["steps"].length > 100 || (plan["explanation"] !== undefined && (typeof plan["explanation"] !== "string" || plan["explanation"].length > MAX_TEXT)) || plan["steps"].some((value) => { const step = record(value); return !step || Object.keys(step).some((key) => key !== "step" && key !== "status") || typeof step["step"] !== "string" || step["step"].length > MAX_TEXT || !["pending", "inProgress", "completed"].includes(String(step["status"])); }))) return false;
  const usage = record(state["tokenUsage"]);
  if (state["tokenUsage"] !== undefined && (!usage || Object.entries(usage).some(([key, value]) => !["total", "input", "cachedInput", "output", "reasoningOutput", "contextWindow", "contextTokens"].includes(key) || (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0))))) return false;
  const limits = record(state["rateLimits"]);
  if (state["rateLimits"] !== undefined && (!limits || Object.entries(limits).some(([key, value]) => {
    if (key !== "primary" && key !== "secondary") return true;
    if (value === undefined) return false;
    const window = record(value);
    return !window || number(window["usedPercent"]) === undefined || (window["usedPercent"] as number) > 100 || Object.entries(window).some(([key, value]) => !["usedPercent", "windowDurationMins", "resetsAt"].includes(key) || (value !== undefined && number(value) === undefined));
  }))) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= MAX_CODEX_LIVE_STATE_BYTES; } catch { return false; }
}

type LiveRevision = Pick<DashboardCodexSessionLiveState, "streamId" | "sequence" | "updatedAt" | "status"> & Partial<Pick<DashboardCodexSessionLiveState, "sessionId" | "deviceId">>;
export function isNewerCodexSessionLiveState(next: LiveRevision, previous: LiveRevision | undefined): boolean {
  if (!previous) return true;
  if ((next.sessionId !== undefined && previous.sessionId !== undefined && next.sessionId !== previous.sessionId) || (next.deviceId !== undefined && previous.deviceId !== undefined && next.deviceId !== previous.deviceId)) return false;
  return next.streamId === previous.streamId ? next.sequence > previous.sequence && !(terminal(previous.status) && !terminal(next.status)) : next.updatedAt > previous.updatedAt;
}

export function validMessage(value: unknown, maxText = MAX_TEXT): boolean {
  const message = record(value);
  if (!message || typeof message["id"] !== "string" || !message["id"] || message["id"].length > 256 || typeof message["text"] !== "string" || message["text"].length > maxText) return false;
  for (const [key, value] of Object.entries(message)) {
    if (value === undefined) continue;
    if (["id", "turnId", "text", "title", "subtitle", "command", "cwd", "output", "arguments", "result", "debug", "timestamp"].includes(key)) { if (typeof value !== "string" || value.length > (key === "turnId" || key === "id" ? 256 : maxText)) return false; }
    else if (key === "kind") { if (typeof value !== "string" || !["message", "reasoning", "plan", "command", "file-change", "tool-call", "collaboration", "web-search", "image", "review", "compaction", "error"].includes(value)) return false; }
    else if (key === "role") { if (value !== "user" && value !== "assistant") return false; }
    else if (key === "status") { if (typeof value !== "string" || !["inProgress", "completed", "failed", "declined", "interrupted", "unknown"].includes(value)) return false; }
    else if (key === "exitCode" || key === "durationMs") { if (typeof value !== "number" || !Number.isFinite(value) || (key === "durationMs" && value < 0)) return false; }
    else if (key === 'questions') {
      if (!Array.isArray(value) || value.length > 10 || value.some(value => {
        const question = record(value);
        return !question || typeof question['title'] !== 'string' || !question['title'].trim() || question['title'].length > 8000 || Object.keys(question).some(key => !['title', 'options'].includes(key)) || (question['options'] !== undefined && (!Array.isArray(question['options']) || question['options'].length > 20 || question['options'].some(option => typeof option !== 'string' || option.length > 8000)));
      })) return false;
    }
    else if (key === 'textAttachments') {
      if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS || value.some(value => {
        const file = record(value);
        return !file || typeof file['name'] !== 'string' || !file['name'].trim() || file['name'].length > 160 || /[\\/\0]/.test(file['name']) || typeof file['text'] !== 'string' || file['text'].includes('\0') || encoder.encode(file['text']).length > MAX_CHAT_TEXT_ATTACHMENT_BYTES || Object.keys(file).some(key => !['name', 'text'].includes(key));
      })) return false;
    } else if (key === "changes" || key === "images") {
      if (!Array.isArray(value) || value.length > 100 || value.some((value) => {
        const item = record(value);
        const required = key === "changes" ? ["path", "kind"] : ["src"];
        const allowed = key === "changes" ? ["path", "kind", "diff"] : ["src", "alt"];
        return !item || required.some((field) => typeof item[field] !== "string") || Object.entries(item).some(([field, value]) => !allowed.includes(field) || (value !== undefined && (typeof value !== "string" || value.length > maxText)));
      })) return false;
    } else return false;
  }
  return true;
}

/** Keep raw protocol items only for the current turn; the existing parser owns rendering. */
export class CodexSessionLiveReducer {
  private readonly items = new Map<string, Record<string, unknown>>();
  private readonly itemBytes = new Map<string, number>();
  private retainedItemBytes = 0;
  private snapshotJson: string | undefined;
  private errorItem: Record<string, unknown> | undefined;
  private readonly earlyCompletions = new Map<string, unknown>();
  private state: DashboardCodexSessionLiveState;

  constructor(sessionId: string, streamId: string, private readonly parseItems: (value: unknown) => DashboardCliSessionMessage[], previousUpdatedAt = 0) {
    this.state = { sessionId, streamId, sequence: 0, status: "starting", updatedAt: Math.max(Date.now(), previousUpdatedAt + 1), messages: [] };
  }

  accept(method: string, raw: unknown): boolean {
    if (terminal(this.state.status)) return false;
    const params = record(raw);
    if (!params || (params["threadId"] !== undefined && params["threadId"] !== this.state.sessionId) || (this.state.turnId && params["turnId"] !== undefined && params["turnId"] !== this.state.turnId)) return false;
    if (method === "turn/started" || method === "turn/completed") {
      const turn = record(params["turn"]);
      if (!turn || typeof turn["id"] !== "string" || (this.state.turnId && turn["id"] !== this.state.turnId)) return false;
      if (method === "turn/completed" && !this.state.turnId) {
        if (this.earlyCompletions.size >= 8) this.earlyCompletions.delete(this.earlyCompletions.keys().next().value!);
        this.earlyCompletions.set(turn["id"], raw);
        return false;
      }
      this.state.turnId = turn["id"].slice(0, 256);
      if (method === "turn/started") this.state.status = "running";
      else {
        this.state.status = turn["status"] === "completed" ? "completed" : turn["status"] === "interrupted" ? "cancelled" : "failed";
        this.errorItem = undefined;
        this.state.error = undefined;
        this.setError(turn["error"], false);
      }
    } else if (method === "item/started" || method === "item/completed") {
      const item = record(params["item"]);
      if (!item || typeof item["id"] !== "string") return false;
      if (method === "item/started" && this.items.has(item["id"])) return false;
      this.putItem(item["id"], { ...bounded(item, 0, () => { this.state.truncated = true; }) as Record<string, unknown>, status: item["status"] ?? (method === "item/started" ? "inProgress" : "completed") });
    } else if (method.startsWith("item/") && (method.endsWith("Delta") || method.endsWith("/delta"))) {
      if (typeof params["itemId"] !== "string" || typeof params["delta"] !== "string") return false;
      const id = params["itemId"];
      const existing = this.items.get(id);
      if (!existing) { this.state.truncated = true; this.changed(); return true; }
      if (existing["status"] !== "inProgress") return false;
      const type = method.split("/")[1];
      const item = existing;
      if (type === "agentMessage" || type === "plan") item["text"] = append(item["text"], params["delta"]);
      else if (type === "reasoning") {
        const key = method.includes("summary") ? "summary" : "content";
        const sections = Array.isArray(item[key]) ? item[key] as string[] : [];
        const index = Math.min(99, Math.max(0, Math.floor(number(params["summaryIndex"] ?? params["contentIndex"]) ?? 0)));
        while (sections.length <= index) sections.push("");
        sections[index] = append(sections[index], params["delta"]);
        item[key] = sections;
      } else if (type === "commandExecution" || type === "fileChange") {
        const output = `${typeof item["aggregatedOutput"] === "string" ? item["aggregatedOutput"] : ""}${params["delta"]}`;
        if (output.length > MAX_TEXT) this.state.truncated = true;
        item["aggregatedOutput"] = output.slice(-MAX_TEXT);
      }
      else return false;
      this.putItem(id, item);
    } else if (method === "item/mcpToolCall/progress") {
      if (typeof params["itemId"] !== "string" || typeof params["message"] !== "string") return false;
      const item = this.items.get(params["itemId"]);
      if (!item || item["status"] !== "inProgress") return false;
      item["progress"] = string(params["message"]);
      this.putItem(params["itemId"], item);
    } else if (method === "turn/plan/updated") {
      if (!Array.isArray(params["plan"])) return false;
      this.state.plan = { explanation: string(params["explanation"]), steps: params["plan"].slice(0, 100).flatMap((value) => { const step = record(value); return step && typeof step["step"] === "string" && ["pending", "inProgress", "completed"].includes(String(step["status"])) ? [{ step: step["step"].slice(0, 1000), status: step["status"] as "pending" | "inProgress" | "completed" }] : []; }) };
    } else if (method === "turn/diff/updated") {
      this.state.diff = string(params["diff"]);
    } else if (method === "thread/tokenUsage/updated") {
      const usage = record(params["tokenUsage"]);
      const tokens = parseCodexTokenUsage(usage);
      if (!tokens) return false;
      this.state.tokenUsage = tokens;
    } else if (method === "account/rateLimits/updated") {
      const limits = record(params["rateLimits"]);
      if (!limits) return false;
      const window = (value: unknown) => { const limit = record(value); const usedPercent = number(limit?.["usedPercent"]); return usedPercent !== undefined && usedPercent <= 100 ? { usedPercent, windowDurationMins: number(limit?.["windowDurationMins"]), resetsAt: number(limit?.["resetsAt"]) } : undefined; };
      this.state.rateLimits = { primary: window(limits["primary"]), secondary: window(limits["secondary"]) };
    } else if (method === "error") {
      if (!this.setError(params["error"], params["willRetry"] === true)) return false;
    } else return false;
    if (this.errorItem?.["willRetry"] === true && (method === "item/started" || method === "item/completed" || (method.startsWith("item/") && (method.endsWith("Delta") || method.endsWith("/delta"))))) this.errorItem = undefined;
    this.changed();
    return true;
  }

  started(turnId: string): void {
    if (terminal(this.state.status)) return;
    this.state.turnId = turnId.slice(0, 256);
    this.state.status = "running";
    this.changed();
    const early = this.earlyCompletions.get(turnId);
    this.earlyCompletions.clear();
    if (early) this.accept("turn/completed", early);
  }

  finish(status: "completed" | "cancelled" | "failed" | "disconnected", error?: string): void {
    if (terminal(this.state.status)) return;
    this.state.status = status;
    if (this.errorItem?.["willRetry"] === true) this.errorItem = undefined;
    this.state.error = string(error) ?? (status === "failed" ? this.state.error : undefined);
    if (status === "failed" && !this.errorItem) this.setError({ message: error }, false);
    this.changed();
  }

  snapshot(): DashboardCodexSessionLiveState {
    if (this.snapshotJson) return JSON.parse(this.snapshotJson) as DashboardCodexSessionLiveState;
    const state = { ...this.state, messages: this.parseItems({ thread: { turns: [{ id: this.state.turnId, status: this.state.status === "running" ? "inProgress" : this.state.status, items: [...this.items.values(), ...(this.errorItem ? [this.errorItem] : [])] }] } }) };
    if (state.messages.length > MAX_CODEX_LIVE_ITEMS) { state.messages = state.messages.slice(-MAX_CODEX_LIVE_ITEMS); state.truncated = true; }
    const sizes = state.messages.map(jsonBytes);
    let bytes = jsonBytes({ ...state, messages: [], truncated: true }) + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, sizes.length - 1);
    let start = 0;
    while (bytes > MAX_CODEX_LIVE_STATE_BYTES && start < sizes.length) {
      bytes -= sizes[start++]! + (start < sizes.length ? 1 : 0);
      state["truncated"] = true;
    }
    state.messages = state.messages.slice(start);
    this.snapshotJson = JSON.stringify(state);
    return JSON.parse(this.snapshotJson) as DashboardCodexSessionLiveState;
  }

  private setError(value: unknown, retrying: boolean): boolean {
    const error = record(value);
    const message = string(error?.["message"]);
    if (!message?.trim()) return false;
    this.state.error = retrying ? undefined : message;
    this.errorItem = { id: retrying ? `retry-${this.state.streamId}` : `${(this.state.turnId ?? this.state.streamId).slice(0, 250)}-error`, type: "error", error: bounded(error, 0, () => { this.state.truncated = true; }), willRetry: retrying, status: retrying ? "inProgress" : "failed" };
    return true;
  }

  private changed(): void { this.snapshotJson = undefined; this.state.sequence += 1; this.state.updatedAt = Math.max(this.state.updatedAt + 1, Date.now()); }
  private putItem(id: string, item: Record<string, unknown>): void {
    if (id.length > 256) return;
    const bytes = jsonBytes(item);
    this.retainedItemBytes += bytes - (this.itemBytes.get(id) ?? 0);
    this.itemBytes.set(id, bytes);
    this.items.set(id, item);
    while (this.items.size > MAX_CODEX_LIVE_ITEMS || this.retainedItemBytes + this.items.size + 1 > MAX_CODEX_LIVE_STATE_BYTES / 2) {
      // Keep an active command updating even when many later activities finish.
      const oldest = [...this.items].find(([, value]) => value["status"] !== "inProgress")?.[0] ?? this.items.keys().next().value!;
      this.retainedItemBytes -= this.itemBytes.get(oldest)!;
      this.itemBytes.delete(oldest);
      this.items.delete(oldest);
      this.state.truncated = true;
    }
  }
}

function append(value: unknown, delta: string): string { return `${typeof value === "string" ? value : ""}${delta}`.slice(0, MAX_TEXT); }
function bounded(value: unknown, depth = 0, onTruncated: () => void = () => undefined, textLimit = MAX_TEXT): unknown {
  if (typeof value === "string") {
    if (value.length > MAX_TEXT) onTruncated();
    // An incomplete data URL cannot render. Persisted history hydrates full images.
    return value.startsWith("data:image/") && value.length > MAX_TEXT ? undefined : value.slice(0, textLimit);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (depth > 6) { onTruncated(); return undefined; }
  if (Array.isArray(value)) {
    if (value.length > 100) onTruncated();
    return value.slice(0, 100).map((item) => bounded(item, depth + 1, onTruncated, textLimit));
  }
  const item = record(value);
  if (item && Object.keys(item).length > 64) onTruncated();
  return item ? Object.fromEntries(Object.entries(item).slice(0, 64).map(([key, value]) => [key, bounded(value, depth + 1, onTruncated, item['type'] === 'userMessage' && key === 'content' ? 64_000 : textLimit)])) : undefined;
}

/** Replace the current turn suffix instead of accumulating duplicate streamed/transcript items. */
export function combineCliLiveMessages(history: DashboardCliSessionMessage[], live: DashboardCodexSessionLiveState | undefined): DashboardCliSessionMessage[] {
  if (!live) return history;
  // A merged task snapshot must not retain a transient retry after recovery.
  history = history.filter(item => !(item.kind === "error" && item.status === "inProgress" && item.id.startsWith("retry-") && UUID.test(item.id.slice(6))) || live.messages.some(current => current.id === item.id));
  if (!live.messages.length) return history;
  const saved = new Map(history.map(item => [item.id, item]));
  const messages = live.messages.map(item => {
    const previous = saved.get(item.id);
    return previous && (previous.text === item.text || previous.role === 'user' && previous.images?.length && previous.text.replace(/^[ \t]*\[Image unavailable\][ \t]*$/gm, '').trim() === item.text.replace(/^[ \t]*\[Image unavailable\][ \t]*$/gm, '').trim()) && previous.role === item.role && (!previous.turnId || !item.turnId || previous.turnId === item.turnId)
      && ((!item.textAttachments?.length && previous.textAttachments?.length) || (!item.images?.length && previous.images?.length)) ? { ...item,
      text: previous.role === 'user' && previous.images?.length ? previous.text : item.text,
      ...(!item.textAttachments?.length && previous.textAttachments?.length ? { textAttachments: previous.textAttachments } : {}),
      ...(!item.images?.length && previous.images?.length ? { images: previous.images } : {}) } : item;
  });
  // Rollout markers and live protocol items can describe the same activity with different IDs.
  const matchedActivities = new Set<string>();
  for (const [index, item] of messages.entries()) {
    if (saved.has(item.id) || !live.turnId || !["compaction", "image"].includes(item.kind ?? "")) continue;
    const before = messages.slice(0, index).reverse().find(candidate => saved.has(candidate.id));
    const after = messages.slice(index + 1).find(candidate => saved.has(candidate.id));
    const start = before ? history.findIndex(candidate => candidate.id === before.id) + 1 : 0;
    const end = after ? history.findIndex(candidate => candidate.id === after.id) : history.length;
    const echo = history.slice(start, end).find(candidate => candidate.kind === item.kind && candidate.turnId === live.turnId &&
      !matchedActivities.has(candidate.id) && !messages.some(other => other.id === candidate.id) &&
      (item.kind === 'compaction' ? /^(?:context-compacted|compacted|compaction-pair)-/.test(candidate.id) :
        /^\d+-/.test(candidate.id) && !!item.images?.length && JSON.stringify(candidate.images?.map(image => image.src)) === JSON.stringify(item.images.map(image => image.src))));
    if (echo) { matchedActivities.add(echo.id); messages[index] = { ...echo, ...item, id: echo.id }; }
  }
  // Native transcripts can assign a different ID to the accepted steering echo.
  const matchedUsers = new Set<string>();
  for (const [index, item] of messages.entries()) {
    if (saved.has(item.id) || item.role !== "user" || item.kind && item.kind !== "message" || !live.turnId) continue;
    const before = messages.slice(0, index).reverse().find(candidate => saved.has(candidate.id));
    const after = messages.slice(index + 1).find(candidate => saved.has(candidate.id));
    const start = before ? history.findIndex(candidate => candidate.id === before.id) + 1 : 0;
    const end = after ? history.findIndex(candidate => candidate.id === after.id) : history.length;
    const echo = history.slice(start, end).find(candidate => candidate.role === "user" && (!candidate.kind || candidate.kind === "message") &&
      candidate.turnId === live.turnId && !matchedUsers.has(candidate.id) && !messages.some(other => other.id === candidate.id) &&
      candidate.text.replace(/^[ \t]*\[Image unavailable\][ \t]*$/gm, '').trim() === item.text.replace(/^[ \t]*\[Image unavailable\][ \t]*$/gm, '').trim() &&
      (!candidate.images?.length || !item.images?.length || JSON.stringify(candidate.images.map(image => image.src)) === JSON.stringify(item.images.map(image => image.src))) &&
      (!item.textAttachments?.length || JSON.stringify(candidate.textAttachments ?? []) === JSON.stringify(item.textAttachments)));
    if (echo) { matchedUsers.add(echo.id); messages[index] = { ...item, id: before || after || live.truncated ? echo.id : item.id,
      text: echo.images?.length ? echo.text.replace(/^[ \t]*\[Image unavailable\][ \t]*$/gm, '').trim() : item.text,
      images: item.images?.length ? item.images : echo.images,
      textAttachments: item.textAttachments?.length ? item.textAttachments : echo.textAttachments }; }
  }
  const exactTurn = live.turnId ? history.findIndex((item) => item.turnId === live.turnId) : -1;
  const ids = new Set(messages.map((item) => item.id));
  const exactItem = history.findIndex((item) => ids.has(item.id));
  // Keep saved events after a live anchor; a truncated snapshot is only a suffix.
  if (live.truncated || exactItem >= 0) {
    const combined = [...history];
    const combinedIds = new Set(history.map(item => item.id));
    let nextId: string | undefined;
    for (let index = messages.length - 1; index >= 0; index--) {
      const item = messages[index]!;
      const existing = combined.findIndex(candidate => candidate.id === item.id);
      if (existing >= 0) combined[existing] = item;
      else {
        const next = nextId ? combined.findIndex(candidate => candidate.id === nextId) : -1;
        const previous = next < 0 ? messages.slice(0, index).reverse().find(candidate => combinedIds.has(candidate.id)) : undefined;
        const position = next >= 0 ? next : previous ? combined.findIndex(candidate => candidate.id === previous.id) + 1 : combined.length;
        combined.splice(position, 0, item);
        combinedIds.add(item.id);
      }
      nextId = item.id;
    }
    return combined;
  }
  let boundary = exactTurn >= 0 ? exactTurn : exactItem;
  if (boundary < 0) {
    const prompt = live.messages.find((item) => item.role === "user" && (!item.kind || item.kind === "message"));
    if (prompt) {
      for (let index = history.length - 1; index >= 0; index--) {
        const item = history[index]!;
        if (item.role !== "user" || (item.kind && item.kind !== "message")) continue;
        const currentTurnEvidence = (prompt.timestamp && item.timestamp === prompt.timestamp)
          || history.slice(index).some((activity) => activity.status === "inProgress");
        if (item.text === prompt.text && currentTurnEvidence && (!item.turnId || !live.turnId || item.turnId === live.turnId)) boundary = index;
        break;
      }
    }
  }
  return [...(boundary >= 0 ? history.slice(0, boundary) : history), ...messages];
}
