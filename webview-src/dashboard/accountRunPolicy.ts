import type { DashboardAccountViewModel } from "../../src/domain/dashboard/types";

/**
 * Manual actions stay available when account automation is disabled. The
 * enablement flag is an auto-queue rule; only an in-progress action or an
 * active claim by another PC can prevent a user-initiated switch.
 */
export function canRunAccountOnThisPc(
  account: Pick<DashboardAccountViewModel, "runningDeviceName" | "runningOnThisDevice" | "runningDeviceOnline">,
  busy: boolean,
  registryOverrideEnabled = false
): boolean {
  return (
    !busy &&
    (registryOverrideEnabled ||
      !Boolean(account.runningDeviceName && !account.runningOnThisDevice && account.runningDeviceOnline !== false))
  );
}
