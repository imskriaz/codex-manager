import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { BROWSER_OPERATIONS } from '../src/domain/workspaceBrowser';

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
    expect(list.result.tools.map((tool: any) => tool.name)).toContain("manager_workspace");
    expect(list.result.tools.map((tool: any) => tool.name)).toContain("manager_coordination");
    const browser = list.result.tools.find((tool: any) => tool.name === "manager_browser");
    expect(browser.inputSchema.properties.request.properties.operation.enum).toContain("feedback");
    expect([...browser.inputSchema.properties.request.properties.operation.enum].sort()).toEqual([...BROWSER_OPERATIONS].sort());
    expect((await send("unknown/method")).error.code).toBe(-32601);
    expect((await send("tools/call", { name: "unknown", arguments: {} })).result.isError).toBe(true);
  });
});

it('routes coordination through the scoped action and preserves message IDs and failures', async () => {
  const requests: any[] = []; let fail = false;
  const server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const value = JSON.parse(body); requests.push(value);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ messages: [{ type: 'dashboard:action-result', requestId: value.requestId, status: fail ? 'failed' : 'completed', error: fail ? 'Session belongs to another project' : undefined,
        payload: fail ? undefined : { sessionCoordination: { message: { id: value.payload.coordinationRequest.messageId } } } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await withClient(async send => {
      await send('initialize');
      const args = { projectPath: 'D:/demo', sessionId: 'self', request: { operation: 'send', toSessionId: 'peer', messageId: 'stable-id', text: 'Editing storage; please avoid the same files' } };
      expect((await send('tools/call', { name: 'manager_coordination', arguments: args })).result.isError).not.toBe(true);
      expect(requests[0]).toMatchObject({ action: 'coordinateCodexSessions', payload: { projectPath: args.projectPath, sessionId: 'self', coordinationRequest: args.request } });
      fail = true;
      const result = (await send('tools/call', { name: 'manager_coordination', arguments: args })).result;
      expect(result.isError).toBe(true); expect(result.content[0].text).toContain('another project');
      expect(requests[1].payload.coordinationRequest.messageId).toBe('stable-id');
    }, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('uses the selected surface execution device and waits for visible tab confirmation', async () => {
  const requests: any[] = [];
  const surface = { surfaceId: 'mobile', projectPath: 'D:/demo', sessionId: 'chat', targetDeviceId: 'worker' };
  let missing = false;
  let revision = 'current';
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', data => { body += data; });
    request.on('end', () => {
      const value = JSON.parse(body); requests.push(value);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ messages: [{ type: 'dashboard:action-result', requestId: value.requestId, status: 'completed',
        payload: value.action === 'workspacePanel' ? { workspacePanel: { surfaces: missing ? [] : [surface] } } : { workspaceBrowser: { pageId: 'new-page', revision, pages: [], feedback: [] } } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await withClient(async send => {
      await send('initialize');
      const call = () => send('tools/call', { name: 'manager_browser', arguments: { projectPath: 'D:/demo', targetDeviceId: 'dashboard-hub', surfaceId: 'mobile', sessionId: 'chat', request: { operation: 'open', url: 'https://example.test', operationId: 'open-attempt' } } });
      expect((await call()).result.isError).not.toBe(true);
      expect(requests.map(request => request.action)).toEqual(['workspacePanel', 'workspaceBrowser', 'workspacePanel', 'workspaceBrowser']);
      expect(requests[0].payload).toMatchObject({ targetDeviceId: 'dashboard-hub', panelRequest: { surfaceId: 'mobile', operation: 'read' } });
      expect(requests[1].payload).toMatchObject({ targetDeviceId: 'worker', browserRequest: { operation: 'open', url: 'about:blank' } });
      expect(requests[2].payload).toMatchObject({ targetDeviceId: 'dashboard-hub', panelRequest: { surfaceId: 'mobile', sessionId: 'chat', operation: 'select', tab: 'browser:new-page' } });
      expect(requests[3].payload).toMatchObject({ targetDeviceId: 'worker', browserRequest: { operation: 'navigate', pageId: 'new-page', revision: 'current', url: 'https://example.test' } });
      const originalNavigation = requests[3].payload.browserRequest;
      revision = 'after-navigation';
      requests.length = 0;
      expect((await call()).result.isError).not.toBe(true);
      expect(requests[3].payload.browserRequest).toEqual(originalNavigation);
      missing = true; requests.length = 0;
      expect((await call()).result.isError).toBe(true);
      expect(requests.map(request => request.action)).toEqual(['workspacePanel']);
    }, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each(['navigation-failure', 'preview-warning', 'close'] as const)('keeps panel presentation correct for %s', async scenario => {
  const requests: any[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', data => { body += data; });
    request.on('end', () => {
      const value = JSON.parse(body); requests.push(value);
      const operation = value.payload.browserRequest?.operation;
      const failed = scenario === 'navigation-failure' && operation === 'navigate';
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ messages: [{ type: 'dashboard:action-result', requestId: value.requestId,
        status: failed ? 'failed' : 'completed', error: failed ? 'Navigation was not confirmed' : undefined,
        payload: value.action === 'workspacePanel' ? { workspacePanel: { surfaces: [{ surfaceId: 'phone', sessionId: 'chat', activeTab: 'browser:page' }] } } :
          { workspaceBrowser: operation === 'close' ? { pages: [], feedback: [] } : { pageId: 'page', revision: 'revision', pages: [{ id: 'page' }], feedback: [], ...(scenario === 'preview-warning' && operation === 'navigate' ? { warning: 'Preview unavailable after redirect' } : {}) } }
      }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await withClient(async send => {
      await send('initialize');
      const result = (await send('tools/call', { name: 'manager_browser', arguments: { projectPath: 'D:/demo', surfaceId: 'phone', sessionId: 'chat', request: scenario === 'close' ? { operation: 'close', pageId: 'page', revision: 'revision' } : { operation: 'open', url: 'https://example.test', operationId: 'review-open' } } })).result;
      expect(requests[2].payload.panelRequest).toMatchObject({ operation: 'select', tab: scenario === 'close' ? 'env' : 'browser:page' });
      if (scenario === 'navigation-failure') {
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Navigation was not confirmed');
      } else {
        expect(result.isError).not.toBe(true);
        if (scenario === 'preview-warning') expect(JSON.parse(result.content[0].text).payload.workspaceBrowser.warning).toContain('Preview unavailable');
      }
      expect(requests.filter(value => value.payload.browserRequest?.operation === 'open')).toHaveLength(scenario === 'close' ? 0 : 1);
    }, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each([false, true])('delivers browser downloads only to the selected viewer and reports delivery failure: %s', async failed => {
  const requests: any[] = [];
  const fileDownload = { filename: 'fixture.txt', mimeType: 'text/plain', data: 'dmVyaWZpZWQ=' };
  const server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const value = JSON.parse(body); requests.push(value);
      const delivery = value.payload.panelRequest?.operation === 'download';
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ messages: [{ type:'dashboard:action-result',requestId:value.requestId,status:delivery && failed ? 'failed' : 'completed',error:delivery && failed ? 'Viewer disconnected' : undefined,
        payload:value.action === 'workspacePanel' ? {workspacePanel:{surfaces:[{surfaceId:'viewer',sessionId:'chat',targetDeviceId:'worker'}]}} : {workspaceBrowser:{pageId:'page',revision:'r',pages:[],feedback:[],fileDownload}} }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try { await withClient(async send => {
    await send('initialize');
    const result = (await send('tools/call',{name:'manager_browser',arguments:{projectPath:'D:/demo',surfaceId:'viewer',sessionId:'chat',targetDeviceId:'hub',request:{operation:'download',pageId:'page',revision:'r',url:'https://example.test/file'}}})).result;
    expect(requests[2].payload).toMatchObject({targetDeviceId:'hub',panelRequest:{operation:'download',surfaceId:'viewer',sessionId:'chat',fileDownload}});
    expect(requests.filter(row=>row.action === 'workspaceBrowser')).toHaveLength(1);
    if (failed) { expect(result.isError).toBe(true); expect(result.content[0].text).toContain('not confirmed'); }
    else { expect(result.isError).not.toBe(true); const state=JSON.parse(result.content[0].text).payload.workspaceBrowser; expect(state.downloadDelivery).toContain('selected viewer'); expect(state.fileDownload).toBeUndefined(); }
  },`http://127.0.0.1:${(server.address() as {port:number}).port}`); }
  finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
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
