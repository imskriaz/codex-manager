import { randomUUID } from "node:crypto";

type Json = Record<string, unknown>;
export type AiProtocol = "chat" | "responses" | "claude";
export class AiProxyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "invalid_request_error"
  ) {
    super(message);
  }
}
export function object(value: unknown, label = "value"): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AiProxyError(400, `${label} must be an object.`);
  return value as Json;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length) throw new AiProxyError(400, `${label} must be a nonempty string.`);
  return value;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new AiProxyError(400, `${label} must be an array with at most 1000 items.`);
  return value;
}
function image(value: unknown): string {
  const url = string(value, "image URL");
  if (!/^https:\/\/[^\s]+$/i.test(url) && !/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=\r\n]+$/i.test(url))
    throw new AiProxyError(400, "Images require an HTTPS URL or a base64 image.");
  return url;
}
function content(value: unknown, assistant: boolean, claude: boolean): Json[] {
  if (typeof value === "string") return [{ type: assistant ? "output_text" : "input_text", text: value }];
  return array(value, "message content").map((raw) => {
    const part = object(raw, "content block");
    if (part["type"] === "text" || part["type"] === "input_text" || part["type"] === "output_text")
      return { type: assistant ? "output_text" : "input_text", text: string(part["text"], "text") };
    if (!assistant && part["type"] === "image_url")
      return {
        type: "input_image",
        image_url: image(object(part["image_url"])["url"]),
        ...(object(part["image_url"])["detail"] ? { detail: object(part["image_url"])["detail"] } : {})
      };
    if (!assistant && part["type"] === "input_image")
      return { type: "input_image", image_url: image(part["image_url"]) };
    if (!assistant && claude && part["type"] === "image") {
      const source = object(part["source"], "image source");
      return {
        type: "input_image",
        image_url: image(
          source["type"] === "url"
            ? source["url"]
            : source["type"] === "base64"
              ? `data:${string(source["media_type"], "media_type")};base64,${string(source["data"], "image data")}`
              : undefined
        )
      };
    }
    throw new AiProxyError(400, `Unsupported content block: ${String(part["type"])}.`);
  });
}
function tool(raw: unknown, claude: boolean): Json {
  const entry = object(raw, "tool");
  if (!claude && entry["type"] !== "function")
    throw new AiProxyError(400, "Only client-executed function tools are supported.");
  const fn = !claude && entry["function"] ? object(entry["function"]) : entry;
  const name = string(fn["name"], "tool name");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new AiProxyError(400, "Invalid function name.");
  return {
    type: "function",
    name,
    ...(fn["description"] !== undefined ? { description: string(fn["description"], "tool description") } : {}),
    parameters: object(
      claude ? fn["input_schema"] : (fn["parameters"] ?? { type: "object", properties: {} }),
      "tool parameters"
    ),
    ...(typeof fn["strict"] === "boolean" ? { strict: fn["strict"] } : {})
  };
}
export function normalizeAiRequest(
  raw: unknown,
  protocol: AiProtocol
): { body: Json; stream: boolean; includeUsage: boolean } {
  const request = object(raw, "request");
  const allowed =
    protocol === "responses"
      ? [
          "model",
          "input",
          "instructions",
          "tools",
          "tool_choice",
          "parallel_tool_calls",
          "reasoning",
          "text",
          "stream",
          "store",
          "max_output_tokens",
          "metadata",
          "include",
          "user",
          "service_tier"
        ]
      : protocol === "chat"
        ? [
            "model",
            "messages",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "reasoning_effort",
            "response_format",
            "stream",
            "stream_options",
            "max_tokens",
            "max_completion_tokens",
            "temperature",
            "top_p",
            "n",
            "stop",
            "user",
            "metadata",
            "service_tier"
          ]
        : [
            "model",
            "messages",
            "system",
            "tools",
            "tool_choice",
            "stream",
            "max_tokens",
            "temperature",
            "top_p",
            "stop_sequences",
            "metadata",
            "thinking",
            "output_config"
          ];
  for (const key of Object.keys(request))
    if (!allowed.includes(key)) throw new AiProxyError(400, `Unsupported parameter: ${key}.`);
  const model = string(request["model"], "model");
  if (!/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(model))
    throw new AiProxyError(400, "Invalid model identifier. Use GET /v1/models.");
  if (request["stream"] !== undefined && typeof request["stream"] !== "boolean")
    throw new AiProxyError(400, "stream must be a boolean.");
  if (request["n"] !== undefined && request["n"] !== 1) throw new AiProxyError(400, "Only n=1 is supported.");
  for (const key of ["temperature", "top_p", "stop", "stop_sequences", "thinking", "output_config"])
    if (request[key] !== undefined)
      throw new AiProxyError(400, `${key} is not supported by the saved-account Codex backend.`);
  if (request["store"] !== undefined && request["store"] !== false)
    throw new AiProxyError(400, "The saved-account backend requires store=false.");
  const input: Json[] = [],
    instructions: string[] = [];
  if (protocol === "responses") {
    if (typeof request["instructions"] === "string") instructions.push(request["instructions"]);
    else if (request["instructions"] !== undefined) throw new AiProxyError(400, "instructions must be a string.");
    if (typeof request["input"] === "string")
      input.push({ role: "user", content: content(request["input"], false, false) });
    else
      for (const rawItem of array(request["input"], "input")) {
        const item = object(rawItem, "input item");
        if (item["type"] === "function_call")
          input.push({
            type: "function_call",
            call_id: string(item["call_id"], "call_id"),
            name: string(item["name"], "name"),
            arguments: string(item["arguments"], "arguments")
          });
        else if (item["type"] === "function_call_output")
          input.push({
            type: "function_call_output",
            call_id: string(item["call_id"], "call_id"),
            output: string(item["output"], "output")
          });
        else {
          const role = string(item["role"], "role");
          if (!["system", "developer", "user", "assistant"].includes(role))
            throw new AiProxyError(400, "Invalid message role.");
          if (role === "system" || role === "developer")
            instructions.push(
              content(item["content"], false, false)
                .map((part) => part["text"])
                .join("\n")
            );
          else input.push({ role, content: content(item["content"], role === "assistant", false) });
        }
      }
  } else {
    if (protocol === "claude" && request["system"] !== undefined)
      instructions.push(
        content(request["system"], false, true)
          .map((part) => part["text"])
          .join("\n")
      );
    for (const rawMessage of array(request["messages"], "messages")) {
      const message = object(rawMessage, "message"),
        role = string(message["role"], "role");
      if (!["user", "assistant", ...(protocol === "chat" ? ["system", "developer", "tool"] : [])].includes(role))
        throw new AiProxyError(400, "Invalid message role.");
      if (role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: string(message["tool_call_id"], "tool_call_id"),
          output: string(message["content"], "tool content")
        });
        continue;
      }
      if (role === "system" || role === "developer") {
        instructions.push(
          content(message["content"], false, false)
            .map((part) => part["text"])
            .join("\n")
        );
        continue;
      }
      if (protocol === "claude" && Array.isArray(message["content"])) {
        let parts: unknown[] = [];
        const flush = () => {
          if (parts.length) {
            input.push({ role, content: content(parts, role === "assistant", true) });
            parts = [];
          }
        };
        for (const rawPart of message["content"]) {
          const part = object(rawPart);
          if (part["type"] === "tool_use") {
            flush();
            if (role !== "assistant") throw new AiProxyError(400, "tool_use requires an assistant message.");
            input.push({
              type: "function_call",
              call_id: string(part["id"], "tool id"),
              name: string(part["name"], "tool name"),
              arguments: JSON.stringify(object(part["input"], "tool input"))
            });
          } else if (part["type"] === "tool_result") {
            flush();
            if (role !== "user") throw new AiProxyError(400, "tool_result requires a user message.");
            input.push({
              type: "function_call_output",
              call_id: string(part["tool_use_id"], "tool_use_id"),
              output:
                typeof part["content"] === "string"
                  ? part["content"]
                  : content(part["content"], false, true)
                      .map((p) => {
                        if (p["type"] !== "input_text") throw new AiProxyError(400, "Tool results require text.");
                        return p["text"];
                      })
                      .join("\n")
            });
          } else parts.push(part);
        }
        flush();
      } else if (message["content"] !== null && message["content"] !== undefined)
        input.push({ role, content: content(message["content"], role === "assistant", false) });
      if (message["tool_calls"] !== undefined)
        for (const rawCall of array(message["tool_calls"], "tool_calls")) {
          const call = object(rawCall),
            fn = object(call["function"]);
          if (role !== "assistant" || call["type"] !== "function")
            throw new AiProxyError(400, "Only assistant function tool calls are supported.");
          input.push({
            type: "function_call",
            call_id: string(call["id"], "tool call id"),
            name: string(fn["name"], "function name"),
            arguments: string(fn["arguments"], "function arguments")
          });
        }
    }
  }
  if (!input.length) throw new AiProxyError(400, "Provide at least one user message or tool result.");
  const body: Json = { model, input, instructions: instructions.join("\n\n"), stream: true, store: false };
  if (request["tools"] !== undefined)
    body["tools"] = array(request["tools"], "tools").map((entry) => tool(entry, protocol === "claude"));
  if (request["tool_choice"] !== undefined) {
    const choice = request["tool_choice"];
    if (typeof choice === "string" && ["auto", "none", "required"].includes(choice)) body["tool_choice"] = choice;
    else {
      const chosen = object(choice, "tool_choice");
      const type = chosen["type"];
      if (protocol === "claude" && (type === "auto" || type === "any" || type === "none"))
        body["tool_choice"] = type === "any" ? "required" : type;
      else if (type === "tool" || type === "function")
        body["tool_choice"] = {
          type: "function",
          name: string(chosen["name"] ?? (chosen["function"] && object(chosen["function"])["name"]), "tool choice name")
        };
      else throw new AiProxyError(400, "Unsupported tool_choice.");
    }
  }
  if (request["parallel_tool_calls"] !== undefined) {
    if (typeof request["parallel_tool_calls"] !== "boolean")
      throw new AiProxyError(400, "parallel_tool_calls must be a boolean.");
    body["parallel_tool_calls"] = request["parallel_tool_calls"];
  }
  if (request["reasoning_effort"] !== undefined)
    body["reasoning"] = { effort: string(request["reasoning_effort"], "reasoning_effort") };
  else if (request["reasoning"] !== undefined) body["reasoning"] = object(request["reasoning"], "reasoning");
  if (request["text"] !== undefined) body["text"] = object(request["text"], "text");
  if (request["response_format"] !== undefined) {
    const format = object(request["response_format"], "response_format");
    body["text"] = {
      format:
        format["type"] === "json_schema"
          ? { type: "json_schema", ...object(format["json_schema"], "json_schema") }
          : format
    };
  }
  const max = request["max_output_tokens"] ?? request["max_completion_tokens"] ?? request["max_tokens"];
  if (max !== undefined) {
    if (!Number.isSafeInteger(max) || (max as number) < 1 || (max as number) > 1_000_000)
      throw new AiProxyError(400, "Token limit must be a positive integer up to 1000000.");
    body["max_output_tokens"] = max;
  }
  if (protocol === "claude" && max === undefined) throw new AiProxyError(400, "max_tokens is required.");
  if (request["include"] !== undefined) {
    const include = array(request["include"], "include");
    if (include.some((value) => value !== "reasoning.encrypted_content"))
      throw new AiProxyError(400, "Unsupported include value.");
    body["include"] = include;
  }
  if (request["service_tier"] !== undefined) body["service_tier"] = string(request["service_tier"], "service_tier");
  if (
    request["stream_options"] !== undefined &&
    (protocol !== "chat" || typeof object(request["stream_options"])["include_usage"] !== "boolean")
  )
    throw new AiProxyError(400, "Use stream_options.include_usage=true or false.");
  return {
    body,
    stream: request["stream"] === true,
    includeUsage:
      protocol === "chat" &&
      request["stream_options"] !== undefined &&
      object(request["stream_options"])["include_usage"] === true
  };
}

export function aiUsage(response: Json) {
  const usage = response["usage"] ? object(response["usage"]) : undefined;
  const input = typeof usage?.["input_tokens"] === "number" ? usage["input_tokens"] : 0,
    output = typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : 0;
  const cached = usage?.["input_tokens_details"] && object(usage["input_tokens_details"])["cached_tokens"];
  return { input, output, cached: typeof cached === "number" ? cached : 0 };
}
export function completedAiResponse(response: Json, protocol: AiProtocol, fallbackModel: string): Json {
  if (protocol === "responses") return response;
  const output = Array.isArray(response["output"]) ? response["output"].map((item) => object(item)) : [];
  const text = output
    .filter((item) => item["type"] === "message")
    .flatMap((item) => (Array.isArray(item["content"]) ? item["content"].map((part) => object(part)) : []))
    .filter((part) => part["type"] === "output_text" || part["type"] === "refusal")
    .map((part) => part["text"] ?? part["refusal"])
    .join("");
  const tools = output.filter((item) => item["type"] === "function_call"),
    usage = aiUsage(response);
  const model = typeof response["model"] === "string" ? response["model"] : fallbackModel;
  const id = typeof response["id"] === "string" ? response["id"] : randomUUID();
  const limited = response["status"] === "incomplete";
  if (protocol === "chat")
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text || (tools.length ? null : ""),
            ...(tools.length
              ? {
                  tool_calls: tools.map((item) => ({
                    id: item["call_id"],
                    type: "function",
                    function: { name: item["name"], arguments: item["arguments"] }
                  }))
                }
              : {})
          },
          finish_reason: tools.length ? "tool_calls" : limited ? "length" : "stop",
          logprobs: null
        }
      ],
      usage: {
        prompt_tokens: usage.input,
        completion_tokens: usage.output,
        total_tokens: usage.input + usage.output,
        prompt_tokens_details: { cached_tokens: usage.cached }
      }
    };
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...tools.map((item) => {
        let input: unknown;
        try {
          input = JSON.parse(String(item["arguments"]));
        } catch {
          throw new AiProxyError(502, "The backend returned invalid tool arguments.", "api_error");
        }
        return { type: "tool_use", id: item["call_id"], name: item["name"], input };
      })
    ],
    stop_reason: tools.length ? "tool_use" : limited ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, usage.input - usage.cached),
      output_tokens: usage.output,
      cache_read_input_tokens: usage.cached,
      cache_creation_input_tokens: 0
    }
  };
}

/** Translate deltas as they arrive; client tools are returned, never executed here. */
export class AiStream {
  private readonly id = `msg_${randomUUID()}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private started = false;
  private blocks = new Map<number, { index: number; tool: boolean; closed: boolean }>();
  private textBlock?: { index: number; closed: boolean };
  private nextBlock = 0;
  private toolIndex = 0;
  private tools = new Map<number, number>();
  constructor(
    private readonly protocol: AiProtocol,
    private readonly model: string,
    private readonly includeUsage: boolean
  ) {}
  private chat(delta: Json, finish: string | null = null): string {
    return `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] })}\n\n`;
  }
  private claude(type: string, data: Json): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  }
  event(event: Json): string {
    if (this.protocol === "responses") return `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`;
    let wire = "";
    if (!this.started) {
      this.started = true;
      wire +=
        this.protocol === "chat"
          ? this.chat({ role: "assistant", content: "" })
          : this.claude("message_start", {
              message: {
                id: this.id,
                type: "message",
                role: "assistant",
                model: this.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
              }
            });
    }
    const type = event["type"],
      outputIndex = typeof event["output_index"] === "number" ? event["output_index"] : 0;
    if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      if (typeof event["delta"] !== "string")
        throw new AiProxyError(502, "Invalid text delta from backend.", "api_error");
      if (this.protocol === "chat") wire += this.chat({ content: event["delta"] });
      else {
        if (!this.textBlock || this.textBlock.closed) {
          this.textBlock = { index: this.nextBlock++, closed: false };
          wire += this.claude("content_block_start", {
            index: this.textBlock.index,
            content_block: { type: "text", text: "" }
          });
        }
        wire += this.claude("content_block_delta", {
          index: this.textBlock.index,
          delta: { type: "text_delta", text: event["delta"] }
        });
      }
    } else if (type === "response.output_item.added" && object(event["item"])["type"] === "function_call") {
      const item = object(event["item"]);
      if (this.protocol === "chat") {
        const index = this.toolIndex++;
        this.tools.set(outputIndex, index);
        wire += this.chat({
          tool_calls: [
            { index, id: item["call_id"], type: "function", function: { name: item["name"], arguments: "" } }
          ]
        });
      } else {
        const block = { index: this.nextBlock++, tool: true, closed: false };
        this.blocks.set(outputIndex, block);
        wire += this.claude("content_block_start", {
          index: block.index,
          content_block: { type: "tool_use", id: item["call_id"], name: item["name"], input: {} }
        });
      }
    } else if (type === "response.function_call_arguments.delta") {
      if (typeof event["delta"] !== "string")
        throw new AiProxyError(502, "Invalid tool delta from backend.", "api_error");
      if (this.protocol === "chat") {
        const index = this.tools.get(outputIndex);
        if (index === undefined) throw new AiProxyError(502, "Tool delta arrived without a tool.", "api_error");
        wire += this.chat({ tool_calls: [{ index, function: { arguments: event["delta"] } }] });
      } else {
        const block = this.blocks.get(outputIndex);
        if (!block || block.closed)
          throw new AiProxyError(502, "Tool delta arrived without an active tool.", "api_error");
        wire += this.claude("content_block_delta", {
          index: block.index,
          delta: { type: "input_json_delta", partial_json: event["delta"] }
        });
      }
    } else if (type === "response.output_item.done" && this.protocol === "claude") {
      const block = this.blocks.get(outputIndex);
      if (block && !block.closed) {
        block.closed = true;
        wire += this.claude("content_block_stop", { index: block.index });
      } else if (this.textBlock && !this.textBlock.closed) {
        this.textBlock.closed = true;
        wire += this.claude("content_block_stop", { index: this.textBlock.index });
      }
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = object(event["response"]),
        usage = aiUsage(response);
      const tools = (Array.isArray(response["output"]) ? response["output"] : []).some(
        (item) => object(item)["type"] === "function_call"
      );
      if (this.protocol === "chat") {
        wire += this.chat({}, tools ? "tool_calls" : type === "response.incomplete" ? "length" : "stop");
        if (this.includeUsage)
          wire += `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, prompt_tokens_details: { cached_tokens: usage.cached } } })}\n\n`;
        wire += "data: [DONE]\n\n";
      } else {
        if (this.textBlock && !this.textBlock.closed) {
          this.textBlock.closed = true;
          wire += this.claude("content_block_stop", { index: this.textBlock.index });
        }
        for (const block of this.blocks.values())
          if (!block.closed) {
            block.closed = true;
            wire += this.claude("content_block_stop", { index: block.index });
          }
        wire += this.claude("message_delta", {
          delta: {
            stop_reason: tools ? "tool_use" : type === "response.incomplete" ? "max_tokens" : "end_turn",
            stop_sequence: null
          },
          usage: {
            input_tokens: Math.max(0, usage.input - usage.cached),
            output_tokens: usage.output,
            cache_read_input_tokens: usage.cached,
            cache_creation_input_tokens: 0
          }
        });
        wire += this.claude("message_stop", {});
      }
    }
    return wire;
  }
}
