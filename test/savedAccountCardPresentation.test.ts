import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import {
  resolveCardHealthReason,
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

  it("shows the remote-PC label in both card layouts", () => {
    const source = readFileSync("webview-src/dashboard/savedAccountCard.tsx", "utf8");
    const styles = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(source).toContain('class="saved-credits-line saved-running-device"');
    expect(source).toContain("saved-running-device");
    expect(styles).toMatch(/\.pill\.saved-running-device\s*{[^}]*background: var\(--danger\)/s);
    expect(styles).toMatch(/\.pill\.saved-running-device\s*{[^}]*color: #fff/s);
    expect(resolveCompactIdentityBadge("DESKTOP-4ISJOQ6")).toEqual({
      kind: "running-device",
      label: "DESKTOP-4ISJOQ6"
    });
  });

  it("orders reset credits before subscription days remaining", () => {
    const styles = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(styles).toMatch(/\.saved-reset-badge\s*{[^}]*order:\s*1/s);
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
    expect(source).toContain('onAction("details", account.id, { privacyMode: props.privacyMode })');
  });
});
