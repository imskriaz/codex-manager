import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyOAuthAuthorizationLink,
  openOAuthAuthorizationWindow,
  resolveOAuthCopyActionOutcome
} from "../webview-src/dashboard/oauthSessionHook";

describe("browser dashboard OAuth authorization", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens the authorization URL in the remote client browser", () => {
    const open = vi.fn(() => ({}));
    vi.stubGlobal("window", { open });

    expect(openOAuthAuthorizationWindow("https://auth.example.test/authorize")).toBe(true);
    expect(open).toHaveBeenCalledWith("https://auth.example.test/authorize", "_blank", "noopener,noreferrer");
  });

  it("reports a blocked authorization window", () => {
    vi.stubGlobal("window", { open: vi.fn(() => null) });
    expect(openOAuthAuthorizationWindow("https://auth.example.test/authorize")).toBe(false);
  });

  it("copies an authorization link in the browser client and reports failure", async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("blocked"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyOAuthAuthorizationLink("https://auth.example.test/authorize")).resolves.toBe(true);
    await expect(copyOAuthAuthorizationLink("https://auth.example.test/authorize")).resolves.toBe(false);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("waits for the webview host copy result before showing OAuth copy feedback", () => {
    const actionResult = (status: "completed" | "failed", action: "copyText" | "startOAuthAutoFlow") =>
      ({ type: "dashboard:action-result", requestId: "copy", status, action }) as const;

    expect(resolveOAuthCopyActionOutcome(actionResult("completed", "copyText"), true)).toBe("copied");
    expect(resolveOAuthCopyActionOutcome(actionResult("failed", "copyText"), true)).toBe("failed");
    expect(resolveOAuthCopyActionOutcome(actionResult("completed", "copyText"), false)).toBeUndefined();
    expect(resolveOAuthCopyActionOutcome(actionResult("completed", "startOAuthAutoFlow"), true)).toBeUndefined();
  });
});
