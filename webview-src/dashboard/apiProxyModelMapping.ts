export type ApiProxyModel = { id: string; name: string };

export type ClaudeModelMapping = {
  model: string;
  opus: string;
  sonnet: string;
  haiku: string;
  fable: string;
};

const MODEL_PLACEHOLDER = "MODEL_FROM_CATALOGUE";

function matches(model: ApiProxyModel, pattern: RegExp): boolean {
  return pattern.test(`${model.id} ${model.name}`.toLowerCase());
}

function pick(models: ApiProxyModel[], pattern: RegExp, fallback: string): string {
  return models.find((model) => matches(model, pattern))?.id ?? fallback;
}

export function mapClaudeModels(models: ApiProxyModel[]): ClaudeModelMapping {
  const fallback = models[0]?.id ?? MODEL_PLACEHOLDER;
  const sonnet = pick(models, /(?:^|[^a-z])(?:claude[-_ ]*)?sonnet(?:[^a-z]|$)/, fallback);
  return {
    model: sonnet,
    opus: pick(models, /(?:^|[^a-z])(?:claude[-_ ]*)?opus(?:[^a-z]|$)/, sonnet),
    sonnet,
    haiku: pick(models, /(?:^|[^a-z])(?:claude[-_ ]*)?haiku(?:[^a-z]|$)/, sonnet),
    fable: pick(models, /(?:^|[^a-z])(?:claude[-_ ]*)?fable(?:[^a-z]|$)/, sonnet)
  };
}

export function mapDiscoveredModels(value: unknown): ApiProxyModel[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const rows = (value as Record<string, unknown>)["data"];
  if (!Array.isArray(rows)) return [];
  const models: ApiProxyModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const id = typeof item["id"] === "string" ? item["id"].trim() : "";
    if (!id || seen.has(id)) continue;
    const name = [item["display_name"], item["displayName"], item["name"], item["label"]].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0
    );
    models.push({ id, name: name?.trim() ?? id });
    seen.add(id);
  }
  return models;
}

export { MODEL_PLACEHOLDER };
