import { describe, expect, it } from "vitest";
import { emptyWorkspaceTerminalActivity, reduceWorkspaceTerminalActivity } from "../src/domain/workspaceTerminalActivity";
import type { DashboardWorkspaceTerminalOutput, DashboardWorkspaceTerminalResult } from "../src/domain/dashboard/types";

const output: DashboardWorkspaceTerminalOutput = { id: "command", terminalId: "Shell", command: "echo ok", cwd: "project", chunk: "first", sequence: 0, stream: "terminal" };
const result: DashboardWorkspaceTerminalResult = { id: output.id, terminalId: output.terminalId, command: output.command, cwd: output.cwd, output: "first second", status: "completed", durationMs: 100, finishedAt: new Date().toISOString() };

describe("terminal live activity recovery", () => {
  it("settles interrupted monitoring for only the restarted device and clears only its history", () => {
    let state = reduceWorkspaceTerminalActivity(emptyWorkspaceTerminalActivity, { output });
    state = reduceWorkspaceTerminalActivity(state, { output: { ...output, deviceId: "peer" } });
    state = reduceWorkspaceTerminalActivity(state, { resetDevice: "local" });
    expect(Object.keys(state.outputs)).toEqual(["peer:command"]);
    expect(state.results[0]).toMatchObject({ status: "untracked", output: expect.stringContaining("monitoring restarted") });
    state = reduceWorkspaceTerminalActivity(state, { result: { ...result, deviceId: "peer" } });
    state = reduceWorkspaceTerminalActivity(state, { clear: true, deviceId: "local" });
    expect(state.results.map(item => item.deviceId)).toEqual(["peer"]);
    expect(reduceWorkspaceTerminalActivity(state, { output })).toBe(state);
  });
  it("deduplicates incremental output and replaces it with a newer replay snapshot", () => {
    let state = reduceWorkspaceTerminalActivity(emptyWorkspaceTerminalActivity, { output });
    expect(reduceWorkspaceTerminalActivity(state, { output })).toBe(state);
    state = reduceWorkspaceTerminalActivity(state, { output: { ...output, sequence: 2, chunk: "first second" }, replay: true });
    expect(state.outputs["local:command"].chunk).toBe("first second");
    expect(reduceWorkspaceTerminalActivity(state, { output: { ...output, sequence: 1 } })).toBe(state);
  });
  it("completion prevents delayed output and snapshots from restarting a spinner, including after clear", () => {
    let state = reduceWorkspaceTerminalActivity(emptyWorkspaceTerminalActivity, { output });
    expect(reduceWorkspaceTerminalActivity(state, { clear: true }).outputs).toEqual(state.outputs);
    state = reduceWorkspaceTerminalActivity(state, { result });
    expect(state.outputs).toEqual({});
    expect(reduceWorkspaceTerminalActivity(state, { output: { ...output, sequence: 10 }, replay: true })).toBe(state);
    state = reduceWorkspaceTerminalActivity(state, { clear: true });
    expect(state.results).toEqual([]);
    expect(reduceWorkspaceTerminalActivity(state, { result })).toBe(state);
  });
  it("isolates devices with the same command ID and bounds retained output and history", () => {
    let state = reduceWorkspaceTerminalActivity(emptyWorkspaceTerminalActivity, { output });
    state = reduceWorkspaceTerminalActivity(state, { output: { ...output, deviceId: "peer" } });
    state = reduceWorkspaceTerminalActivity(state, { result });
    expect(Object.keys(state.outputs)).toEqual(["peer:command"]);
    for (let index = 0; index < 100; index++) state = reduceWorkspaceTerminalActivity(state, { output: { ...output, id: String(index), chunk: "x".repeat(20_000) } });
    expect(Object.keys(state.outputs)).toHaveLength(32);
    expect(Object.values(state.outputs).every(item => item.chunk.length === 16_384)).toBe(true);
    for (let index = 0; index < 100; index++) state = reduceWorkspaceTerminalActivity(state, { result: { ...result, id: String(index) } });
    expect(state.outputs).toEqual({});
    expect(state.results).toHaveLength(64);
    expect(state.completed).toHaveLength(64);
  });
});
