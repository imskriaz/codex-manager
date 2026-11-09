import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";

assert.ok(process.argv.includes("--mutate"), "Pass --mutate for disposable browser and AI action checks.");
const sourceHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
for (const key of Object.keys(process.env)) if (key.startsWith("CODEX_MANAGER_")) delete process.env[key];
const root = await mkdtemp(path.join(tmpdir(), "manager-standalone-features-"));
const repository = path.resolve(import.meta.dirname, "..");
process.env.CODEX_MANAGER_STORAGE_ROOT = root;
process.env.NODE_PATH = path.join(repository, "tools", "node-vscode-shim");
const require = createRequire(import.meta.url); require("node:module").Module._initPaths();
const { SqliteStateStore, configureSqliteStateStore } = require("../out/storage/sqliteState.js");
const store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
for (const [key, value] of Object.entries({ webDashboardEnabled: true, cliIntegrationEnabled: true, apiAccessEnabled: true, autoResumeEnabled: false, autoSwitchEnabled: false, autoResetEnabled: false, autoRefreshMinutes: 0, autoRefreshCurrentMinutes: 0, encryptedSyncEnabled: false }))
  store.set("settings-overrides:global", key, value);
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`, admin = randomBytes(32).toString("hex");
let host, hostDone;
let switchAccounts;
function run(script, args, environment, cwd) {
  const child = spawn(process.execPath, [path.join(repository, "tools", script), ...args], { env: environment, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => process.stdout.write(chunk)); child.stderr.on("data", chunk => process.stderr.write(chunk));
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { child, done };
}
try {
  for (const name of ["auth.json", "config.toml", "models_cache.json"]) await copyFile(path.join(sourceHome, name), path.join(root, name)).catch(error => { if (error.code !== "ENOENT") throw error; });
  const auth = JSON.parse(await readFile(path.join(root, 'auth.json'), 'utf8'));
  if (auth.tokens) auth.tokens.refresh_token = "";
  await writeFile(path.join(root, 'auth.json'), JSON.stringify(auth));
  if (process.argv.includes('--account-switch')) {
    const source = new (require('node:sqlite').DatabaseSync)(path.join(sourceHome, 'manager.sqlite'), { readOnly: true });
    try {
      const accounts = source.prepare('SELECT data FROM accounts').all().map(row => JSON.parse(row.data));
      const candidates = accounts.flatMap(account => {
        const secret = source.prepare('SELECT value FROM state WHERE namespace=? AND key=?').get('secrets', 'codex.account.' + account.id);
        if (!secret) return [];
        const raw = JSON.parse(secret.value);
        if (typeof raw !== 'string') return [];
        const tokens = JSON.parse(raw);
        try { if (JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64url')).exp * 1000 < Date.now() + 300000) return []; } catch { return []; }
        return [{ account: { ...account, enabled: true, tokenRefreshEnabled: false }, tokens: { ...tokens, refreshToken: '' } }];
      });
      const exhausted = candidates.find(({ account }) => account.quotaSummary?.hourlyPercentage === 0 || account.quotaSummary?.weeklyPercentage === 0);
      const healthy = candidates.find(({ account }) => account.quotaSummary?.hourlyPercentage > 10 && account.quotaSummary?.weeklyPercentage > 10);
      assert.ok(exhausted && healthy, 'Account-switch check needs two unexpired saved logins: exhausted and available.');
      switchAccounts = [exhausted, healthy];
      require('../out/storage/sqliteAccounts.js').saveAccountIndex(store, { accounts: switchAccounts.map(item => item.account), currentAccountId: exhausted.account.id });
      for (const item of switchAccounts) store.set('secrets', 'codex.account.' + item.account.id, JSON.stringify(item.tokens));
      await writeFile(path.join(root, 'auth.json'), JSON.stringify({ tokens: { id_token: exhausted.tokens.idToken, access_token: exhausted.tokens.accessToken, refresh_token: '', account_id: exhausted.tokens.accountId } }));
    } finally { source.close(); }
  }
  await require("../out/utils/crossWindowOperations.js").configureCrossWindowOperationCoordinator(root);
  if (!process.argv.includes("--ai-proxy")) {
    const cli = await require("../out/services/codexCliRuntime.js").installManagedCodexCli();
    store.set("settings-overrides:global", "codexCliPath", cli);
  }
  const environment = { ...process.env, CODEX_HOME: root, CODEX_MANAGER_PORT: String(port), CODEX_MANAGER_WORKSPACE_STORAGE: root, CODEX_MANAGER_ADMIN_TOKEN: admin, CODEX_MANAGER_HANDOFF: "", CODEX_MANAGER_UI_URL: origin };
  delete environment.CODEX_CLI_PATH;
  await mkdir(path.join(root, "workspace"));
  ({ child: host, done: hostDone } = run("start-node.cjs", [], environment, path.join(root, "workspace")));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(origin + "/api/state", { signal: AbortSignal.timeout(1000) })).status === 200) break; } catch { /* Wait for the disposable host. */ }
    if (host.exitCode !== null || Date.now() > deadline) throw new Error("Standalone fixture did not become ready.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const action = async (name, payload = {}) => {
    const requestId = randomBytes(16).toString("hex");
    const response = await fetch(`${origin}/api/message`, { method: "POST", headers: { "content-type": "application/json", "x-codex-dashboard": "1", origin }, body: JSON.stringify({ type: "dashboard:action", action: name, requestId, payload, ...(payload.accountId ? { accountId: payload.accountId } : {}) }), signal: AbortSignal.timeout(120_000) });
    assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
    const result = (await response.json()).messages.find(message => message.type === "dashboard:action-result" && message.requestId === requestId);
    assert.equal(result?.status, "completed", result?.error || `${name}: missing result`);
    return result.payload;
  };
  if (process.argv.includes('--account-switch')) {
    const [exhausted, healthy] = switchAccounts;
    for (const item of switchAccounts) await action('refresh', { accountId: item.account.id });
    const switched = await action('switch', { accountId: healthy.account.id });
    assert.equal(switched.reloadScheduled, false, 'Standalone switch applies without an editor reload');
    const reload = await action('reloadPrompt', { forceReload: true });
    assert.equal(reload.reloadScheduled, false);
    await action('switch', { accountId: exhausted.account.id });
    store.set('settings-overrides:global', 'autoSwitchEnabled', true);
    await action('setAutoSwitchLock', { accountId: exhausted.account.id, lockMinutes: 0 });
    await action('refresh', { accountId: exhausted.account.id });
    const deadline = Date.now() + 30000;
    let state;
    do {
      state = await (await fetch(origin + '/api/state')).json();
      if (state.accounts.find(account => account.isActive)?.id === healthy.account.id) break;
      assert.ok(Date.now() < deadline, 'Standalone did not automatically select the verified available account');
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (true);
    assert.equal(JSON.parse(await readFile(path.join(root, 'auth.json'), 'utf8')).tokens.access_token, healthy.tokens.accessToken, 'Switch writes the selected saved credentials');
    const started = await action('startCodexCliSession', { projectPath: path.join(root, 'workspace'), text: 'Reply exactly SWITCH OK. Do not use tools or create goals.' });
    const sessionId = started.cliSession.id;
    const responseDeadline = Date.now() + 120000;
    for (;;) {
      const history = await action('getCodexCliSessionMessages', { sessionId });
      if (history.cliSessionLive?.status === 'completed') { assert.ok(history.cliSessionMessages.some(message => message.role === 'assistant' && message.text.includes('SWITCH OK'))); break; }
      assert.notEqual(history.cliSessionLive?.status, 'failed', history.cliSessionLive?.error);
      assert.ok(Date.now() < responseDeadline, 'Post-switch execution timed out');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.equal(host.exitCode, null, 'Account switches and Reload keep the same standalone host alive');
    await action('archiveCodexCliSession', { sessionId });
    await action('deleteCodexCliSession', { sessionId, confirmed: true });
    console.log('PASS standalone real-account switch, Reload, automatic quota switch, post-switch execution, archive and delete on the same host');
  } else if (process.argv.includes('--ai-proxy')) {
    await action('importCurrent');
    const token = (await action('generateApiToken', {tokenName:'Disposable proxy check',tokenPermissions:['aiProxy']})).apiToken;
    assert.ok(token);
    const headers = {Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    let started=performance.now();
    const discovery=await fetch(origin+'/v1/models',{headers,signal:AbortSignal.timeout(30000)});
    const catalogue=await discovery.json(); assert.equal(discovery.status,200,JSON.stringify(catalogue));
    const model=catalogue.data[0]?.id;assert.ok(model);
    console.log(JSON.stringify({check:'model discovery',ms:Math.round(performance.now()-started),count:catalogue.data.length}));
    const claudeModels=await fetch(origin+'/v1/models?limit=1',{headers:{'x-api-key':token,'anthropic-version':'2023-06-01'},signal:AbortSignal.timeout(30000)}).then(r=>r.json());
    assert.equal(claudeModels.data[0].type,'model');
    for(const [endpoint,body] of [
      ['/v1/chat/completions',{model,messages:[{role:'user',content:'Reply exactly PROXY_OK.'}]}],
      ['/v1/responses',{model,input:'Reply exactly PROXY_OK.'}],
      ['/v1/messages',{model,max_tokens:128,messages:[{role:'user',content:'Reply exactly PROXY_OK.'}]}],
    ]) for(const stream of [false,true]) {
      started=performance.now();
      const result=await fetch(origin+endpoint,{method:'POST',headers,body:JSON.stringify({...body,stream}),signal:AbortSignal.timeout(180000)});
      const firstByte=performance.now();const text=await result.text();assert.equal(result.status,200,text);
      const chunks=stream?text.split('\n').filter(line=>line.startsWith('data: ')&&!line.includes('[DONE]')).map(line=>JSON.parse(line.slice(6))):[];
      const answer=endpoint.endsWith('completions')?chunks.map(item=>item.choices?.[0]?.delta?.content||'').join(''):endpoint.endsWith('messages')?chunks.map(item=>item.delta?.text||'').join(''):chunks.filter(item=>item.type==='response.output_text.delta').map(item=>item.delta).join('');
      assert.ok(stream?answer.includes('PROXY_OK'):text.includes('PROXY_OK'),text);
      assert.ok(!text.includes('event: error'),text);
      console.log(JSON.stringify({check:endpoint,stream,headersMs:Math.round(firstByte-started),totalMs:Math.round(performance.now()-started)}));
    }
    const tool=await fetch(origin+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model,messages:[{role:'user',content:'Call the echo function with value OK.'}],tools:[{type:'function',function:{name:'echo',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},strict:true}}],tool_choice:{type:'function',function:{name:'echo'}}}),signal:AbortSignal.timeout(180000)});
    const toolResult=await tool.json();assert.equal(tool.status,200,JSON.stringify(toolResult));assert.equal(toolResult.choices[0].message.tool_calls[0].function.name,'echo');
    const followup=await fetch(origin+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model,messages:[{role:'user',content:'Call echo with OK, then say PROXY_TOOL_OK after receiving the result.'},toolResult.choices[0].message,{role:'tool',tool_call_id:toolResult.choices[0].message.tool_calls[0].id,content:'OK'}]}),signal:AbortSignal.timeout(180000)});
    const followupText=await followup.text();assert.equal(followup.status,200,followupText);assert.ok(followupText.includes('PROXY_TOOL_OK'),followupText);
    const claudeTool=await fetch(origin+'/v1/messages',{method:'POST',headers:{'x-api-key':token,'content-type':'application/json','anthropic-version':'2023-06-01'},body:JSON.stringify({model,max_tokens:128,messages:[{role:'user',content:'Call echo with OK.'}],tools:[{name:'echo',input_schema:{type:'object',properties:{value:{type:'string'}},required:['value']}}],tool_choice:{type:'tool',name:'echo'}}),signal:AbortSignal.timeout(180000)});
    const claudeToolResult=await claudeTool.json();assert.equal(claudeTool.status,200,JSON.stringify(claudeToolResult));assert.ok(claudeToolResult.content.some(item=>item.type==='tool_use'&&item.name==='echo'));
    const image=await readFile(path.join(repository,'media','product-icons','codex-openai.png'));
    const vision=await fetch(origin+'/v1/messages',{method:'POST',headers,body:JSON.stringify({model,max_tokens:128,messages:[{role:'user',content:[{type:'text',text:'Reply exactly PROXY_IMAGE_OK.'},{type:'image',source:{type:'base64',media_type:'image/png',data:image.toString('base64')}}]}]}),signal:AbortSignal.timeout(180000)});
    const visionText=await vision.text();assert.equal(vision.status,200,visionText);assert.ok(visionText.includes('PROXY_IMAGE_OK'),visionText);
    console.log('PASS live OpenAI/Responses/Claude discovery, non-streaming, streaming, client tool calls/results and image input without VS Code or CLI');
  } else if (process.argv.includes('--restart-recovery')) {
    store.set('settings-overrides:global', 'autoResumeEnabled', true);
    store.set('settings-overrides:global', 'autoSwitchEnabled', true);
    const created = await action('startCodexCliSession', { projectPath: path.join(root, 'workspace'), sandboxMode: 'danger-full-access', autoApprove: true,
      text: 'This is a disposable restart test. Run node -e "setTimeout(()=>{},30000)" exactly once. After it finishes or is interrupted, reply exactly RESTART RECOVERY OK. If you receive Continue if not completed, do not repeat the command; just reply RESTART RECOVERY OK. Do not create goals or change files.' });
    const sessionId = created.cliSession.id;
    const deadline = Date.now() + 90_000;
    while (true) {
      const history = await action('getCodexCliSessionMessages', { sessionId });
      if ([...history.cliSessionMessages, ...(history.cliSessionLive?.messages ?? [])].some(message => message.role !== 'user' && message.kind === 'command' && /setTimeout/.test(JSON.stringify(message)))) break;
      assert.ok(Date.now() < deadline, 'Restart fixture did not start its command');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    // Remove the fixture's prior periodic snapshot to exercise the final shutdown save.
    const namespace = 'workspace:' + createHash('sha256').update(require('vscode').Uri.file(root).fsPath).digest('hex');
    for (const key of ['codexManager.autoResumeSessionIds', 'codexManager.autoResumeOpenSessionIds']) store.set(namespace, key, []);
    await fetch(origin + '/shutdown', { method: 'POST', headers: { 'X-Codex-Admin': admin }, signal: AbortSignal.timeout(3000) });
    assert.equal(await hostDone, 0, 'Standalone shutdown completed');
    assert.ok(['codexManager.autoResumeSessionIds', 'codexManager.autoResumeOpenSessionIds'].some(key => store.get(namespace, key)?.includes(sessionId)), 'Final shutdown captured the active session');
    console.log('PASS graceful shutdown saved active work with an empty prior snapshot');
    ({ child: host, done: hostDone } = run('start-node.cjs', [], environment, path.join(root, 'workspace')));
    const restartDeadline = Date.now() + 120_000;
    for (;;) {
      try {
        const history = await action('getCodexCliSessionMessages', { sessionId });
        if (history.cliSessionLive?.status === 'completed' && history.cliSessionMessages.some(message => message.role === 'assistant' && message.text.includes('RESTART RECOVERY OK'))) {
          assert.ok(history.cliSessionMessages.filter(message => message.role === 'user' && message.text.trim() === 'Continue if not completed').length <= 1, 'Recovery sent at most one continuation');
          break;
        }
      } catch (error) { if (host.exitCode !== null) throw error; }
      assert.ok(Date.now() < restartDeadline, 'Session did not complete after standalone restart');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    await action('archiveCodexCliSession', { sessionId });
    await action('deleteCodexCliSession', { sessionId, confirmed: true });
    assert.ok(!(await action('listCodexCliSessions')).cliSessions.some(session => session.id === sessionId));
    console.log('PASS restarted standalone continued, archived and deleted its test session');
  } else {
  const taskProject = path.join(root, "workspace");
  await action('importCurrent');
  console.log('PASS standalone current account import');
  const taskId = "standalone-play-check";
  const saved = await action("saveProjectTask", { projectPath: taskProject, task: { id: taskId, title: "Standalone play", prompt: "Reply exactly STANDALONE PLAY OK. Do not use tools or modify files.", stage: "planned", expectedRevision: 0 } });
  const started = await action("startProjectTask", { projectPath: taskProject, taskId, taskRevision: saved.projectBoard.tasks.find(task => task.id === taskId)?.revision });
  const taskSessionId = started.projectBoard.tasks.find(task => task.parentTaskId === taskId)?.sessionId;
  assert.ok(taskSessionId, "Standalone task play must create a session");
  const turnDeadline = Date.now() + 120_000;
  for (;;) {
    const history = await action('getCodexCliSessionMessages', { sessionId: taskSessionId });
    if (['completed', 'failed', 'cancelled', 'disconnected'].includes(history.cliSessionLive?.status)) {
      assert.equal(history.cliSessionLive.status, 'completed', history.cliSessionLive.error);
      assert.ok(history.cliSessionMessages.some(message => message.role === 'assistant' && message.text.includes('STANDALONE PLAY OK')));
      break;
    }
    assert.ok(Date.now() < turnDeadline, 'Standalone task Play response timed out.');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  console.log('PASS standalone project-task Play and first response');
  await action("deleteCodexCliSession", { sessionId: taskSessionId, confirmed: true });
  const state = await (await fetch(`${origin}/api/state`)).json();
  const active = state.accounts.find(account => account.isActive);
  assert.ok(active, "Standalone host exposes an active account");
  await action('refresh', { accountId: active.id });
  console.log('PASS standalone manual quota refresh');
  const switched = await action("switch", { accountId: active.id });
  assert.match(switched.notice?.message ?? "", /already active|Switched to/i, "Standalone account switch must complete without a VS Code reload");
  const reloaded = await action('reloadPrompt', { forceReload: true });
  assert.equal(reloaded.reloadScheduled, false);
  assert.equal((await (await fetch(`${origin}/api/state`)).json()).accounts.find(account => account.isActive)?.id, active.id);
  console.log('PASS standalone account switch and Reload state refresh');
  const result = await run("check-live-actions.mjs", ["--mutate"], environment, repository).done;
  assert.equal(result, 0, "Standalone browser feature checks failed.");
  console.log(JSON.stringify({ passed: true, host: "standalone", cli: "fresh-managed-install", vsCodeRequired: false }));
  }
} finally {
  if (host && host.exitCode === null) {
    try { await fetch(origin + "/shutdown", { method: "POST", headers: { "X-Codex-Admin": admin }, signal: AbortSignal.timeout(3000) }); } catch { host.kill(); }
    await hostDone;
  }
  configureSqliteStateStore(undefined); store.close();
  assert.ok(root.startsWith(tmpdir() + path.sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
