export type BrowserPoint = { x: number; y: number };
export type BrowserFeedback = {
  id: string;
  pageId: string;
  url: string;
  revision: string;
  kind: "pointer" | "area" | "draw" | "comment";
  points: BrowserPoint[];
  text: string;
  selector?: string;
  referenceUrl?: string;
  createdAt: number;
  image?: string;
};
export const BROWSER_OPERATIONS = [
  "list",
  "open",
  "close",
  "navigate",
  "back",
  "forward",
  "reload",
  "snapshot",
  "screenshot",
  "click",
  "download",
  "fill",
  "type",
  "press",
  "scroll",
  "hover",
  "select",
  "wait",
  "resize",
  "evaluate",
  "html",
  "styles",
  "events",
  "storage",
  "cdp",
  "feedback",
  "deleteFeedback",
  "readFeedback"
] as const;
export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number];
export type WorkspaceBrowserRequest = {
  operation: BrowserOperation;
  operationId?: string;
  sessionId?: string;
  openedBy?: 'ai' | 'user';
  pageId?: string;
  revision?: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  feedback?: Omit<BrowserFeedback, "url" | "createdAt">;
  feedbackId?: string;
  confirmed?: boolean;
  method?: string;
  params?: Record<string, unknown>;
  eventNames?: string[];
  after?: number;
};
export type BrowserDebugEvent = { sequence: number; timestamp: number; method: string; params: unknown; truncated?: boolean };
export type WorkspaceBrowserState = {
  pages: Array<{ id: string; url: string; title: string; revision: string; openedBy?: 'ai' | 'user' }>;
  pageId?: string;
  revision?: string;
  image?: string;
  feedbackImage?: string;
  text?: string;
  value?: unknown;
  logs?: string[];
  events?: BrowserDebugEvent[];
  eventSequence?: number;
  feedback: BrowserFeedback[];
  warning?: string;
  fileDownload?: { filename: string; mimeType: string; data: string };
};

export function isWorkspaceBrowserChange<T>(value: T): value is T & { projectPath: string; sessionId?: string; deviceId?: string } {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row['projectPath'] === 'string' && row['projectPath'].length > 0 && row['projectPath'].length <= 4096 &&
    (row['sessionId'] === undefined || typeof row['sessionId'] === 'string' && /^[a-zA-Z0-9:-]{1,100}$/.test(row['sessionId'])) &&
    (row['deviceId'] === undefined || typeof row['deviceId'] === 'string' && row['deviceId'].length > 0 && row['deviceId'].length <= 256);
}

/** Coordinates are viewport pixels; the image revision fences human and AI input. */
export function validateBrowserRequest(value: unknown): WorkspaceBrowserRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a browser operation.");
  const row = value as Record<string, unknown>;
  if (row['openedBy'] !== undefined && row['openedBy'] !== 'ai' && row['openedBy'] !== 'user') throw new Error('Invalid browser tab origin.');
  if (JSON.stringify(value).length > 128_000) throw new Error("Browser request exceeds 128 KB.");
  if (!BROWSER_OPERATIONS.includes(row["operation"] as BrowserOperation)) throw new Error("Unknown browser operation.");
  for (const key of ["pageId", "revision", "operationId", "feedbackId", "sessionId"])
    if (row[key] !== undefined && (typeof row[key] !== "string" || !/^[a-zA-Z0-9:-]{1,100}$/.test(row[key])))
      throw new Error(`Invalid browser ${key}.`);
  for (const key of ["url", "selector", "text", "key"])
    if (row[key] !== undefined && (typeof row[key] !== "string" || row[key].length > (key === "text" ? 16_000 : 2_000)))
      throw new Error(`Invalid browser ${key}.`);
  for (const key of ["x", "y", "width", "height"])
    if (
      row[key] !== undefined &&
      (typeof row[key] !== "number" || !Number.isFinite(row[key]) || Math.abs(row[key]) > 10000)
    )
      throw new Error(`Invalid browser ${key}.`);
  if (row['method'] !== undefined && (typeof row['method'] !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(row['method']))) throw new Error('Invalid DevTools method.');
  if (row['params'] !== undefined && (!row['params'] || typeof row['params'] !== 'object' || Array.isArray(row['params']))) throw new Error('DevTools params must be an object.');
  if (row['eventNames'] !== undefined && (!Array.isArray(row['eventNames']) || row['eventNames'].length > 32 || row['eventNames'].some(name => typeof name !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(name)))) throw new Error('Choose at most 32 DevTools events.');
  if (row['after'] !== undefined && (!Number.isSafeInteger(row['after']) || Number(row['after']) < 0)) throw new Error('Invalid browser event cursor.');
  if (row["operation"] === "feedback") {
    const f = row["feedback"] as BrowserFeedback | undefined;
    if (
      !f ||
      typeof f !== "object" ||
      typeof f.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(f.id) ||
      typeof f.pageId !== "string" ||
      typeof f.revision !== "string" ||
      f.pageId !== row["pageId"] ||
      f.revision !== row["revision"] ||
      !["pointer", "area", "draw", "comment"].includes(f.kind) ||
      typeof f.text !== "string" ||
      f.text.length > 8000 ||
      (f.selector !== undefined && (typeof f.selector !== "string" || f.selector.length > 2000)) ||
      !Array.isArray(f.points) ||
      f.points.length < 1 ||
      f.points.length > 500 ||
      f.points.some(
        (p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > 3840 || p.y > 2160
      )
    )
      throw new Error("Invalid browser feedback. Use at most 500 points and 8,000 characters.");
    if (f.referenceUrl !== undefined) browserUrl(f.referenceUrl);
  }
  return value as WorkspaceBrowserRequest;
}

export function browserUrl(value: string | undefined): string {
  if (typeof value !== "string" || value.length > 2000) throw new Error("Enter an http or https URL of at most 2,000 characters.");
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("Enter an http or https URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Use an http or https URL without embedded credentials.");
  return url.href;
}
