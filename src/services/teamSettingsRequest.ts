import type { DashboardActionPayload } from "../domain/dashboard/types";

/** Reuse the local administrator API so validation, audit and session revocation stay shared. */
export async function requestLocalTeamSettings(request: DashboardActionPayload["teamSettingsRequest"]): Promise<unknown> {
  if (!request || typeof request.path !== "string" || typeof request.method !== "string") throw new Error("Choose a valid Team settings action.");
  const { path, method, body } = request;
  const allowed = path === "/api/office/users" ? ["GET", "POST"]
    : /^\/api\/office\/users\/[a-f0-9-]{36}$/i.test(path) ? ["PATCH", "DELETE"]
    : path === "/api/office/mcp" || path === "/api/office/settings" ? ["GET", "PUT"]
    : path === "/api/office/models" || path === "/api/office/logs" || path === "/api/office/proxy" ? ["GET"]
    : path === '/api/email/smtp' ? ['GET', 'PUT'] : path === '/api/email/preferences' ? ['GET', 'PUT', 'POST'] : path === '/api/email/test' ? ['POST'] : [];
  if (!allowed.includes(method)) throw new Error("Choose a valid Team settings action.");
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body))) throw new Error("Send a valid Team settings form.");
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && Buffer.byteLength(encoded) > 64 * 1024) throw new Error("The Team settings form is too large.");
  const port = Number(process.env["CODEX_MANAGER_PORT"] ?? 39875);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The local dashboard port is invalid.");
  const signal = AbortSignal.timeout(12_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, body: encoded, signal, redirect: "error",
      ...(encoded ? { headers: { "Content-Type": "application/json" } } : {})
    });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : "Team settings could not be loaded.");
    return result;
  } catch (error) {
    if (signal.aborted) throw new Error(method === "GET" ? "Loading timed out. Retry when the host is available." : "The result could not be confirmed. Refresh before retrying to avoid duplicate changes.");
    if (error instanceof TypeError) throw new Error("The local Team settings host is unavailable. Check that Web Dashboard is enabled and retry.");
    throw error;
  }
}
