import type { DashboardCliSessionSummary } from "../../src/domain/dashboard/types";

export type CliSessionTarget = Pick<DashboardCliSessionSummary, "id" | "deviceId">;
export function cliSessionTargetKey(target: CliSessionTarget): string {
  return JSON.stringify([target.deviceId ?? "local", target.id]);
}

export function sameCliSessionTarget(left?: CliSessionTarget, right?: CliSessionTarget): boolean {
  return Boolean(left && right && left.id === right.id && (left.deviceId ?? "local") === (right.deviceId ?? "local"));
}

export function cliSessionTargetFromLocation(pathname: string, search: string): CliSessionTarget | undefined {
  const id = pathname.match(/^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
  if (!id) return undefined;
  return { id, deviceId: new URLSearchParams(search).get("device") || undefined };
}

export function buildCliSessionPath(session: CliSessionTarget & Pick<DashboardCliSessionSummary, "projectPath">): string {
  const query = new URLSearchParams();
  if (session.projectPath?.trim()) query.set("project", session.projectPath.trim());
  if (session.deviceId) query.set("device", session.deviceId);
  return `/${session.id}${query.size ? `?${query.toString()}` : ""}`;
}
