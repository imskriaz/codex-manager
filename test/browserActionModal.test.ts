import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { parseSubmittedTags } from "../webview-src/dashboard/browserActionModal";

describe("port dashboard action modals", () => {
  it("normalizes tag input collected in the browser", () => {
    expect(parseSubmittedTags("team, paid, team,  review ")).toEqual(["team", "paid", "review"]);
  });

  it("uses centered modal placement for confirmations in both dashboard hosts", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    expect(source).toContain('action === "remove" && accountId');
    expect(source).toContain('action === "consumeResetCredit" && accountId');
    expect(source).toContain('action === "reloadPrompt" && accountId');
    expect(source).toContain("openBrowserSwitchPicker();");
    expect(source).toContain('kind: "tags"');
    expect(source).toContain('kind: "notification"');
    expect(source).toContain('type: "dashboard:notification-response"');
    expect(source).toContain('submittedTags: submittedTags ?? []');
    expect(source).toContain("handleConfigureEncryptedSync");
    expect(source).toContain('kind: "password"');
    expect(source).toContain('No account to switch — no capable account has enough quota remaining.');
    expect(source).toContain('uiPreferences.filter === "all" ? "is-selected"');
    expect(source).toContain('aria-pressed={uiPreferences.filter === "all"}');
    expect(source).toContain("<BrowserActionModal");
    expect(source).toContain('presentation={isBrowserDashboard ? "modal" : "popover"}');
    const modal = readFileSync("webview-src/dashboard/browserActionModal.tsx", "utf8");
    expect(modal).toContain('request.kind === "password"');
    expect(modal).toContain("const Shell = useModalShell || props.presentation !== \"popover\" ? ModalShell : ActionPopoverShell;");
  });
});
