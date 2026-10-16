import { beforeEach, expect, it, vi } from "vitest";
import { ConversationShares, sharedConversationPage } from "../src/services/conversationShares";
import * as coordination from "../src/utils/crossWindowOperations";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeTestDirectory } from "./testFilesystem";
let stored: Map<string, string>;
let secrets: { get: ReturnType<typeof vi.fn>; store: ReturnType<typeof vi.fn> };
let service: ConversationShares;
const input = (sessionKey = "pc:thread") => ({ sessionKey, title: "A <private> conversation", messages: [{ role: "user", text: "<script>alert(1)</script>" }, { role: "assistant", text: "Answer\nnext line", secret: "excluded" }] });
beforeEach(() => {
  stored = new Map();
  secrets = { get: vi.fn(async (key: string) => stored.get(key)), store: vi.fn(async (key: string, value: string) => { stored.set(key, value); }) };
  service = new ConversationShares(secrets);
});
it("publishes only escaped read-only messages and persists across a host restart", async () => {
  const { token } = await service.create(input());
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect([...stored.values()].join()).not.toContain(token);
  const share = await new ConversationShares(secrets).get(token);
  expect(share!.messages[1]).toEqual({ role: "assistant", text: "Answer\nnext line" });
  const page = sharedConversationPage(share!, token);
  expect(page).toContain("Read-only snapshot");
  expect(page).toContain("message-head");
  expect(page).toContain("Anyone with this link can view");
  expect(page).toContain("&lt;script&gt;"); expect(page).not.toContain("<script>");
  expect(page).not.toMatch(/<form|<button|secret|pc:thread/);
  expect(page).toContain("/assets/sharedConversation.js");
  expect(page).toContain("noindex,nofollow,noarchive");
});
it("replaces only this conversation's token, revokes persistently, and rejects malformed tokens", async () => {
  const first = await service.create(input()); const other = await service.create(input("other:thread"));
  const replacement = await service.create(input());
  expect(await service.get(first.token)).toBeUndefined(); expect(await service.get(other.token)).toBeDefined();
  expect(await service.get(replacement.token)).toBeDefined();
  await service.revoke("pc:thread"); expect(await new ConversationShares(secrets).get(replacement.token)).toBeUndefined();
  expect(await service.get("../../api/state")).toBeUndefined();
});
it("expires links after 30 days", async () => {
  const now = Date.now(); const { token } = await service.create(input());
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 31 * 86400000);
  try { expect(await service.get(token)).toBeUndefined(); } finally { clock.mockRestore(); }
});
it("does not return an unpersisted token and recovers after a storage failure", async () => {
  secrets.store.mockRejectedValueOnce(new Error("Storage full"));
  await expect(service.create(input())).rejects.toThrow("Storage full");
  expect(await service.get((await service.create(input())).token)).toBeDefined();
});
it("validates snapshots, bounds storage, and handles concurrent replacement without duplicate links", async () => {
  await expect(service.create({ ...input(), messages: [] })).rejects.toThrow("messages");
  await expect(service.create({ ...input(), messages: [{ role: "system", text: "private" }] })).rejects.toThrow("messages");
  await expect(service.create({ ...input(), messages: [{ role: "user", text: "a".repeat(256 * 1024) }] })).rejects.toThrow("too large");
  const [first, second] = await Promise.all([service.create(input()), service.create(input())]);
  expect(await service.get(first.token)).toBeUndefined(); expect(await service.get(second.token)).toBeDefined();
  for (let i = 1; i < 32; i++) await service.create(input(`pc:${i}`));
  await expect(service.create(input("pc:overflow"))).rejects.toThrow("full");
  await service.revoke("pc:1"); expect(await service.get((await service.create(input("pc:overflow"))).token)).toBeDefined();
});
it("rejects corrupt persisted storage rather than replacing existing shares", async () => {
  secrets.get.mockResolvedValue("not-json");
  await expect(service.create(input())).rejects.toThrow(); expect(secrets.store).not.toHaveBeenCalled();
});
it("ignores malformed saved records and partial live messages without breaking valid links", async () => {
  const { token } = await service.create(input());
  const key = "codexManager.conversationShares.v1";
  const records = JSON.parse(stored.get(key)!);
  stored.set(key, JSON.stringify([...records, null, {}, { ...records[0], messages: [null] }]));
  expect(await service.get(token)).toBeDefined();
  await service.refresh(token, [null, { role: "assistant", text: "updated" }] as never);
  expect((await service.get(token))?.messages).toEqual([{ role: "assistant", text: "updated" }]);
});

it("keeps links readable and revocable when live refresh would fill total share storage", async () => {
  const shares = await Promise.all(Array.from({ length: 9 }, (_, index) => service.create(input(`pc:${index}`))));
  for (const share of shares) await service.refresh(share.token, [{ role: "assistant", text: "x".repeat(240 * 1024) }]);
  expect(Buffer.byteLength(stored.get("codexManager.conversationShares.v1")!)).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect((await service.get(shares[8]!.token))?.messages[0]?.text).toBe(input().messages[0]!.text);
  await service.revoke("pc:8");
  expect(await service.get(shares[8]!.token)).toBeUndefined();
  expect(await new ConversationShares(secrets).get(shares[0]!.token)).toBeDefined();
});
it("bounds queued storage writes and resumes them after storage responds", async () => {
  let release: ((value: undefined) => void) | undefined;
  secrets.get.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = resolve; }));
  const pending = Array.from({ length: 16 }, () => service.create(input()));
  await expect(service.create(input())).rejects.toThrow("busy");
  await vi.waitFor(() => expect(release).toBeDefined()); release!(undefined);
  const results = await Promise.all(pending);
  expect(await service.get(results[0]!.token)).toBeUndefined();
  expect(await service.get(results.at(-1)!.token)).toBeDefined();
});

it("avoids unchanged refresh writes and lets owners revoke older overfull stores",async()=>{
  const shares=await Promise.all(Array.from({length:9},(_,n)=>service.create(input(`pc:${n}`))));
  const before=secrets.store.mock.calls.length;
  await service.refresh(shares[0]!.token,input().messages);
  expect(secrets.store).toHaveBeenCalledTimes(before);
  const key="codexManager.conversationShares.v1",records=JSON.parse(stored.get(key)!);
  for(const record of records)record.messages=[{role:"assistant",text:"x".repeat(240*1024)}];
  stored.set(key,JSON.stringify(records));
  await expect(service.get(shares[0]!.token)).rejects.toThrow("full");
  await service.revoke("pc:8");
  expect(await service.get(shares[0]!.token)).toBeDefined();
});

it("serializes independent hosts so a concurrent create and revoke preserve each other's changes",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"codex-share-coordination-"));
  const coordinator=new coordination.CrossWindowOperationCoordinator(root);
  const exclusive=vi.spyOn(coordination,"runCrossWindowExclusive").mockImplementation((key,label,work,options)=>coordinator.runExclusive(key,label,work,options));
  try {
    const old=await service.create(input());
    let finish!:()=>void;
    secrets.store.mockImplementationOnce(async(key,value)=>{await new Promise<void>(resolve=>{finish=resolve;});stored.set(key,value);});
    const other=new ConversationShares(secrets);
    const created=other.create(input("other:thread"));
    await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));
    const revoked=service.revoke("pc:thread");finish();
    const next=await created;await revoked;
    expect(await service.get(old.token)).toBeUndefined();expect(await other.get(next.token)).toBeDefined();
  } finally {exclusive.mockRestore();await removeTestDirectory(root);}
});
