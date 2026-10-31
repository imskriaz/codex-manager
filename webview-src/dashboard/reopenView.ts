/** Reopen only the stalled dashboard; let pending work finish and cancel on recovery. */
export function scheduleDashboardReopen(stalled: boolean, pending: boolean, reopen: () => void): () => void {
  if (!stalled || pending) return () => undefined;
  let timer: number | undefined;
  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = document.visibilityState === "hidden" ? undefined : window.setTimeout(() => {
      if (hasUnsavedCliComposerDrafts()) schedule();
      else reopen();
    }, 15_000);
  };
  document.addEventListener("visibilitychange", schedule);
  schedule();
  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", schedule);
  };
}
import { hasUnsavedCliComposerDrafts } from './cliSessionCache';
