import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
  createRelayAdminToken,
  isAlwaysOnlineRelayHealthResponse,
  isLegacyRelayAdminToken
} from "../src/services/alwaysOnlineServer";

describe("always-online WebSocket relay handoff", () => {
  it("generates an unpredictable admin token without host details", () => {
    const first = createRelayAdminToken();
    const second = createRelayAdminToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(isLegacyRelayAdminToken(first)).toBe(false);
    expect(isLegacyRelayAdminToken("m9abcdef-1234567890-example-host")).toBe(true);
  });

  it("does not mistake the password dashboard HTML for a healthy relay", () => {
    expect(isAlwaysOnlineRelayHealthResponse(200, "<!doctype html><title>Codex Manager</title>")).toBe(false);
    expect(
      isAlwaysOnlineRelayHealthResponse(
        200,
        JSON.stringify({ ok: true, service: "codex-manager-relay", port: 39875, peerCount: 1 })
      )
    ).toBe(true);
  });

  it("prepares the relay before synchronous disposal and tracks it before bind retries", () => {
    const service = readFileSync("src/services/alwaysOnlineServer.ts", "utf8");
    const relay = readFileSync("tools/always-online-server.js", "utf8");

    expect(service).toContain("await this.prepareRelay();");
    expect(service.indexOf("previousConfig.adminToken, pidPath")).toBeLessThan(
      service.indexOf("await fs.writeFile(configPath, JSON.stringify(config)")
    );
    const shutdownRequest = service.slice(
      service.indexOf("function requestShutdown("),
      service.indexOf("async function writeStartupLauncher(")
    );
    expect(shutdownRequest).toContain('request.on("timeout", () => {');
    expect(shutdownRequest).toContain("request.destroy();");
    expect(service).toContain("this.spawnPreparedRelay(this.preparedRelay);");
    expect(service).not.toContain("void this.start().catch");
    expect(relay.indexOf("fs.writeFileSync(pidPath")).toBeLessThan(relay.indexOf("bind();"));
  });
});

describe("always-online relay peer lifecycle", () => {
  it("expires stale open sockets and safely closes HTTP heartbeat placeholders", () => {
    const source = readFileSync("tools/always-online-server.js", "utf8");
    expect(source).toContain('typeof socket.close === "function"');
    expect(source).toContain('typeof entry.socket.terminate === "function"');
    expect(source).toContain("if (changed) broadcast(aggregate());");
    expect(source).not.toContain("entry.socket.readyState !== 1 && entry.lastSeen < cutoff");
  });

  it("bounds pending peer-action routing state", () => {
    const source = readFileSync("tools/always-online-server.js", "utf8");
    expect(source).toContain("function peerActionTimeoutMs(action)");
    expect(source).toContain("rememberPendingAction(message, socket, destination.socket)");
    expect(source).toContain("const origin = takePendingAction(message.requestId, socket)");
    expect(source).toContain("pending.destinationSocket !== sourceSocket");
    expect(source).toContain("The operation outcome is unknown");
  });

  it("force-closes peer sockets and bounds relay shutdown", () => {
    const source = readFileSync("tools/always-online-server.js", "utf8");
    expect(source).toContain('typeof socket.terminate === "function"');
    expect(source).toContain("setTimeout(finish, 1000).unref()");
    expect(source).toContain("peers.clear();");
  });

  it("registers an uninstall hook that removes the Windows startup relay", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
    const uninstall = readFileSync("tools/uninstall.js", "utf8");
    expect(manifest.scripts?.["vscode:uninstall"]).toBe("node ./tools/uninstall.js");
    expect(uninstall).toContain("CodexManagerAlwaysOnline.cmd");
    expect(uninstall.indexOf("removeFile(startupLauncher)")).toBeLessThan(uninstall.indexOf("await requestRelayShutdown(config)"));
  });
});
