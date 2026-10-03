export type SubAgentMetadata = { subAgent?: boolean; parentSessionId?: string; agentName?: string };

/** Native/serialized sources and peer summaries may use either naming convention. */
export function readSubAgentMetadata(source: unknown): SubAgentMetadata {
  if (typeof source === "string") {
    try { return readSubAgentMetadata(JSON.parse(source) as unknown); }
    catch { return /sub[_-]?agent/i.test(source) ? { subAgent: true } : {}; }
  }
  if (!source || typeof source !== "object") return {};
  const record = source as Record<string, unknown>;
  const entry = Object.entries(record).find(([key, value]) => /sub[_-]?agent/i.test(key) && value !== false && value !== undefined && value !== null);
  const parentValue = record["parentSessionId"] ?? record["parent_thread_id"] ?? record["parentThreadId"];
  const direct = record["subAgent"] === true || typeof parentValue === "string" && Boolean(parentValue.trim()) || typeof record["type"] === "string" && /sub[_-]?agent/i.test(record["type"]);
  const nested = record["source"] !== source ? readSubAgentMetadata(record["source"]) : {};
  if (!entry && !direct) return nested;
  const detail = entry?.[1] && typeof entry[1] === "object" ? entry[1] as Record<string, unknown> : record;
  const spawnValue = detail["thread_spawn"] ?? detail["threadSpawn"];
  const spawn = spawnValue && typeof spawnValue === "object" ? spawnValue as Record<string, unknown> : detail;
  const parent = spawn["parentSessionId"] ?? spawn["parent_thread_id"] ?? spawn["parentThreadId"] ?? parentValue ?? nested.parentSessionId;
  const name = spawn["agentName"] ?? spawn["agent_nickname"] ?? spawn["agentNickname"] ?? spawn["agent_role"] ?? spawn["agentRole"] ?? spawn["agent_path"] ?? nested.agentName;
  return { subAgent: true,
    ...(typeof parent === "string" && parent.trim() ? { parentSessionId: parent } : {}),
    ...(typeof name === "string" ? { agentName: name.split("/").filter(Boolean).at(-1) ?? name } : {}) };
}
