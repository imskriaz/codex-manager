import { useCallback, useEffect, useRef } from "preact/hooks";
import type {
  DashboardActionName,
  DashboardActionPayload,
  DashboardActionResultPayload,
  DashboardHostMessage
} from "../../src/domain/dashboard/types";
import { createActionRequestId, postMessageToHost } from "./host";

/** Transient workspace commands have no offline queue, disk cache or automatic replay. */
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
    (action: DashboardActionName, payload: DashboardActionPayload = {}): Promise<DashboardActionResultPayload> => {
      if (!connected || !navigator.onLine) {
        return Promise.reject(new Error("Reconnect to the selected system before using workspace tools."));
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
