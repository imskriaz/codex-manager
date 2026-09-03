import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { resolveCreateOAuthLinkLabel } from "../webview-src/dashboard/accountModals";
import { resolveAccountAccessAction } from "../webview-src/dashboard/savedAccountCard";

describe("add account OAuth actions", () => {
  it("uses one context-specific access action per account", () => {
    expect(resolveAccountAccessAction({ isActive: false, isCurrentWindowAccount: false })).toBe("switch");
    expect(resolveAccountAccessAction({ isActive: true, isCurrentWindowAccount: true })).toBe("unloadAuth");
    expect(resolveAccountAccessAction({ isActive: true, isCurrentWindowAccount: false })).toBe("reloadPrompt");

    const card = readFileSync("webview-src/dashboard/savedAccountCard.tsx", "utf8");
    expect(card).not.toContain("account.isActive && !account.isCurrentWindowAccount ?");
  });

  it("shows Create Link before the authorization actions are available", () => {
    expect(resolveCreateOAuthLinkLabel("en")).toBe("Create Link");

    const source = readFileSync("webview-src/dashboard/accountModals.tsx", "utf8");
    expect(source).not.toContain("Generate on click");
    expect(source).not.toContain("oauth-link-status");
    expect(source).toMatch(
      /oauthLinkReady \? \([\s\S]*oauth-copy-btn[\s\S]*oauth-open-btn[\s\S]*\) : \([\s\S]*oauth-create-link-btn/
    );
  });

  it("uses an in-dashboard account info modal for the browser host", () => {
    const source = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const modal = readFileSync("webview-src/dashboard/accountModals.tsx", "utf8");
    expect(source).toContain('action === "details" && isBrowserDashboard && accountId');
    expect(source).toContain("<AccountInfoModal");
    expect(modal).toContain('className="dashboard-modal-compact account-info-modal"');
  });

  it("uses compact staged account-add layers without a pasted JSON surface", () => {
    const modal = readFileSync("webview-src/dashboard/accountModals.tsx", "utf8");
    expect(modal).toContain("modal-stack account-add-flow");
    expect(modal).toContain("oauth-link-row");
    expect(modal).toContain('oauth-link-row ${oauthLinkReady ? "" : "is-create"}');
    expect(modal).toContain('layer === "callback"');
    expect(modal).toContain("<textarea");
    expect(modal).toContain("rows={3}");
    expect(modal).toContain('layer === "import"');
    expect(modal).toContain('class="account-add-choice-divider"');
    expect(modal).toContain('class="account-add-layer-actions"');
    expect(modal).toContain('props.inline ? "is-inline" : ""');
    expect(modal).toContain("props.onImportFileSelected(file)");
    expect(modal).toContain("props.onSubmitImport");
    expect(modal).not.toContain('class="modal-textarea"');
    expect(modal).not.toContain("IMPORT_SINGLE_EXAMPLE");
    expect(modal).not.toContain("IMPORT_BATCH_EXAMPLE");
  });

  it("removes empty overview identity placeholders and preserves equal-height columns", () => {
    const overview = readFileSync("webview-src/dashboard/overviewSection.tsx", "utf8");
    const styles = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(overview).not.toContain('<div class="overview-account-workspace">{blankValue}</div>');
    expect(overview).not.toContain('<div class="account-tag-row">{blankValue}</div>');
    expect(styles).toMatch(/\.overview-shell\s*\{[\s\S]*?align-items:\s*stretch;/);
    expect(styles).toMatch(/\.overview-account,\s*\n\.overview-main\s*\{[\s\S]*?align-self:\s*stretch;/);
    expect(styles).toMatch(/\.oauth-modal-stack \.oauth-open-btn,[\s\S]*?max-width:\s*30px;/);
  });
});
