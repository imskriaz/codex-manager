import { getCodexHomeStateKey } from "../codex/authFile";
import { getSqliteStateStore } from "../storage/sqliteState";

export type CodexSessionPreference = {
  autoResume?: boolean;
  queue?: boolean;
  priority?: 1 | 2 | 3;
};

const NAMESPACE = "codex-session-preferences";
const TITLE_NAMESPACE = "codex-session-title-overrides";
const key = (home: string, id: string) => `${getCodexHomeStateKey(home)}:${id.toLowerCase()}`;

function read(store: ReturnType<typeof getSqliteStateStore>, home: string, id: string): CodexSessionPreference {
  const value = store?.get<CodexSessionPreference>(NAMESPACE, key(home, id));
  return value && typeof value === "object" ? value : {};
}

function readNamespace(home: string, namespace: string): Map<string, unknown> {
  const store = getSqliteStateStore();
  const result = new Map<string, unknown>();
  if (!store) return result;
  const prefix = `${getCodexHomeStateKey(home)}:`;
  for (const row of store.prepare("SELECT key,value FROM state WHERE namespace=? AND key LIKE ? LIMIT 30000").all(namespace, `${prefix}%`)) {
    const keyValue = String(row["key"]);
    try { result.set(keyValue.slice(prefix.length), JSON.parse(String(row["value"]))); } catch { /* Ignore one corrupt optional preference. */ }
  }
  return result;
}

export function readCodexSessionPreferences(home: string, ids: readonly string[]): Map<string, CodexSessionPreference> {
  const values = readNamespace(home, NAMESPACE);
  const result = new Map<string, CodexSessionPreference>();
  for (const id of ids) {
    const value = values.get(id.toLowerCase());
    result.set(id, value && typeof value === "object" ? value as CodexSessionPreference : {});
  }
  return result;
}

export function writeCodexSessionPreference(home: string, id: string, patch: Partial<CodexSessionPreference>): CodexSessionPreference {
  const store = getSqliteStateStore();
  const next = { ...read(store, home, id), ...patch };
  if (next.autoResume === undefined && next.queue === undefined && next.priority === undefined) store?.set(NAMESPACE, key(home, id), undefined);
  else store?.set(NAMESPACE, key(home, id), next);
  return next;
}

export function isCodexSessionAutoResumeDisabled(home: string, id: string): boolean {
  return read(getSqliteStateStore(), home, id).autoResume === false;
}

export function orderCodexSessionRecoveryIds(home: string, ids: readonly string[]): string[] {
  const preferences = readCodexSessionPreferences(home, ids);
  return [...ids].sort((left, right) => {
    const a = preferences.get(left), b = preferences.get(right);
    const aQueued = a?.queue === true, bQueued = b?.queue === true;
    if (aQueued !== bQueued) return aQueued ? 1 : -1;
    if (!aQueued) return 0;
    return (a?.priority ?? 3) - (b?.priority ?? 3);
  });
}

export function readCodexSessionTitleOverrides(home: string, ids: readonly string[]): Map<string, string> {
  const values = readNamespace(home, TITLE_NAMESPACE);
  const result = new Map<string, string>();
  for (const id of ids) {
    const title = values.get(id.toLowerCase());
    if (typeof title === "string" && title.trim()) result.set(id, title);
  }
  return result;
}

export function writeCodexSessionTitleOverride(home: string, id: string, title: string): void {
  getSqliteStateStore()?.set(TITLE_NAMESPACE, key(home, id), title.trim().slice(0, 160));
}
