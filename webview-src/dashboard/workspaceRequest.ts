import { useCallback, useEffect, useRef } from "preact/hooks";
import type {
  DashboardActionName,
  DashboardActionPayload,
  DashboardActionResultPayload,
  DashboardHostMessage
} from "../../src/domain/dashboard/types";
import { createActionRequestId, postMessageToHost } from "./host";

import { cacheSystemId, readBrowserCache, writeBrowserCache } from './cliSessionCache';
import { offlineReadCacheKey } from './offlinePolicy';

/** Transient workspace commands are never queued or automatically replayed. Cached reads never authorize mutations. */
export function useWorkspaceRequest(
  projectPath: string | undefined,
  targetDeviceId: string | undefined,
  connected: boolean
) {
  const pending = useRef(new Map<string, { cancel: () => void; persistent: boolean }>());
  useEffect(() => {
    return () => {
      for (const item of [...pending.current.values()]) {
        if (!item.persistent) {
          item.cancel();
        }
      }
    };
  }, [projectPath, targetDeviceId]);
  return useCallback(
    (action: DashboardActionName, payload: DashboardActionPayload = {}, onCached?: (result: DashboardActionResultPayload) => void): Promise<DashboardActionResultPayload> => {
      const systemId = cacheSystemId(targetDeviceId);
      const cacheable = action === 'getWorkspaceEnvironment' || (action === 'workspaceGit' && ['read', 'diff'].includes(payload.gitRequest?.operation ?? '')) || (action === 'workspaceGitHub' && ['read', 'detail'].includes(payload.githubRequest?.operation ?? ''));
      const cacheKey = document.documentElement.dataset['dashboardHost'] === 'browser' && systemId && projectPath && cacheable ? offlineReadCacheKey(action, undefined, { ...payload, projectPath, targetDeviceId: systemId }) : undefined;
      if (!connected || !navigator.onLine) {
        return (cacheKey && onCached ? readBrowserCache<DashboardActionResultPayload>(cacheKey).then(saved => { if (saved) onCached(saved); }) : Promise.resolve()).then(() => { throw new Error('Reconnect to the selected system before using workspace tools.'); });
      }
      if (!projectPath) {
        return Promise.reject(new Error("Select a project first."));
      }
      if (pending.current.size >= 16) {
        return Promise.reject(new Error("Workspace request queue is full. Wait for the current action to finish."));
      }
      const id = createActionRequestId(true);
      return new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          pending.current.delete(id);
          window.removeEventListener("message", receive);
        };
        const receive = (event: MessageEvent<DashboardHostMessage>) => {
          const message = event.data;
          if (message?.type !== "dashboard:action-result" || message.requestId !== id) {
            return;
          }
          finish();
          if (cacheKey && message.status === 'completed' && message.payload) void writeBrowserCache(cacheKey, { ...message.payload, notice: undefined });
          if (message.status !== "completed") {
            reject(new Error(message.error || "The workspace action did not complete."));
          } else {
            resolve(message.payload ?? {});
          }
        };
        const timer = setTimeout(
          () => {
            finish();
            reject(
              new Error(
                "The system did not confirm this action. Refresh and check its outcome before retrying; it was not replayed."
              )
            );
          },
          action === "workspaceTerminal" ? 10_000 : 135_000
        );
        window.addEventListener("message", receive);
        pending.current.set(id, {
          persistent: payload.confirmed === true && ["workspaceGit", "workspaceGitHub"].includes(action),
          cancel: () => {
            finish();
            reject(new Error("The selected workspace changed. Check the previous action’s outcome before retrying."));
          }
        });
        if (cacheKey && onCached) void readBrowserCache<DashboardActionResultPayload>(cacheKey).then(saved => { if (saved && pending.current.has(id)) onCached(saved); });
        try {
          postMessageToHost({
            type: "dashboard:action",
            requestId: id,
            action,
            payload: { ...payload, projectPath, targetDeviceId, automatic: true }
          });
        } catch (error) {
          finish();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    [projectPath, targetDeviceId, connected]
  );
}
