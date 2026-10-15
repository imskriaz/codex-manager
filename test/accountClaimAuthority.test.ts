import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountClaimAuthority, type AccountClaimRequest } from "../src/services/accountClaimAuthority";
import { createSyncAccountEnablement } from "../src/services/syncEnablementRegistry";

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "claim-authority-"));
  file = path.join(directory, "claims.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const acquire = (deviceId: string, token = `${deviceId}-token`): AccountClaimRequest => ({
  action: "acquire",
  accountId: "account",
  deviceId,
  deviceName: deviceId,
  token,
  requestId: `${deviceId}-${token}`,
  sentAt: Date.now()
});

describe("shared current-account claim authority", () => {
  it("grants one owner under concurrent acquisition and preserves it across reboot", async () => {
    const authority = new AccountClaimAuthority(file);
    const results = await Promise.all([authority.request(acquire("PC A")), authority.request(acquire("PC B"))]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(results[1]?.error).toContain("PC A");
    expect(await new AccountClaimAuthority(file).request(acquire("PC B"))).toMatchObject({ ok: false });
    const saved = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"));
    saved[0].lastSyncedAt = Date.now() - 31 * 60_000;
    await writeFile(file, JSON.stringify(saved));
    expect(await new AccountClaimAuthority(file).request(acquire("PC B"))).toMatchObject({ ok: true });

    expect(await authority.request(acquire("PC A", "retry"))).toMatchObject({ ok: false });
  });

  it("fences foreign, duplicate, and delayed releases before granting the next PC", async () => {
    const authority = new AccountClaimAuthority(file);
    await authority.request(acquire("PC A"));
    expect(await authority.request({ ...acquire("PC B"), action: "release" })).toMatchObject({ ok: false });
    const release = { ...acquire("PC A"), action: "release" as const };
    expect(await authority.request(release)).toMatchObject({ ok: true });
    await authority.request(acquire("PC B"));
    expect(await authority.request(release)).toMatchObject({ ok: false });
    expect(await authority.request(acquire("PC A"))).toMatchObject({ ok: false });
  });

  it("keeps durable ownership and release fencing ahead of late sync snapshots", async () => {
    const snapshots = [] as ReturnType<typeof createSyncAccountEnablement>[];
    const authority = new AccountClaimAuthority(file, () => snapshots);
    const first = await authority.request(acquire("PC A"));
    snapshots.push({ ...first.claim!, enabled: false, revision: 999, updatedAt: Date.now() + 1000 });
    expect(await authority.request(acquire("PC B"))).toMatchObject({ ok: false });
    expect(await authority.request(acquire("PC A"))).toMatchObject({ ok: true, claim: { enabled: true, revision: 1000 } });
    expect(await authority.request({ ...acquire("PC A"), action: "release" })).toMatchObject({ ok: true });
    snapshots[0] = { ...snapshots[0]!, enabled: true, revision: 1000 };
    expect(await authority.request(acquire("PC B"))).toMatchObject({ ok: true });
    expect(await authority.request({ ...acquire("PC A"), action: "release" })).toMatchObject({ ok: false });
  });

  it("honors existing enabled claims, allows stale takeover, and fails on corrupt/full storage", async () => {
    const current = createSyncAccountEnablement({
      accountId: "account",
      deviceId: "PC A",
      deviceName: "PC A",
      enabled: true,
      lastSyncedAt: Date.now()
    });
    const authority = new AccountClaimAuthority(file, () => [current]);
    expect(await authority.request(acquire("PC B"))).toMatchObject({ ok: false });
    current.lastSyncedAt = Date.now() - 3 * 60 * 60_000;
    expect(await authority.request(acquire("PC B"))).toMatchObject({ ok: true });
    await writeFile(file, "{partial");
    await expect(authority.request(acquire("PC A"))).rejects.toThrow();
    const full = new AccountClaimAuthority(file, () =>
      Array.from({ length: 1000 }, (_, index) =>
        createSyncAccountEnablement({
          accountId: `saved-${index}`,
          deviceId: "PC A",
          deviceName: "PC A",
          enabled: false
        })
      )
    );
    await writeFile(file, "[]");
    await expect(full.request(acquire("PC B"))).rejects.toThrow("full");
  });

  it("rejects expired requests and permits retry after storage repair", async () => {
    const authority = new AccountClaimAuthority(file);
    await expect(authority.request({ ...acquire("PC A"), sentAt: Date.now() - 150_000 })).rejects.toThrow("expired");
    await writeFile(file, "{}");
    await expect(authority.request(acquire("PC A"))).rejects.toThrow("invalid");
    await writeFile(file, "[]");
    expect(await authority.request(acquire("PC A"))).toMatchObject({ ok: true });
  });
});
