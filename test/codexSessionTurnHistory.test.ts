import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCodexCliSessionMessages, parseCodexAppServerThreadItems } from "../src/services/codexSessionResume";

describe("authoritative session turn identifiers", () => {
  it('merges a timestamped image mirror across missing turn metadata without merging another turn', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'codex-image-turn-history-'));
    const id = '01a04882-d037-7a42-ad24-9afb61901199';
    const file = path.join(home, 'sessions', `rollout-${id}.jsonl`);
    const timestamp = '2026-11-06T03:00:00Z';
    const event = { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Review this', images: ['data:image/png;base64,AA=='] } };
    const mirror = { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review this' }, { type: 'input_image', image_url: 'unavailable' }] } };
    try {
      await mkdir(path.dirname(file));
      await writeFile(file, JSON.stringify(event) + '\n');
      expect(await readCodexCliSessionMessages(id, home)).toHaveLength(1);
      await appendFile(file, [
        { type: 'turn_context', payload: { turn_id: 'turn-1' } }, mirror,
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
        { type: 'turn_context', payload: { turn_id: 'turn-2' } }, { ...event, timestamp: '2026-11-06T03:01:00Z' }
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      const messages = await readCodexCliSessionMessages(id, home);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ text: 'Review this', turnId: 'turn-1', images: [{ src: 'data:image/png;base64,AA==' }] });
      expect(messages[1]).toMatchObject({ text: 'Review this', turnId: 'turn-2' });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("annotates app-server items and turn errors", () => {
    expect(parseCodexAppServerThreadItems({ thread: { turns: [{ id: "turn-1", status: "failed", items: [{ id: "reply", type: "agentMessage", text: "reply" }], error: { message: "failed" } }] } })).toEqual([
      expect.objectContaining({ id: "reply", turnId: "turn-1" }), expect.objectContaining({ kind: "error", turnId: "turn-1" })
    ]);
  });

  it("renders native compaction markers once without displaying replacement history", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-compaction-history-"));
    const id = "01a04882-d037-7a42-ad24-9afb61901199";
    const file = path.join(home, "sessions", `rollout-${id}.jsonl`);
    try {
      await mkdir(path.dirname(file));
      await writeFile(file, [
        { type: "turn_context", payload: { turn_id: "turn-1" } },
        { type: "compacted", payload: { message: "private replacement history" } },
        { type: "event_msg", payload: { type: "context_compacted" } }
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
      const messages = await readCodexCliSessionMessages(id, home);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ kind: "compaction", status: "completed", title: "Context compacted", turnId: "turn-1" });
      expect(JSON.stringify(messages)).not.toContain("private replacement history");
      await appendFile(file, JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } }) + "\n");
      expect(await readCodexCliSessionMessages(id, home)).toHaveLength(2);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("retains turn context across incremental JSONL reads without merging identical prompts across turns", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-turn-history-"));
    const id = "01a04882-d037-7a42-ad24-9afb61901199";
    const file = path.join(home, "sessions", `rollout-${id}.jsonl`);
    const message = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    try {
      await mkdir(path.dirname(file));
      await writeFile(file, `${JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-1" } })}\n${JSON.stringify(message("same prompt"))}\n`);
      expect(await readCodexCliSessionMessages(id, home)).toEqual([expect.objectContaining({ text: "same prompt", turnId: "turn-1" })]);
      await appendFile(file, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } })}\n${JSON.stringify(message("same prompt"))}\n`);
      expect(await readCodexCliSessionMessages(id, home)).toEqual([
        expect.objectContaining({ text: "same prompt", turnId: "turn-1" }), expect.objectContaining({ text: "same prompt", turnId: "turn-2" })
      ]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
