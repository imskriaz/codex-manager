import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("first-run onboarding", () => {
  it("keeps agreement, sync, import, and Cloudflare in one modal sequence", () => {
    const modal = readFileSync("webview-src/dashboard/onboardingModal.tsx", "utf8");
    expect(modal).toContain('type OnboardingStep = "agreement" | "setup" | "import" | "cloudflare" | "donation"');
    expect(modal).toContain("Accept & continue");
    expect(modal).toContain("Enable encrypted sync");
    expect(modal).toContain("Cloudflared hostname");
    expect(modal).toContain("cloudflared tunnel --url http://127.0.0.1:39875");
    expect(modal).toContain("PayPal or Wise");
    expect(modal).toContain("skriaz@live.com");
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

  it("persists completion in extension state and does not wait for initial sync", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const actions = readFileSync("src/presentation/dashboard/actionHandlers.ts", "utf8");
    const sync = readFileSync("src/services/encryptedSync.ts", "utf8");

    expect(main).toContain('sendAction("completeOnboarding")');
    expect(main).toContain("snapshot.onboardingCompleted");
    expect(main).toContain("deferSync: true");
    expect(main).not.toContain('onboardingPendingRef.current.add("syncNow")');
    expect(actions).toContain("markOnboardingCompleted(ctx.context)");
    expect(sync).toContain("this.queueBackgroundSync(VAULT_SYNC_DEBOUNCE_DELAY_MS)");
  });
});

function modalSource(): string {
  return readFileSync("webview-src/dashboard/onboardingModal.tsx", "utf8");
}
