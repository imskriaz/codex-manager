import { expect, it, vi } from "vitest";

it("keeps read-only page startup independent of terminal UUID availability", async () => {
  const randomUUID = vi.fn(() => {
    throw new Error("A read-only embed must not initialize terminal control.");
  });
  vi.stubGlobal("crypto", { randomUUID });
  try {
    const module = await import("../webview-src/dashboard/workspaceTerminal");
    expect(module.default).toBeTypeOf("function");
    expect(randomUUID).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
