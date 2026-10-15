import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { buildXoomDonationUrl } from "../webview-src/dashboard/donationDetails";

describe("first-run onboarding", () => {
  it("keeps agreement, sync, import, and Cloudflare in one modal sequence", () => {
    const modal = readFileSync("webview-src/dashboard/onboardingModal.tsx", "utf8");
    expect(modal).toContain('type OnboardingStep = "agreement" | "setup" | "import" | "cloudflare" | "donation"');
    expect(modal).toContain("Accept & continue");
    expect(modal).toContain("Enable cross-PC claim checks");
    expect(modal).toContain("Share only account IDs and PC ownership claims");
    expect(modal).toContain("Cloudflared hostname");
    expect(modal).toContain("cloudflared tunnel --url http://127.0.0.1:39875");
    expect(modal).toContain("Set the shared Password under General settings before remote");
    expect(modal).not.toContain("dashboardPassword");
    expect(modal).toContain('type="password"');
    expect(modal).toContain('password: "Password"');
    expect(modal).not.toContain("Passphrase");
    expect(modal).not.toContain("PayPal or Wise");
    expect(modal).not.toContain("skriaz@live.com");
    const donation = readFileSync("webview-src/dashboard/donationDetails.tsx", "utf8");
    expect(donation).toContain("Donation amount (USD)");
    expect(donation).toContain("countryCode=BD&destinationCurrencyCode=BDT");
    expect(donation).toContain("Use your PayPal account to sign in to Xoom");
    expect(donation).toContain("then enter Codex Manager ·");
    expect(donation).not.toContain("Riaz");
    expect(readFileSync("README.md", "utf8")).toContain("send to **Codex Manager**");
    expect(donation).toContain("01628301525");
    const about = readFileSync("webview-src/dashboard/aboutModal.tsx", "utf8");
    expect(about).not.toContain('title: "Donate"');
    expect(about).not.toContain("DonationDetails");
  });

  it("checks the current auth identity before offering Import email", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const actionHandlers = readFileSync("src/presentation/dashboard/actionHandlers.ts", "utf8");
    const repository = readFileSync("src/storage/accounts.ts", "utf8");
    expect(main).toContain('sendAction("inspectCurrentAuth")');
    expect(modalSource()).toContain("${copy.import} ${props.currentAuthEmail}");
    expect(actionHandlers).toContain('case "inspectCurrentAuth"');
    expect(repository).toContain("alreadyAdded: accounts.some");
  });

  it("adds a valid USD amount to the Xoom transfer link", () => {
    const url = new URL(buildXoomDonationUrl("12.50"));
    expect(url.searchParams.get("countryCode")).toBe("BD");
    expect(url.searchParams.get("destinationCurrencyCode")).toBe("BDT");
    expect(url.searchParams.get("sendAmount")).toBe("12.50");
    expect(new URL(buildXoomDonationUrl("0")).searchParams.get("sendAmount")).toBeNull();
  });

  it("persists completion in extension state and does not wait for initial sync", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const actions = readFileSync("src/presentation/dashboard/actionHandlers.ts", "utf8");
    const sync = readFileSync("src/services/encryptedSync.ts", "utf8");

    expect(main).toContain('sendAction("completeOnboarding")');
    expect(main).toContain("snapshot.onboardingCompleted");
    expect(main).toContain("deferSync: true");
    expect(main).toContain('onboardingPendingRef.current.add("configureEncryptedSync")');
    expect(main).not.toContain('onboardingPendingRef.current.add("syncNow")');
    expect(actions).toContain("markOnboardingCompleted(ctx.context)");
    expect(sync).toContain("this.queueBackgroundSync(this.getVaultSyncDebounceDelayMs())");
  });
});

function modalSource(): string {
  return readFileSync("webview-src/dashboard/onboardingModal.tsx", "utf8");
}
