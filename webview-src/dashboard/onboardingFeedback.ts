import type { DashboardActionName } from "../../src/domain/dashboard/types";

export function onboardingFailureMessage(
  action: DashboardActionName,
  status: "failed" | "cancelled" | "timed-out",
  error?: string
): string {
  if (error?.trim()) return error.trim();

  const step = action === "importCurrent" ? "Importing the current account" : "This setup step";
  if (status === "timed-out") return `${step} did not finish in time. Try again.`;
  if (status === "cancelled") return `${step} was cancelled. Try again.`;
  if (action === "completeOnboarding") return "Setup completion could not be saved. Try again.";
  if (action === "importCurrent") return "The current account could not be imported. Try again.";
  return "Onboarding could not complete this step. Try again.";
}
