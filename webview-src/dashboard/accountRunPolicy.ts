import type { DashboardAccountViewModel } from "../../src/domain/dashboard/types";

/**
 * Manual actions stay available when account automation is disabled or when
 * another PC currently claims the account. Claims are an automation safety
 * fence; they must not lock a user out of an explicit switch.
 */
export function canRunAccountOnThisPc(
  _account: Pick<DashboardAccountViewModel, "runningDeviceName" | "runningOnThisDevice" | "runningDeviceOnline">,
  busy: boolean,
  _registryOverrideEnabled = false
): boolean {
  return !busy;
}
