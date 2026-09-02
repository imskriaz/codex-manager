import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("activation performance safeguards", () => {
  it("does not await Settings Sync or always-online relay preparation during activation", () => {
    const sync = readFileSync("src/services/encryptedSync.ts", "utf8");
    const workbench = readFileSync("src/presentation/workbench/accountsWorkbench.ts", "utf8");
    const scheduler = readFileSync("src/presentation/workbench/schedulerRegistration.ts", "utf8");

    const startBody = sync.slice(sync.indexOf("async start(): Promise<void>"), sync.indexOf("dispose(): void"));
    expect(startBody).not.toContain("workbench.userDataSync.actions.syncNow");
    expect(startBody).not.toContain("await this.syncNow");
    expect(workbench).toContain("encrypted sync startup failed; continuing locally");
    expect(workbench).toContain("this.scheduleAlwaysOnlinePreparation();");
    expect(workbench).not.toContain('measureStep("alwaysOnlineServer.start"');
    expect(scheduler).not.toContain("allTimer = setInterval(runAllRefresh, allMinutes * 60 * 1000);\n      runAllRefresh();");
  });
});
