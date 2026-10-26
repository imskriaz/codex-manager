import { describe, expect, it } from "vitest";
import { resolveQuotaLimitLabel } from "../src/utils/quotaLabels";

describe("quota limit labels", () => {
  it("hides the provider-internal codex rate-limit name", () => {
    expect(resolveQuotaLimitLabel({ limitName: "codex_rate_limits" }, "en")).toBe("Reset ID");
    expect(resolveQuotaLimitLabel({ limitName: "codex_rate_limits" }, "zh")).toBe("重置 ID");
  });

  it("keeps user-provided additional limit names", () => {
    expect(resolveQuotaLimitLabel({ limitName: "Code Review" }, "en")).toBe("Code Review");
  });
});
