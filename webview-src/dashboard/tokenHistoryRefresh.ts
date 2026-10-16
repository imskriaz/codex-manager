import { useEffect, useRef, useState } from "preact/hooks";
import type { SendAction } from "./hookTypes";

export type TokenHistoryRefreshStatus = { state: "queued" | "pending" | "success" | "error"; message: string };
export function useTokenHistoryRefresh(sendAction: SendAction, source: string | undefined) {
  const runtime = useRef({ source, queue: [] as string[], active: new Map<string, string>(), statuses: {} as Record<string, TokenHistoryRefreshStatus>, batch: [] as string[] });
  if (runtime.current.source !== source) runtime.current = { source, queue: [], active: new Map(), statuses: {}, batch: [] };
  const send = useRef(sendAction); send.current = sendAction;
  const [statuses, setStatuses] = useState<Record<string, TokenHistoryRefreshStatus>>({});
  const [summary, setSummary] = useState("");
  const emit = () => {
    const current = runtime.current;
    setStatuses({ ...current.statuses });
    const done = current.batch.filter(id => ["success", "error"].includes(current.statuses[id]?.state ?? "")).length;
    const failed = current.batch.filter(id => current.statuses[id]?.state === "error").length;
    setSummary(current.batch.length ? done === current.batch.length
      ? `Finished: ${done - failed} updated${failed ? `, ${failed} failed` : ""}.`
      : `Refreshing ${done} of ${current.batch.length} accounts…` : "");
  };
  const pump = () => {
    const current = runtime.current;
    while (current.active.size < 3 && current.queue.length) {
      const id = current.queue.shift()!;
      current.statuses[id] = { state: "pending", message: "Refreshing…" };
      const request = send.current("getDailyUsage", id, { days: 30 });
      current.active.set(request, id);
    }
    emit();
  };
  useEffect(() => {
    emit();
  }, [source]);
  useEffect(() => () => { runtime.current.queue = []; runtime.current.active.clear(); }, []);
  return { statuses, summary,
    busy: Object.values(statuses).some(status => status.state === "queued" || status.state === "pending"),
    refresh(ids: string[]) {
      const current = runtime.current;
      const unique = [...new Set(ids)];
      if (unique.length > 1) current.batch = unique;
      for (const id of unique) {
        if (["queued", "pending"].includes(current.statuses[id]?.state ?? "")) continue;
        current.statuses[id] = { state: "queued", message: "Queued" };
        current.queue.push(id);
      }
      pump();
    },
    finish(request: string, success: boolean, error?: string) {
      const current = runtime.current;
      const id = current.active.get(request);
      if (!id) return;
      current.active.delete(request);
      current.statuses[id] = { state: success ? "success" : "error", message: success ? "Updated" : error ?? "Refresh failed. Retry when connected." };
      pump();
    }
  };
}
