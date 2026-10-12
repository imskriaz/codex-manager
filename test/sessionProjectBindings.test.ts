import { describe, expect, it, vi } from "vitest";
import { canonicalProjectPath, stabilizeSessionProjectPaths } from "../src/services/sessionProjectBindings";

describe("session project bindings", () => {
  it.each([null, [], { broken: { projectPath: 42, updatedAt: 1 } }, { broken: null }])
    ("keeps session discovery available with corrupt saved bindings: %j", async (stored) => {
      const context = { globalState: { get: () => stored, update: vi.fn() } };
      await expect(stabilizeSessionProjectPaths(context as never, [{ id: "broken", title: "Session", status: "idle" }]))
        .resolves.toEqual([{ id: "broken", title: "Session", status: "idle" }]);
    });
  it("keeps path casing on case-sensitive systems and preserves filesystem roots", async () => {
    const path = await import("node:path");
    const root = path.parse(process.cwd()).root;
    expect(canonicalProjectPath(root)).toBe(root.replace(/\\/g, "/").toLowerCase());
    if (process.platform !== "win32") expect(canonicalProjectPath("/Projects/Upper")).not.toBe(canonicalProjectPath("/projects/upper"));
  });
  it("normalizes Windows device prefixes and separators", () => {
    expect(canonicalProjectPath("\\\\?\\D:\\Projects\\codex-manager\\"))
      .toBe(canonicalProjectPath("D:/Projects/codex-manager"));
  });

  it("persists discovered paths and restores them when a refresh omits project metadata", async () => {
    let stored: Record<string, { projectPath: string; updatedAt: number }> = {};
    const context = {
      globalState: {
        get: vi.fn((_key: string, fallback: unknown) => Object.keys(stored).length ? stored : fallback),
        update: vi.fn(async (_key: string, value: typeof stored) => { stored = value; })
      }
    };
    const projects = [{ id: "project", label: "codex-manager", path: "D:/Projects/codex-manager" }];
    const first = await stabilizeSessionProjectPaths(context as never, [{ id: "session-1", title: "Demo", status: "idle", projectPath: "\\\\?\\D:\\Projects\\codex-manager" }], projects);
    expect(first[0]?.projectPath).toBe("D:/Projects/codex-manager");

    const restored = await stabilizeSessionProjectPaths(context as never, [{ id: "session-1", title: "Demo", status: "idle" }], projects);
    expect(restored[0]?.projectPath).toBe("D:/Projects/codex-manager");
  });
});
