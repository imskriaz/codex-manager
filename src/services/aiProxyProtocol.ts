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
function textString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new AiProxyError(400, `${label} must be a string.`);
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
      return { type: assistant ? "output_text" : "input_text", text: textString(part["text"], "text") };
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
function instruction(value: unknown): string {
  const parts = content(value, false, true);
  if (parts.some((part) => part["type"] !== "input_text"))
    throw new AiProxyError(400, "System content supports text blocks only.");
  return parts.map((part) => part["text"] as string).join("\n");
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
    ...(fn["description"] !== undefined ? { description: textString(fn["description"], "tool description") } : {}),
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
): { body: Json; stream: boolean; includeUsage: boolean; omitThinking: boolean } {
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
            "context_management",
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
  for (const key of ["temperature", "top_p", "stop", "stop_sequences"])
    if (request[key] !== undefined)
      throw new AiProxyError(400, `${key} is not supported by the saved-account Codex backend.`);
  if (protocol === "claude") {
    // Claude Code sends gateway controls alongside every request. Validate their shape and omit them.
    if (request["thinking"] !== undefined) object(request["thinking"], "thinking");
    const thinkingConfig = request["thinking"] === undefined ? undefined : object(request["thinking"], "thinking");
    const thinkingType = thinkingConfig?.["type"];
    if (thinkingType !== undefined && (typeof thinkingType !== "string" || !["adaptive", "enabled", "disabled", "between_tools"].includes(thinkingType)))
      throw new AiProxyError(400, "thinking.type must be adaptive, enabled, disabled, or between_tools.");
    if (thinkingType === "enabled") {
      const budget = thinkingConfig?.["budget_tokens"], maxTokens = request["max_tokens"];
      if (!Number.isSafeInteger(budget) || (budget as number) < 1024 || (typeof maxTokens === "number" && (budget as number) >= maxTokens))
        throw new AiProxyError(400, "thinking.budget_tokens must be an integer >= 1024 and less than max_tokens.");
    } else if (thinkingConfig?.["budget_tokens"] !== undefined)
      throw new AiProxyError(400, "thinking.budget_tokens is only valid with thinking.type=enabled.");
    const display = thinkingConfig?.["display"];
    if (display !== undefined && display !== null && display !== "omitted" && display !== "summarized" && display !== "updates")
      throw new AiProxyError(400, "thinking.display must be omitted, summarized, or updates.");
    if (request["context_management"] !== undefined) {
      const context = object(request["context_management"], "context_management");
      for (const key of Object.keys(context))
        if (key !== "edits") throw new AiProxyError(400, `Unsupported context_management parameter: ${key}.`);
      if (context["edits"] !== undefined) for (const edit of array(context["edits"], "context_management.edits"))
        if (object(edit)["type"] !== "clear_thinking_20251015")
          throw new AiProxyError(400, "This backend supports only clear_thinking context management.");
    }
    if (request["output_config"] !== undefined) {
      const outputConfig = object(request["output_config"], "output_config");
      if (outputConfig["effort"] !== undefined) {
        const effort = string(outputConfig["effort"], "output_config.effort");
        if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
          throw new AiProxyError(400, "output_config.effort must be low, medium, high, xhigh, or max.");
      }
    }
  } else {
    for (const key of ["thinking", "output_config"])
      if (request[key] !== undefined)
        throw new AiProxyError(400, `${key} is not supported by the saved-account Codex backend.`);
  }
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
          output: textString(item["output"], "output")
          });
        else {
          const role = string(item["role"], "role");
          if (!["system", "developer", "user", "assistant"].includes(role))
            throw new AiProxyError(400, "Invalid message role.");
          if (role === "system" || role === "developer")
            instructions.push(instruction(item["content"]));
          else input.push({ role, content: content(item["content"], role === "assistant", false) });
        }
      }
  } else {
    if (protocol === "claude" && request["system"] !== undefined)
      instructions.push(instruction(request["system"]));
    for (const rawMessage of array(request["messages"], "messages")) {
      const message = object(rawMessage, "message"),
        role = string(message["role"], "role");
      if (!["user", "assistant", ...(protocol === "chat" ? ["system", "developer", "tool"] : [])].includes(role))
        throw new AiProxyError(400, "Invalid message role.");
      if (role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: string(message["tool_call_id"], "tool_call_id"),
          output: textString(message["content"], "tool content")
        });
        continue;
      }
      if (role === "system" || role === "developer") {
        instructions.push(instruction(message["content"]));
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
            if (part["is_error"] !== undefined && typeof part["is_error"] !== "boolean")
              throw new AiProxyError(400, "tool_result.is_error must be a boolean.");
            const resultParts =
              part["content"] === undefined || typeof part["content"] === "string"
                ? undefined
                : content(part["content"], false, true).map((p) => {
                    if (p["type"] !== "input_text" && p["type"] !== "input_image")
                      throw new AiProxyError(400, "Tool results require text or images.");
                    return p;
                  });
            const textParts = resultParts
              ?.filter((p) => p["type"] === "input_text")
              .map((p) => (typeof p["text"] === "string" ? p["text"] : ""));
            const imageParts = resultParts?.filter((p) => p["type"] === "input_image");
            const outputText = textParts?.join("\n") ?? textString(part["content"] ?? "", "tool content");
            const output = part["is_error"] === true ? `[Tool error]\n${outputText}` : outputText;
            input.push({
              type: "function_call_output",
              call_id: string(part["tool_use_id"], "tool_use_id"),
              output
            });
            if (imageParts?.length) {
              input.push({
                role: "user",
                content: [
                  { type: "input_text", text: `Tool result ${string(part["tool_use_id"], "tool_use_id")} included an image.` },
                  ...imageParts
                ]
              });
            }
          } else if (part["type"] !== "thinking" && part["type"] !== "redacted_thinking") parts.push(part);
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
  // Validate client metadata for a stable boundary, but do not forward it: the saved-account
  // Codex bridge rejects Anthropic metadata fields and has no equivalent attribution contract.
  if (request["metadata"] !== undefined) object(request["metadata"], "metadata");
  if (request["tools"] !== undefined)
    body["tools"] = array(request["tools"], "tools").map((entry) => tool(entry, protocol === "claude"));
  if (request["tool_choice"] !== undefined) {
    const choice = request["tool_choice"];
    if (typeof choice === "string" && ["auto", "none", "required"].includes(choice)) body["tool_choice"] = choice;
    else {
      const chosen = object(choice, "tool_choice");
      const type = chosen["type"];
      if (protocol === "claude" && chosen["disable_parallel_tool_use"] !== undefined) {
        if (typeof chosen["disable_parallel_tool_use"] !== "boolean")
          throw new AiProxyError(400, "disable_parallel_tool_use must be a boolean.");
        body["parallel_tool_calls"] = !chosen["disable_parallel_tool_use"];
      }
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
  if (protocol === "claude" && request["output_config"] !== undefined) {
    const config = object(request["output_config"], "output_config"), effort = config["effort"];
    for (const key of Object.keys(config))
      if (key !== "effort" && key !== "format") throw new AiProxyError(400, `Unsupported output_config parameter: ${key}.`);
    if (effort !== undefined) body["reasoning"] = { effort: string(effort, "output_config.effort") };
    if (config["format"] !== undefined) {
      const format = object(config["format"], "output_config.format");
      if (format["type"] !== "json_schema") throw new AiProxyError(400, "output_config.format requires json_schema.");
      body["text"] = { format: { type: "json_schema", name: "response", schema: object(format["schema"], "output_config.format.schema"), strict: true } };
    }
  }
  if (protocol === "claude" && body["reasoning"] === undefined && request["thinking"] !== undefined) {
    const thinkingType = object(request["thinking"], "thinking")["type"];
    if (thinkingType === "adaptive" || thinkingType === "enabled" || thinkingType === "between_tools") body["reasoning"] = { effort: "high" };
  }
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
      object(request["stream_options"])["include_usage"] === true,
    omitThinking: protocol === "claude" && request["thinking"] !== undefined && object(request["thinking"])["display"] === "omitted"
  };
}

export function aiUsage(response: Json) {
  const usage = response["usage"] ? object(response["usage"]) : undefined;
  const tokenCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const input = tokenCount(usage?.["input_tokens"]), output = tokenCount(usage?.["output_tokens"]);
  const cached = usage?.["input_tokens_details"] && object(usage["input_tokens_details"])["cached_tokens"];
  return { input, output, cached: Math.min(input, tokenCount(cached)) };
}
export function completedAiResponse(response: Json, protocol: AiProtocol, fallbackModel: string, omitThinking = false): Json {
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
  const reasoning = output.filter((item) => item["type"] === "reasoning")
    .flatMap((item) => Array.isArray(item["summary"]) ? item["summary"] as unknown[] : [])
    .map((part) => object(part)["text"])
    .filter((value): value is string => typeof value === "string").join("\n");
  const claudeContent: Json[] = [];
  for (const item of output) {
    if (item["type"] === "message" && Array.isArray(item["content"])) {
      for (const raw of item["content"]) {
        const part = object(raw);
        if (part["type"] === "output_text" || part["type"] === "refusal")
          claudeContent.push({ type: "text", text: part["text"] ?? part["refusal"] });
      }
    } else if (item["type"] === "function_call") {
      let input: unknown;
      try {
        input = JSON.parse(textString(item["arguments"], "tool arguments"));
        object(input, "tool arguments");
        string(item["call_id"], "tool call id");
        string(item["name"], "tool name");
      } catch {
        throw new AiProxyError(502, "The backend returned invalid tool arguments or identity.", "api_error");
      }
      claudeContent.push({ type: "tool_use", id: item["call_id"], name: item["name"], input });
    } else if (!omitThinking && item["type"] === "reasoning" && Array.isArray(item["summary"])) {
      for (const raw of item["summary"]) {
        const summary = object(raw)["text"];
        if (typeof summary === "string") claudeContent.push({ type: "thinking", thinking: summary });
      }
    }
  }
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
            ...(reasoning ? { reasoning_content: reasoning } : {}),
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
          finish_reason: limited ? "length" : tools.length ? "tool_calls" : "stop",
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
    content: claudeContent,
    stop_reason: limited ? "max_tokens" : tools.length ? "tool_use" : "end_turn",
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
  private textOutputIndex?: number;
  private thinkingBlock?: { index: number; closed: boolean };
  private nextBlock = 0;
  private toolIndex = 0;
  private tools = new Map<number, number>();
  private toolArguments = new Map<number, string>();
  private toolIds = new Map<string, number>();
  private textDeltas = new Map<number, string>();
  constructor(
    private readonly protocol: AiProtocol,
    private readonly model: string,
    private readonly includeUsage: boolean,
    private readonly omitThinking = false
  ) {}
  private chat(delta: Json, finish: string | null = null): string {
    return `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] })}\n\n`;
  }
  private claude(type: string, data: Json): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  }
  private closeThinking(): string {
    if (!this.thinkingBlock || this.thinkingBlock.closed || this.protocol !== "claude") return "";
    this.thinkingBlock.closed = true;
    return this.claude("content_block_stop", { index: this.thinkingBlock.index });
  }
  private closeText(): string {
    if (!this.textBlock || this.textBlock.closed || this.protocol !== "claude") return "";
    this.textBlock.closed = true;
    return this.claude("content_block_stop", { index: this.textBlock.index });
  }
  private finishTool(event: Json, outputIndex: number): string {
    const item = event["item"] ? object(event["item"]) : undefined;
    if (!item || item["type"] !== "function_call" || item["arguments"] === undefined) return "";
    if (typeof item["call_id"] === "string") outputIndex = this.toolIds.get(item["call_id"]) ?? outputIndex;
    const full = textString(item["arguments"], "tool arguments");
    const previous = this.toolArguments.get(outputIndex);
    if (previous === undefined) return this.event({ type: "response.output_item.added", output_index: outputIndex, item: { ...item, arguments: "" } }) + this.event({ type: "response.function_call_arguments.delta", output_index: outputIndex, delta: full });
    if (!full.startsWith(previous)) throw new AiProxyError(502, "The backend returned inconsistent tool arguments.", "api_error");
    return full.length > previous.length ? this.event({ type: "response.function_call_arguments.delta", output_index: outputIndex, delta: full.slice(previous.length) }) : "";
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
    const reasoningType =
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta" ||
      type === "response.reasoning_content.delta";
    if (reasoningType) {
      if (typeof event["delta"] !== "string")
        throw new AiProxyError(502, "Invalid reasoning delta from backend.", "api_error");
      if (this.omitThinking) return wire;
      if (this.protocol === "chat") wire += this.chat({ reasoning_content: event["delta"] });
      else {
        wire += this.closeText();
        if (!this.thinkingBlock || this.thinkingBlock.closed) {
          this.thinkingBlock = { index: this.nextBlock++, closed: false };
          wire += this.claude("content_block_start", {
            index: this.thinkingBlock.index,
            content_block: { type: "thinking", thinking: "" }
          });
        }
        wire += this.claude("content_block_delta", {
          index: this.thinkingBlock.index,
          delta: { type: "thinking_delta", thinking: event["delta"] }
        });
      }
    } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      if (typeof event["delta"] !== "string")
        throw new AiProxyError(502, "Invalid text delta from backend.", "api_error");
      wire += this.closeThinking();
      this.textDeltas.set(outputIndex, (this.textDeltas.get(outputIndex) ?? "") + event["delta"]);
      if (this.protocol === "chat") wire += this.chat({ content: event["delta"] });
      else {
        if (!this.textBlock || this.textBlock.closed) {
          this.textBlock = { index: this.nextBlock++, closed: false };
          this.textOutputIndex = outputIndex;
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
      if (this.toolArguments.has(outputIndex)) throw new AiProxyError(502, "The backend repeated a tool start.", "api_error");
      if (typeof item["call_id"] !== "string" || !item["call_id"].length || typeof item["name"] !== "string" || !item["name"].length)
        throw new AiProxyError(502, "The backend returned an invalid tool identity.", "api_error");
      if (this.toolIds.has(item["call_id"])) throw new AiProxyError(502, "The backend repeated a tool identity.", "api_error");
      this.toolIds.set(item["call_id"], outputIndex);
      this.toolArguments.set(outputIndex, "");
      wire += this.closeThinking() + this.closeText();
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
      if (typeof item["arguments"] === "string" && item["arguments"].length)
        wire += this.event({ type: "response.function_call_arguments.delta", output_index: outputIndex, delta: item["arguments"] });
    } else if (type === "response.function_call_arguments.delta") {
      if (typeof event["delta"] !== "string")
        throw new AiProxyError(502, "Invalid tool delta from backend.", "api_error");
      wire += this.closeThinking();
      const previous = this.toolArguments.get(outputIndex);
      if (previous === undefined) throw new AiProxyError(502, "Tool delta arrived without a tool.", "api_error");
      this.toolArguments.set(outputIndex, previous + event["delta"]);
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
    } else if (type === "response.output_item.done") {
      wire += this.finishTool(event, outputIndex);
      const block = this.blocks.get(outputIndex);
      if (block && !block.closed) {
        block.closed = true;
        wire += this.claude("content_block_stop", { index: block.index });
      } else if (this.textOutputIndex === outputIndex) wire += this.closeText();
      if (event["item"] && object(event["item"])["type"] === "reasoning") wire += this.closeThinking();
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = object(event["response"]),
        usage = aiUsage(response);
      const output = Array.isArray(response["output"]) ? response["output"] as unknown[] : [];
      for (const [index, raw] of output.entries()) {
        const item = object(raw);
        wire += this.finishTool({ item }, index);
        if (item["type"] === "message" && Array.isArray(item["content"])) {
          const full = (item["content"] as unknown[]).map(part => object(part))
            .filter(part => part["type"] === "output_text" || part["type"] === "refusal")
            .map(part => textString(part["text"] ?? part["refusal"], "backend text")).join("");
          const previous = this.textDeltas.get(index) ?? "";
          if (!full.startsWith(previous)) throw new AiProxyError(502, "The backend returned inconsistent response text.", "api_error");
          if (full.length > previous.length) wire += this.event({ type: "response.output_text.delta", output_index: index, delta: full.slice(previous.length) });
        }
      }
      const tools = (Array.isArray(response["output"]) ? response["output"] : []).some(
        (item) => object(item)["type"] === "function_call"
      );
      if (this.protocol === "chat") {
        wire += this.chat({}, type === "response.incomplete" ? "length" : tools ? "tool_calls" : "stop");
        if (this.includeUsage)
          wire += `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, prompt_tokens_details: { cached_tokens: usage.cached } } })}\n\n`;
        wire += "data: [DONE]\n\n";
      } else {
        wire += this.closeThinking();
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
            stop_reason: type === "response.incomplete" ? "max_tokens" : tools ? "tool_use" : "end_turn",
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
