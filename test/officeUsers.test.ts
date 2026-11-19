import { describe, expect, it } from "vitest";
import { defaultOfficeFeatures, officeUserWorkspace, type OfficeUser } from "../src/services/officeUsers";

describe("office workspace boundaries", () => {
  it("creates project folders below the assigned user root", () => {
    const user: OfficeUser = {
      id: "u1", username: "alex", displayName: "Alex", role: "user", enabled: true,
      features: defaultOfficeFeatures, defaultPrompt: "", workspacePath: "C:/office/alex", mcpServers: [], createdAt: 0
    };
    expect(officeUserWorkspace(user, "Quarterly plan")).toBe("C:\\office\\alex\\projects\\Quarterly-plan");
    expect(defaultOfficeFeatures).not.toContain("terminal");
  });
});
