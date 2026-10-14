import { beforeEach, expect, it, vi } from "vitest";
import { ConversationShares, sharedConversationPage } from "../src/services/conversationShares";
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
  const page = sharedConversationPage(share!);
  expect(page).toContain("Read-only snapshot");
  expect(page).toContain("message-head");
  expect(page).toContain("Anyone with this link can view");
  expect(page).toContain("&lt;script&gt;"); expect(page).not.toContain("<script>");
  expect(page).not.toMatch(/<form|<button|api\/|secret|pc:thread/);
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
