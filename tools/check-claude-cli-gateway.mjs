import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const calls = [];
const models = [
  { id: "claude-opus-4-6", type: "model", display_name: "Claude Opus", description: "Codex Manager route" },
  { id: "claude-sonnet-4-6", type: "model", display_name: "Claude Sonnet", description: "Codex Manager route" },
  { id: "claude-haiku-4-5", type: "model", display_name: "Claude Haiku", description: "Codex Manager route" },
  { id: "claude-fable-5", type: "model", display_name: "Claude Fable", description: "Codex Manager route" }
];
const s = http.createServer((req, res) => {
  calls.push({ method: req.method, url: req.url, headers: req.headers });
  if (req.url?.startsWith("/v1/models")) {
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({ data: models, has_more: false, first_id: models[0].id, last_id: models.at(-1).id })
    );
  }
  if (req.url?.startsWith("/v1/messages")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.model !== "claude-sonnet-4-6") {
        res.writeHead(400);
        return res.end(
          JSON.stringify({ error: { type: "invalid_request_error", message: "unexpected model " + parsed.model } })
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const e = (type, data) => res.write("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n");
      e("message_start", {
        type: "message_start",
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: parsed.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 }
        }
      });
      e("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      e("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } });
      e("content_block_stop", { type: "content_block_stop", index: 0 });
      e("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 }
      });
      e("message_stop", { type: "message_stop" });
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => s.listen(0, "127.0.0.1", r));
const port = s.address().port;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-cli-gateway-"));
const child = spawn(
  process.env.ComSpec,
  [
    "/d",
    "/s",
    "/c",
    `claude --print --no-session-persistence --model claude-sonnet-4-6 --output-format text "Reply with exactly OK"`
  ],
  {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: "test-key",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: dir
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
);
let out = "",
  err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));
const code = await new Promise((r) => child.on("close", r));
await new Promise((r) => s.close(r));
console.log(
  JSON.stringify(
    {
      code,
      output: out.trim(),
      stderr: err.trim(),
      calls: calls.map((c) => ({
        method: c.method,
        url: c.url,
        auth: c.headers.authorization ?? c.headers["x-api-key"],
        anthropic: c.headers["anthropic-version"]
      }))
    },
    null,
    2
  )
);
if (
  code !== 0 ||
  !out.includes("OK") ||
  /isn't recognized|is not recognized/i.test(out + err) ||
  calls.filter((c) => c.url?.startsWith("/v1/messages")).length !== 1 ||
  calls.filter((c) => c.url?.startsWith("/v1/models")).length < 1 ||
  calls.find((c) => c.url?.startsWith("/v1/models"))?.headers["x-api-key"] !== "test-key"
)
  process.exit(1);
