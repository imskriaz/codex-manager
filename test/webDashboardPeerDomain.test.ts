import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("cross-PC WebSocket domain contract", () => {
  it("requires a normalized Cloudflared origin and keeps local browser sockets separate", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain("normalizeCloudflaredDomain(this.settingsStore.getDashboardSettings().cloudflaredDomain ?? \"\")");
    expect(source).toContain('endpoint.protocol = "wss:";');
    expect(source).not.toContain("configuredDomain || (alwaysOnline ?");
    expect(source).toContain("const localBrowser = !isPeer && isLocalWebDashboardRequest(request);");
  });

  it("clears peer sockets and waiters when peer configuration changes", () => {
    const source = readFileSync("src/services/webDashboardServer.ts", "utf8");
    expect(source).toContain("for (const socket of this.peerSockets.values()) socket.close();");
    expect(source).toContain("this.peerActionWaiters.clear();");
    expect(source).toContain("this.peerVaultWaiters.clear();");
    expect(source).toContain("if (this.peerSocket !== socket) return;");
  });
});
