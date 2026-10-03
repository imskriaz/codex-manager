import { describe, expect, it } from "vitest";
import { readSubAgentMetadata } from "../src/domain/sessionSource";
import { filterCliSessionsBySection } from "../webview-src/dashboard/cliSessionsModal";

describe("sub-agent session identity", () => {
  it("recognizes native, serialized, and legacy sources", () => {
    const source = { subagent: { thread_spawn: { parent_thread_id: "parent", agent_path: "/root/reviewer", agent_nickname: "Reviewer" } } };
    expect(readSubAgentMetadata(source)).toEqual({ subAgent: true, parentSessionId: "parent", agentName: "Reviewer" });
    expect(readSubAgentMetadata(JSON.stringify(source))).toEqual(readSubAgentMetadata(source));
    expect(readSubAgentMetadata("subagent")).toEqual({ subAgent: true });
    expect(readSubAgentMetadata("cli")).toEqual({});
  });
  it("recognizes peer summaries and camel-case app-server relationships", () => {
    expect(readSubAgentMetadata({ parentSessionId: "parent", agentName: "Reviewer" })).toEqual({ subAgent: true, parentSessionId: "parent", agentName: "Reviewer" });
    expect(readSubAgentMetadata({ source: { subAgent: { threadSpawn: { parentThreadId: "parent", agentNickname: "Reviewer" } } } })).toEqual({ subAgent: true, parentSessionId: "parent", agentName: "Reviewer" });
    expect(readSubAgentMetadata({ source: "cli" })).toEqual({});
    expect(readSubAgentMetadata({ subAgent: false, source: "cli" })).toEqual({});
  });
  it("excludes inherited child titles and duplicate IDs while preserving different parent chats", () => {
    const parent = { id: "parent", title: "Evaluate", status: "running" as const };
    expect(filterCliSessionsBySection([parent, parent, { ...parent, id: "other" }, { ...parent, id: "child", subAgent: true }, { ...parent, id: "peer-child", parentSessionId: "parent" }, { ...parent, id: "old", archived: true }], "active").map((item) => item.id)).toEqual(["parent", "other"]);
  });
});
