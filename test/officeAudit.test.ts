import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { currentOfficeActor, officeActor, readOfficeAudit, recordOfficeAudit, recordSessionInitiator, withOfficeActor, withSessionInitiator } from "../src/services/officeAudit";
import { removeTestDirectory } from "./testFilesystem";

let root: string, store: SqliteStateStore;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-office-audit-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
});
afterEach(async () => { configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root); });
it("keeps the master sign-in identity out of audit and session display metadata", () => {
  const actor = officeActor({ id: "master", username: "manager-private-identifier", displayName: "Administrator" });
  withOfficeActor(actor, () => recordOfficeAudit("rotateMasterUsername", "completed"));
  expect(readOfficeAudit()[0]?.actor).toEqual({ id: "master", name: "Master" });
  expect(JSON.stringify(readOfficeAudit())).not.toContain("private-identifier");
});
it("keeps actors isolated across concurrent asynchronous actions", async () => {
  await Promise.all(["alex", "sam"].map(id => withOfficeActor({ id, name: id, email: `${id}@example.test` }, async () => {
    await Promise.resolve();
    expect(currentOfficeActor()?.id).toBe(id);
    recordOfficeAudit("startCodexCliSession", "completed", undefined, id);
    recordSessionInitiator(id);
  })));
  for (const entry of readOfficeAudit()) expect(entry.actor.id).toBe(entry.sessionId);
  expect(currentOfficeActor()).toBeUndefined();
});
it("preserves the creator while updating who last ran a session across database reopen", async () => {
  recordSessionInitiator("session", { id: "alex", name: "Alex" });
  recordSessionInitiator("session", { id: "sam", name: "Sam" });
  configureSqliteStateStore(undefined); store.close();
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
  expect(withSessionInitiator({ id: "session", title: "Task", status: "running" })).toMatchObject({ startedBy: { id: "alex" }, lastRunBy: { id: "sam" } });
  expect(withSessionInitiator({ id: "session", title: "Remote task", status: "running", remote: true }).startedBy).toBeUndefined();
});
it("bounds retained audit entries and records explicit storage failures", () => {
  for (let index = 0; index < 505; index++) recordOfficeAudit("action", "completed", { id: "alex", name: "Alex" });
  expect(readOfficeAudit()).toHaveLength(500);
});
