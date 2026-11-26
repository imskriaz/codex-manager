import type { DashboardHostMessage } from "../../src/domain/dashboard/types";
import { createActionRequestId, postMessageToHost } from "./host";

export function requestTeamSettingsFromWebview<T>(path: string, method: string, body?: unknown): Promise<T> {
  const requestId = createActionRequestId(true);
  return new Promise((resolve, reject) => {
    const finish = () => { window.clearTimeout(timer); window.removeEventListener("message", receive); };
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== "dashboard:action-result" || message.requestId !== requestId || message.action !== "teamSettingsRequest") return;
      finish();
      if (message.status !== "completed") reject(new Error(message.error || "Team settings could not be loaded."));
      else if (message.payload?.teamSettingsResponse === undefined) reject(new Error("The host did not return Team settings. Update this system and retry."));
      else resolve(message.payload.teamSettingsResponse as T);
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(new Error(method === "GET" ? "Loading timed out. Retry when the host is available." : "The result could not be confirmed. Refresh before retrying to avoid duplicate changes."));
    }, 15_000);
    window.addEventListener("message", receive);
    try { postMessageToHost({ type: "dashboard:action", action: "teamSettingsRequest", requestId, payload: { teamSettingsRequest: { path, method, body }, automatic: true } }); }
    catch (error) { finish(); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}

export async function request<T>(url: string, method = "GET", body?: unknown, timeoutMs=15000): Promise<T> {
  if (typeof document !== "undefined" && document.documentElement.dataset["dashboardHost"] !== "browser") return requestTeamSettingsFromWebview<T>(url, method, body);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      signal: controller.signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = (await response.json().catch(() => { throw new Error("The host did not return valid Team settings. Refresh and retry."); })) as T & { error?: string };
    if (!response.ok)
      throw new Error(
        result.error ??
          (response.status === 401
            ? "Your session expired. Sign in again."
            : "Team settings could not be loaded. Enable Team workspace in Modules settings and retry.")
      );
    return result;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        method === "GET"
          ? "Loading timed out. Retry when the host is available."
          : "The result could not be confirmed. Refresh before retrying to avoid duplicate changes."
      );
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}
