import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import {
  resolveCardHealthReason,
  resolveCardPlanBadge,
  resolveClaimPopoverText,
  resolveCompactIdentityBadge,
  resolvePrimaryAccountControl,
  resolveViewportPopoverPosition,
  shouldOpenClaimPopover
} from "../webview-src/dashboard/savedAccountCard";

describe("saved account card presentation", () => {
  it("replaces the enablement toggle with reauthorization in both account layouts", () => {
    expect(resolvePrimaryAccountControl({ healthKind: "reauthorize", dismissedHealth: false })).toBe("reauthorize");
    expect(resolvePrimaryAccountControl({ healthKind: "reauthorize", dismissedHealth: true })).toBe("reauthorize");
    expect(resolvePrimaryAccountControl({ healthKind: "healthy", dismissedHealth: false })).toBe("enablement");
  });

  it("shows only the PC name for a claim and no badge when unclaimed", () => {
    expect(resolveCompactIdentityBadge("Office PC")).toEqual({
      kind: "running-device",
      label: "Office PC"
    });
    expect(resolveCompactIdentityBadge()).toBeUndefined();
  });

  it("shows only supported plan badges beside the card email", () => {
    expect(resolveCardPlanBadge("Free")).toBe("Free");
    expect(resolveCardPlanBadge("ChatGPT Plus")).toBe("Plus");
    expect(resolveCardPlanBadge("Pro 20x")).toBe("Pro");
    expect(resolveCardPlanBadge("Max")).toBe("Max");
    expect(resolveCardPlanBadge("Team")).toBeUndefined();

    const source = readFileSync("webview-src/dashboard/savedAccountCard.tsx", "utf8");
    expect(source).toContain('class="pill plan saved-plan-badge"');
  });

  it("keeps the grid-card account name and badges on one row with current before the plan", () => {
    const source = readFileSync("webview-src/dashboard/savedAccountCard.tsx", "utf8");
    const styles = readFileSync("media/webview/quotaSummary.css", "utf8");
    const cardView = source.slice(source.indexOf("saved-card saved-card-front"));
    const header = cardView.slice(0, cardView.indexOf('<div class="saved-top-actions"'));

    expect(header).not.toContain('<div class="saved-meta">');
    expect(header.indexOf('{copy.current}')).toBeLessThan(header.indexOf("{cardPlanBadge}"));
    expect(styles).toMatch(/\.saved-identity-line h3\s*{[^}]*flex-wrap:\s*nowrap/s);
    expect(styles).toMatch(/\.saved-identity-line h3\s*{[^}]*overflow:\s*hidden/s);
  });

  it("shows the remote-PC label in both card layouts", () => {
    const source = readFileSync("webview-src/dashboard/savedAccountCard.tsx", "utf8");
    const styles = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(source).toContain('class="saved-credits-line saved-running-device"');
    expect(source).toContain("saved-running-device");
    expect(styles).toMatch(/\.pill\.saved-running-device\s*{[^}]*border: 1px solid var\(--danger\)/s);
    expect(styles).toMatch(/\.pill\.saved-running-device\s*{[^}]*background: color-mix\(in srgb, var\(--danger\) 8%, transparent\)/s);
    expect(styles).toMatch(/\.pill\.saved-running-device\s*{[^}]*color: var\(--danger\)/s);
    expect(resolveCompactIdentityBadge("DESKTOP-4ISJOQ6")).toEqual({
      kind: "running-device",
      label: "DESKTOP-4ISJOQ6"
    });
  });

  it("keeps the computer label out of the card header", () => {
    const source = readFileSync("webview-src/dashboard/savedAccountCard.tsx", "utf8");
    const cardView = source.slice(source.indexOf("saved-card saved-card-front"));
    const headerEnd = cardView.indexOf('<div class="saved-progress">');

    expect(cardView.slice(0, headerEnd)).not.toContain('class="pill saved-running-device"');
    expect(cardView).toContain('class="saved-credits-line saved-running-device"');
  });

  it("orders reset, computer, and days remaining in the card footer", () => {
    const styles = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(styles).toMatch(/\.saved-credit-summary \.saved-reset-badge\s*{[^}]*order:\s*0/s);
    expect(styles).toMatch(/\.saved-credit-summary \.saved-running-device\s*{[^}]*order:\s*1/s);
    expect(styles).toMatch(/\.saved-subscription-remaining\s*{[^}]*order:\s*2/s);
    expect(readFileSync("webview-src/dashboard/savedAccountCard.tsx", "utf8")).toContain(
      "saved-reset-credits-line saved-reset-badge"
    );
  });

  it("keeps card footer metadata on one ellipsizing line", () => {
    const styles = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(styles).toMatch(/\.saved-credit-summary\s*{[^}]*flex-wrap:\s*nowrap/s);
    expect(styles).toMatch(/\.saved-credit-summary\s*{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.saved-credit-summary \.saved-running-device\s*{[^}]*flex:\s*1 1 auto/s);
    expect(styles).toMatch(/\.saved-credit-summary \.saved-credits-line\s*{[^}]*text-overflow:\s*ellipsis/s);
  });

  it("keeps compact card metadata regular-weight with tight padding", () => {
    const styles = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(styles).toMatch(/\.saved-table-meta \.saved-running-device\s*{[^}]*font-weight:\s*400/s);
    expect(styles).toMatch(/\.saved-table-meta \.saved-subscription-remaining\s*{[^}]*padding:\s*1px 3px/s);
    expect(styles).toMatch(/\.saved-table-meta \.saved-subscription-remaining\s*{[^}]*font-weight:\s*400/s);
    expect(styles).toMatch(/\.saved-reset-badge\s*{[^}]*padding:\s*0 3px !important/s);
    expect(styles).toMatch(/\.saved-reset-badge\s*{[^}]*font-weight:\s*400/s);
  });

  it("keeps raw provider errors out of the card health reason", () => {
    expect(
      resolveCardHealthReason({
        healthKind: "reauthorize",
        healthLabel: "Needs Reauth",
        healthMessage: 'API returned 401 - {"error":"Your authentication token has expired"}'
      })
    ).toBe("Needs Reauth");
  });

  it("only opens the foreign-claim dialog while rescue is locked", () => {
    expect(shouldOpenClaimPopover(true, false)).toBe(true);
    expect(shouldOpenClaimPopover(true, true)).toBe(false);
    expect(shouldOpenClaimPopover(false, false)).toBe(false);

    const source = readFileSync("webview-src/dashboard/savedAccountCard.tsx", "utf8");
    expect(source).not.toContain("Rescue override is active");
    expect(source).toContain('onAction("toggleAccountEnabled", account.id, { enabled: !account.enabled })');
  });

  it("names the claiming PC in the popover instructions", () => {
    expect(resolveClaimPopoverText("body", "DESKTOP-4ISJOQ6", "en")).toBe(
      "Sync after disabling this account on DESKTOP-4ISJOQ6, or use rescue to unlock it only on this device."
    );
  });

  it("keeps popovers inside the viewport and opens them above near the bottom", () => {
    expect(
      resolveViewportPopoverPosition(
        { top: 540, right: 790, bottom: 560, left: 770, width: 20 },
        { width: 264, height: 140 },
        { width: 800, height: 600 }
      )
    ).toEqual({ top: 392, left: 528, arrowLeft: 250, placement: "above" });

    expect(
      resolveViewportPopoverPosition(
        { top: 20, right: 20, bottom: 40, left: 0, width: 20 },
        { width: 264, height: 140 },
        { width: 800, height: 600 }
      )
    ).toEqual({ top: 48, left: 8, arrowLeft: 14, placement: "below" });
  });

  it("opens account details in the details pane instead of flipping the card", () => {
    const source = readFileSync("webview-src/dashboard/savedAccountCard.tsx", "utf8");
    expect(source).toContain('onAction("details", account.id)');
  });
});
