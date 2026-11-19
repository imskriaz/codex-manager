import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { expect, it } from "vitest";

async function withClient(
  run: (send: (method: string, params?: unknown) => Promise<any>) => Promise<void>,
  url?: string
) {
  const child = spawn(process.execPath, ["tools/codex-manager-mcp.mjs"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_MANAGER_TOKEN: "test-token", CODEX_MANAGER_URL: url || "http://127.0.0.1:1" }
  });
  const pending = new Map<number, (value: any) => void>();
  let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => reject(new Error("MCP response timed out")), 5000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    await run(send);
  } finally {
    child.stdin.end();
    child.kill();
    lines.close();
  }
}

it("requires initialization, negotiates a supported version, and discovers shared browser tools", async () => {
  await withClient(async (send) => {
    expect((await send("tools/list")).error.code).toBe(-32002);
    const init = await send("initialize", { protocolVersion: "not-supported" });
    expect(init.result.protocolVersion).toBe("2025-11-25");
    const list = await send("tools/list");
    expect(list.result.tools.map((tool: any) => tool.name)).toContain("manager_browser");
    const browser = list.result.tools.find((tool: any) => tool.name === "manager_browser");
    expect(browser.inputSchema.properties.request.properties.operation.enum).toContain("feedback");
    expect((await send("unknown/method")).error.code).toBe(-32601);
    expect((await send("tools/call", { name: "unknown", arguments: {} })).result.isError).toBe(true);
  });
});

it("preserves Manager permissions/results, account targets and unknown-outcome errors", async () => {
  const requests: any[] = [];
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe("Bearer test-token");
    let body = "";
    request.on("data", (data) => {
      body += data;
    });
    request.on("end", () => {
      const value = body ? JSON.parse(body) : {};
      requests.push(value);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          messages:
            value.action === "unknown"
              ? []
              : [
                  {
                    type: "dashboard:action-result",
                    requestId: value.requestId,
                    status: value.action === "remove" ? "failed" : "completed",
                    error: value.action === "remove" ? "Confirm removal" : undefined,
                    payload: {}
                  }
                ]
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await withClient(async (send) => {
      await send("initialize");
      const call = (action: string) =>
        send("tools/call", { name: "manager_action", arguments: { action, accountId: "account-one" } });
      expect((await call("refresh")).result.isError).not.toBe(true);
      expect(requests[0].accountId).toBe("account-one");
      const failed = await call("remove");
      expect(failed.result.isError).toBe(true);
      expect(failed.result.content[0].text).toContain("Confirm removal");
      const unknown = await call("unknown");
      expect(unknown.result.isError).toBe(true);
      expect(unknown.result.content[0].text).toContain("unknown outcome");
    }, `http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("routes manager_browser through the selected remote device", async () => {
  const requests: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", data => { body += data; });
    request.on("end", () => {
      const value = JSON.parse(body);
      requests.push(value);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ messages: [{
        type: "dashboard:action-result",
        requestId: value.requestId,
        status: "completed",
        payload: { workspaceBrowser: { pages: [{ id: "remote-page", url: "https://example.com", revision: "1" }], feedback: [] } }
      }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await withClient(async send => {
      await send("initialize");
      const result = await send("tools/call", {
        name: "manager_browser",
        arguments: {
          projectPath: "D:/remote-project",
          targetDeviceId: "remote-device",
          request: { operation: "list" }
        }
      });
      expect(result.result.isError).not.toBe(true);
    }, `http://127.0.0.1:${address.port}`);
    expect(requests[0]).toMatchObject({
      action: "workspaceBrowser",
      payload: {
        projectPath: "D:/remote-project",
        targetDeviceId: "remote-device",
        browserRequest: { operation: "list", openedBy: "ai" }
      }
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
