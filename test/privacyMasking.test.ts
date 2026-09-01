import { describe, expect, it } from "vitest";
import { getSensitiveDisplayValue, maskSensitiveString } from "../webview-src/dashboard/helpers";

describe("privacy masking", () => {
  it("always exposes only the first and last three characters", () => {
    expect(maskSensitiveString("example@example.com")).toBe("exa***com");
    expect(getSensitiveDisplayValue("account-123456", true, "id")).toBe("acc***456");
    expect(getSensitiveDisplayValue("example@example.com", false, "email")).toBe("example@example.com");
  });
});
