import * as fs from "fs/promises";
import * as path from "path";
import { readSafeFileSnapshot } from "../utils/safeFileReads";
import { CrossWindowOperationCoordinator } from "../utils/crossWindowOperations";
import {
  canonicalizeSyncAccountEnablement,
  createSyncAccountEnablement,
  isSyncAccountEnablementActive,
  isValidSyncAccountEnablement,
  type SyncAccountEnablement
} from "./syncEnablementRegistry";

export type AccountClaimRequest = {
  action: "acquire" | "release";
  accountId: string;
  deviceId: string;
  deviceName: string;
  token: string;
  requestId: string;
  sentAt: number;
};
export type AccountClaimResult = {
  requestId: string;
  ok: boolean;
  claim?: SyncAccountEnablement;
  acquired?: boolean;
  error?: string;
};

export function isAccountClaimRequest(value: unknown): value is AccountClaimRequest {
  if (!value || typeof value !== "object") return false;
  const r = value as AccountClaimRequest;
  return (
    ["acquire", "release"].includes(r.action) &&
    [r.accountId, r.deviceId, r.token, r.requestId].every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= 256
    ) &&
    typeof r.deviceName === "string" &&
    r.deviceName.trim().length > 0 &&
    r.deviceName.length <= 120 &&
    Number.isFinite(r.sentAt) &&
    Math.abs(Date.now() - r.sentAt) <= 120_000
  );
}

/** The shared dashboard host serializes ownership before any PC changes auth.json. */
export class AccountClaimAuthority {
  private pending: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private readonly coordinator: CrossWindowOperationCoordinator;
  constructor(
    private readonly file: string,
    private readonly registry: () => readonly SyncAccountEnablement[] = () => []
  ) {
    this.coordinator = new CrossWindowOperationCoordinator(path.dirname(file));
  }

  request(request: AccountClaimRequest): Promise<AccountClaimResult> {
    if (this.queued >= 64)
      return Promise.reject(new Error("Shared claim request queue is full. Retry after pending requests finish."));
    this.queued++;
    const task = this.pending
      .catch(() => undefined)
      .then(() =>
        this.coordinator.runExclusive("shared:account-claim-authority", "Shared account claim", async () => {
          if (!isAccountClaimRequest(request)) throw new Error("Invalid or expired account claim request.");
          const raw = await readSafeFileSnapshot(this.file, { maxBytes: 2 * 1024 * 1024, rejectIfLarger: true })
            .then((snapshot) => snapshot.buffer.toString("utf8"))
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return "[]";
              throw error;
            });
          const stored: unknown = JSON.parse(raw);
          if (!Array.isArray(stored) || !stored.every(isValidSyncAccountEnablement))
            throw new Error("Shared account ownership storage is invalid. Retry after repairing the host storage.");
          const records = new Map(
            canonicalizeSyncAccountEnablement([...stored, ...this.registry()]).map((entry) => [entry.accountId, entry])
          );
          const observedRevision = records.get(request.accountId)?.revision ?? 0;
          // Sync snapshots cannot supersede ownership granted or released by this host.
          for (const entry of stored) {
            if (entry.currentOnly) records.set(entry.accountId, entry);
          }
          const current = records.get(request.accountId);
          let claim: SyncAccountEnablement;
          let acquired = false;
          if (request.action === "acquire") {
            if (
              current?.enabled &&
              current.deviceId !== request.deviceId &&
              (current.lastSyncedAt === undefined || isSyncAccountEnablementActive(current))
            ) {
              return {
                requestId: request.requestId,
                ok: false,
                error: `This account is running on ${current.deviceName}. Switch that PC to another account first.`
              };
            }
            if (
              current?.enabled &&
              current.deviceId === request.deviceId &&
              current.currentOnly &&
              current.revision >= observedRevision &&
              current.claimToken &&
              current.lastSyncedAt !== undefined &&
              Date.now() - current.lastSyncedAt < 30 * 60_000
            ) {
              return { requestId: request.requestId, ok: true, claim: current, acquired: false };
            }
            acquired = !current?.enabled || current.deviceId !== request.deviceId;
            claim = {
              ...createSyncAccountEnablement({
                ...request,
                enabled: true,
                revision: Math.max(current?.revision ?? 0, observedRevision) + 1,
                lastSyncedAt: Date.now()
              }),
              currentOnly: true,
              claimToken: !acquired && current?.claimToken ? current.claimToken : request.token
            };
          } else {
            if (
              !current ||
              current.deviceId !== request.deviceId ||
              !current.enabled ||
              (current.claimToken !== undefined && current.claimToken !== request.token)
            ) {
              return {
                requestId: request.requestId,
                ok: false,
                error: "The account claim changed. Refresh claims before retrying."
              };
            }
            claim = {
              ...current,
              enabled: false,
              revision: Math.max(current.revision, observedRevision) + 1,
              updatedAt: Date.now(),
              lastSyncedAt: Date.now()
            };
          }
          records.set(claim.accountId, claim);
          if (records.size > 1000)
            throw new Error("Shared account claim storage is full. Remove obsolete claims before retrying.");
          await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
          const temp = `${this.file}.${process.pid}.tmp`;
          try {
            await fs.writeFile(temp, JSON.stringify([...records.values()]), { mode: 0o600 });
            await fs.rename(temp, this.file);
          } catch (error) {
            await fs.unlink(temp).catch(() => undefined);
            throw error;
          }
          return { requestId: request.requestId, ok: true, claim, acquired };
        })
      )
      .finally(() => {
        this.queued--;
      });
    this.pending = task;
    return task;
  }
}
