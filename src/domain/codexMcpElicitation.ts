import type { DashboardCodexServerRequest } from "./dashboard/types";

export type McpFormField = {
  type: "string" | "number" | "integer" | "boolean" | "array";
  required: boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
};
type Question = NonNullable<DashboardCodexServerRequest["questions"]>[number];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function mcpElicitationRequest(params: Record<string, unknown>): Pick<DashboardCodexServerRequest, "kind" | "title" | "detail" | "mcp" | "questions"> {
  const server = typeof params["serverName"] === "string" ? params["serverName"].slice(0, 256) : "MCP server";
  const message = typeof params["message"] === "string" ? params["message"] : typeof params["description"] === "string" ? params["description"] : "";
  const result: ReturnType<typeof mcpElicitationRequest> = { kind: "mcp", title: `Request from ${server}`, detail: message.slice(0, 8000), mcp: { mode: "external", warning: "Continue this request in its owning Codex window. This form needs controls or verification that the dashboard cannot provide." } };
  const mode = params["mode"];
  const meta = params["_meta"];
  if (object(meta) && (meta["codex_approval_kind"] === "browser_auth" || Object.hasOwn(meta, "openai/elicitation"))) return result;
  if (mode === "url") {
    try {
      const url = new URL(String(params["url"]));
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return result;
      result.mcp = { mode: "url", url: url.href };
    } catch { /* An unsafe link remains a visible handoff. */ }
    return result;
  }
  if (mode === "openai/userVerification") {
    result.mcp!.warning = "Device verification is required. Complete it in the owning Codex window; the dashboard cannot generate verification proof.";
    return result;
  }
  if (!["form", "openai/form", "openaiForm"].includes(String(mode))) return result;
  const schema = params["requestedSchema"];
  if (!object(schema) || schema["type"] !== "object" || !object(schema["properties"])) return result;
  // Rich OpenAI controls must stay with their native renderer rather than becoming empty approvals.
  if (Object.keys(schema).some(key => !["type", "properties", "required", "$schema", "additionalProperties", "title", "description"].includes(key))) return result;
  const properties = schema["properties"];
  const required = schema["required"] ?? [];
  if (!Array.isArray(required) || required.some(key => typeof key !== "string" || !Object.hasOwn(properties, key)) || Object.keys(properties).length > 20) return result;
  const questions: Question[] = [];
  for (const [id, raw] of Object.entries(properties)) {
    if (!id || id.length > 128 || ["__proto__", "constructor", "prototype"].includes(id) || !object(raw)) return result;
    if (Object.keys(raw).some(key => !["type", "title", "description", "default", "enum", "enumNames", "oneOf", "items", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "format"].includes(key))) return result;
    const type = raw["type"];
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "array") return result;
    const field: McpFormField = { type, required: required.includes(id) };
    for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
      if (raw[key] != null) {
        if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) return result;
        field[key] = raw[key];
      }
    }
    if (raw["format"] != null) {
      if (typeof raw["format"] !== "string" || !["email", "uri", "date", "date-time"].includes(raw["format"])) return result;
      field.format = raw["format"];
    }
    const items = type === "array" && object(raw["items"]) ? raw["items"] : raw;
    if (type === "array" && Object.keys(items).some(key => !["type", "enum", "anyOf"].includes(key))) return result;
    const variants = items[type === "array" ? "anyOf" : "oneOf"];
    const values = items["enum"];
    let options: Question["options"];
    if (variants != null) {
      if (!Array.isArray(variants) || !variants.length || variants.length > 100 || variants.some(value => !object(value) || typeof value["const"] !== "string" || typeof value["title"] !== "string")) return result;
      options = (variants as Record<string, unknown>[]).map(value => ({ label: value["const"] as string, description: value["title"] as string }));
    } else if (values != null) {
      if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(value => typeof value !== "string")) return result;
      const names = items["enumNames"];
      options = values.map((label, index) => ({ label: label as string, description: Array.isArray(names) && typeof names[index] === "string" ? names[index] : "" }));
    }
    if (type === "array" && !options) return result;
    if (options) field.enum = options.map(option => option.label);
    if (type === "boolean") options = [{ label: "true", description: "Yes" }, { label: "false", description: "No" }];
    questions.push({ id, header: typeof raw["title"] === "string" ? raw["title"].slice(0, 500) : id,
      question: typeof raw["description"] === "string" ? raw["description"].slice(0, 8000) : id,
      isSecret: false, field, options });
  }
  result.mcp = { mode: "form" };
  result.questions = questions;
  return result;
}

export function mcpElicitationContent(questions: Question[], answers: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(questions.flatMap(question => {
    const field = question.field!;
    const raw = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
    const fail = (): never => { throw new Error(`Review “${question.header}”: enter a valid ${field.type} value that meets the requested constraints.`); };
    if (raw === undefined || raw === "") {
      if (field.required) fail();
      return [];
    }
    if (raw!.length > 8000) fail();
    let value: unknown = raw;
    if (field.type === "boolean") { if (raw !== "true" && raw !== "false") fail(); value = raw === "true"; }
    if (field.type === "number" || field.type === "integer") {
      if (!raw!.trim()) fail();
      value = Number(raw);
      if (!Number.isFinite(value) || field.type === "integer" && !Number.isSafeInteger(value) || field.minimum !== undefined && (value as number) < field.minimum || field.maximum !== undefined && (value as number) > field.maximum) fail();
    }
    if (field.type === "array") {
      try { value = JSON.parse(raw!); } catch { fail(); }
      if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !field.enum?.includes(item)) || new Set(value).size !== value.length || field.minItems !== undefined && value.length < field.minItems || field.maxItems !== undefined && value.length > field.maxItems) fail();
    }
    if (field.type === "string") {
      if (field.enum && !field.enum.includes(raw!) || field.minLength !== undefined && [...raw!].length < field.minLength || field.maxLength !== undefined && [...raw!].length > field.maxLength) fail();
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw!)) fail();
      if (field.format === "uri") { try { new URL(raw!); } catch { fail(); } }
      if (field.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(raw!) || !Number.isFinite(Date.parse(raw!)) || new Date(raw!).toISOString().slice(0, 10) !== raw)) fail();
      if (field.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(raw!) || !Number.isFinite(Date.parse(raw!)))) fail();
    }
    return [[question.id, value]];
  }));
}
