import { describe, expect, it } from "vitest";
import { onboardingFailureMessage } from "../webview-src/dashboard/onboardingFeedback";

describe("dashboard onboarding terminal feedback", () => {
  it("gives timed-out setup and import actions actionable inline errors", () => {
    expect(onboardingFailureMessage("configureEncryptedSync", "timed-out"))
      .toBe("This setup step did not finish in time. Try again.");
    expect(onboardingFailureMessage("importCurrent", "timed-out"))
      .toBe("Importing the current account did not finish in time. Try again.");
  });

  it("shows cancellation and preserves a concrete host error", () => {
    expect(onboardingFailureMessage("importCurrent", "cancelled"))
      .toBe("Importing the current account was cancelled. Try again.");
    expect(onboardingFailureMessage("completeOnboarding", "failed", "  Could not save setup.  "))
      .toBe("Could not save setup.");
  });
});
