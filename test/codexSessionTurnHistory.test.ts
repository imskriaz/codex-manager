import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCodexCliSessionMessages, parseCodexAppServerThreadItems } from "../src/services/codexSessionResume";

describe("authoritative session turn identifiers", () => {
  it("annotates app-server items and turn errors", () => {
    expect(parseCodexAppServerThreadItems({ thread: { turns: [{ id: "turn-1", status: "failed", items: [{ id: "reply", type: "agentMessage", text: "reply" }], error: { message: "failed" } }] } })).toEqual([
      expect.objectContaining({ id: "reply", turnId: "turn-1" }), expect.objectContaining({ kind: "error", turnId: "turn-1" })
    ]);
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
