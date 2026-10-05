import type { DashboardCliSessionMessage, DashboardCodexSessionLiveState } from "./dashboard/types";

export const MAX_CODEX_LIVE_STATE_BYTES = 1024 * 1024;
export const MAX_CODEX_LIVE_ITEMS = 200;
const MAX_TEXT = 12_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal = (status: DashboardCodexSessionLiveState["status"]) => status !== "starting" && status !== "running";
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown, max = MAX_TEXT) => typeof value === "string" ? value.slice(0, max) : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

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
  if (state["tokenUsage"] !== undefined && (!usage || Object.entries(usage).some(([key, value]) => !["total", "input", "cachedInput", "output", "reasoningOutput", "contextWindow"].includes(key) || (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0))))) return false;
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

function validMessage(value: unknown): boolean {
  const message = record(value);
  if (!message || typeof message["id"] !== "string" || !message["id"] || message["id"].length > 256 || typeof message["text"] !== "string" || message["text"].length > MAX_TEXT) return false;
  for (const [key, value] of Object.entries(message)) {
    if (value === undefined) continue;
    if (["id", "turnId", "text", "title", "subtitle", "command", "cwd", "output", "arguments", "result", "debug", "timestamp"].includes(key)) { if (typeof value !== "string" || value.length > (key === "turnId" ? 256 : MAX_TEXT)) return false; }
    else if (key === "kind") { if (typeof value !== "string" || !["message", "reasoning", "plan", "command", "file-change", "tool-call", "collaboration", "web-search", "image", "review", "compaction", "error"].includes(value)) return false; }
    else if (key === "role") { if (value !== "user" && value !== "assistant") return false; }
    else if (key === "status") { if (typeof value !== "string" || !["inProgress", "completed", "failed", "declined", "interrupted", "unknown"].includes(value)) return false; }
    else if (key === "exitCode" || key === "durationMs") { if (typeof value !== "number" || !Number.isFinite(value) || (key === "durationMs" && value < 0)) return false; }
    else if (key === "changes" || key === "images") {
      if (!Array.isArray(value) || value.length > 100 || value.some((value) => {
        const item = record(value);
        const required = key === "changes" ? ["path", "kind"] : ["src"];
        const allowed = key === "changes" ? ["path", "kind", "diff"] : ["src", "alt"];
        return !item || required.some((field) => typeof item[field] !== "string") || Object.entries(item).some(([field, value]) => !allowed.includes(field) || (value !== undefined && (typeof value !== "string" || value.length > MAX_TEXT)));
      })) return false;
    } else return false;
  }
  return true;
}

/** Keep raw protocol items only for the current turn; the existing parser owns rendering. */
export class CodexSessionLiveReducer {
  private readonly items = new Map<string, Record<string, unknown>>();
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
        this.state.error = string(record(turn["error"])?.["message"]);
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
      } else if (type === "commandExecution" || type === "fileChange") item["aggregatedOutput"] = append(item["aggregatedOutput"], params["delta"]);
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
      const totals = record(usage?.["last"] ?? usage?.["total"]);
      if (!usage || !totals) return false;
      const tokens = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
      this.state.tokenUsage = { total: tokens(totals["totalTokens"]), input: tokens(totals["inputTokens"]), cachedInput: tokens(totals["cachedInputTokens"]), output: tokens(totals["outputTokens"]), reasoningOutput: tokens(totals["reasoningOutputTokens"]), contextWindow: tokens(usage["modelContextWindow"]) };
    } else if (method === "account/rateLimits/updated") {
      const limits = record(params["rateLimits"]);
      if (!limits) return false;
      const window = (value: unknown) => { const limit = record(value); const usedPercent = number(limit?.["usedPercent"]); return usedPercent !== undefined && usedPercent <= 100 ? { usedPercent, windowDurationMins: number(limit?.["windowDurationMins"]), resetsAt: number(limit?.["resetsAt"]) } : undefined; };
      this.state.rateLimits = { primary: window(limits["primary"]), secondary: window(limits["secondary"]) };
    } else if (method === "error") {
      this.state.error = string(record(params["error"])?.["message"]);
    } else return false;
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
    this.state.error = string(error);
    this.changed();
  }

  snapshot(): DashboardCodexSessionLiveState {
    const state = { ...this.state, messages: this.parseItems({ thread: { turns: [{ id: this.state.turnId, status: this.state.status === "running" ? "inProgress" : this.state.status, items: [...this.items.values()] }] } }) };
    while (new TextEncoder().encode(JSON.stringify(state)).length > MAX_CODEX_LIVE_STATE_BYTES && state["messages"].length) {
      state["messages"].shift();
      state["truncated"] = true;
    }
    return JSON.parse(JSON.stringify(state)) as DashboardCodexSessionLiveState;
  }

  private changed(): void { this.state.sequence += 1; this.state.updatedAt = Math.max(this.state.updatedAt + 1, Date.now()); }
  private putItem(id: string, item: Record<string, unknown>): void {
    if (id.length > 256) return;
    this.items.set(id, item);
    while (this.items.size > MAX_CODEX_LIVE_ITEMS || new TextEncoder().encode(JSON.stringify([...this.items.values()])).length > MAX_CODEX_LIVE_STATE_BYTES / 2) {
      this.items.delete(this.items.keys().next().value!);
      this.state.truncated = true;
    }
  }
}

function append(value: unknown, delta: string): string { return `${typeof value === "string" ? value : ""}${delta}`.slice(0, MAX_TEXT); }
function bounded(value: unknown, depth = 0, onTruncated: () => void = () => undefined): unknown {
  if (typeof value === "string") {
    if (value.length > MAX_TEXT) onTruncated();
    // An incomplete data URL cannot render. Persisted history hydrates full images.
    return value.startsWith("data:image/") && value.length > MAX_TEXT ? undefined : value.slice(0, MAX_TEXT);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (depth > 6) { onTruncated(); return undefined; }
  if (Array.isArray(value)) {
    if (value.length > 100) onTruncated();
    return value.slice(0, 100).map((item) => bounded(item, depth + 1, onTruncated));
  }
  const item = record(value);
  if (item && Object.keys(item).length > 64) onTruncated();
  return item ? Object.fromEntries(Object.entries(item).slice(0, 64).map(([key, item]) => [key, bounded(item, depth + 1, onTruncated)])) : undefined;
}
