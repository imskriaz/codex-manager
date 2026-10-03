import { describe, expect, it } from "vitest";
import { buildCliSessionPath, cliSessionTargetFromLocation, sameCliSessionTarget } from "../webview-src/dashboard/cliSessionRoute";

const id = "01a04882-d037-7a42-ad24-9afb61901188";
describe("conversation routing", () => {
  it("round-trips device and project identity without mixing copied sessions", () => {
    const url = new URL(buildCliSessionPath({ id, deviceId: "pc:a & b", projectPath: "D:/Project & space" }), "http://localhost");
    expect(cliSessionTargetFromLocation(url.pathname, url.search)).toEqual({ id, deviceId: "pc:a & b" });
    expect(url.searchParams.get("project")).toBe("D:/Project & space");
    expect(sameCliSessionTarget({ id, deviceId: "pc-a" }, { id, deviceId: "pc-b" })).toBe(false);
  });
  it("rejects stale responses when no chat is selected and supports local legacy links", () => {
    expect(sameCliSessionTarget({ id }, undefined)).toBe(false);
    expect(sameCliSessionTarget({ id }, { id, deviceId: "local" })).toBe(true);
    expect(cliSessionTargetFromLocation("/", "")).toBeUndefined();
    expect(cliSessionTargetFromLocation(`/${id}`, "?project=demo")).toEqual({ id, deviceId: undefined });
  });
});
