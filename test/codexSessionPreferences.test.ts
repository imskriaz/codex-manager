import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { isCodexSessionAutoResumeDisabled, orderCodexSessionRecoveryIds, readCodexSessionPreferences, readCodexSessionTitleOverrides, writeCodexSessionPreference, writeCodexSessionTitleOverride } from "../src/services/codexSessionPreferences";

const ids = [
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  "cccccccc-cccc-cccc-cccc-cccccccccccc"
];
let root: string | undefined;
let store: SqliteStateStore | undefined;

afterEach(async () => {
  configureSqliteStateStore(undefined);
  store?.close();
  store = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it("persists per-session recovery state and orders queued sessions after immediate work", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-session-preferences-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
  writeCodexSessionPreference(root, ids[0]!, { autoResume: false });
  writeCodexSessionPreference(root, ids[1]!, { queue: true, priority: 1 });
  writeCodexSessionPreference(root, ids[2]!, { queue: true, priority: 2 });
  expect(isCodexSessionAutoResumeDisabled(root, ids[0]!)).toBe(true);
  expect(readCodexSessionPreferences(root, ids).get(ids[1]!)?.priority).toBe(1);
  expect(orderCodexSessionRecoveryIds(root, ids)).toEqual([ids[0], ids[1], ids[2]]);
});

it("retains a just-renamed title across a catalogue refresh", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-session-preferences-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
  writeCodexSessionTitleOverride(root, ids[0]!, "Fresh title");
  expect(readCodexSessionTitleOverrides(root, ids).get(ids[0]!)).toBe("Fresh title");
});
