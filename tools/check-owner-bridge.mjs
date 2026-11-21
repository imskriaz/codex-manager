import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Real official app-server, isolated history, and a local inference fixture: no account or model calls.
const cli = process.argv[2];
assert.ok(cli, 'Pass the installed official Codex executable.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-bridge-real-'));
process.env.CODEX_HOME = root; process.env.CODEX_MANAGER_STORAGE_ROOT = root;
process.env.NODE_PATH = path.resolve('tools/node-vscode-shim');
const require = createRequire(import.meta.url); require('node:module').Module._initPaths();
const { ownerBridgeDirectory } = require('../out/services/codexOwnerBridge.js');
const { readNativeCodexSessionRunning, getNativeCodexSessionTurnId, startNativeCodexSessionTurn, steerNativeCodexSessionTurn, cancelNativeCodexSessionTurn, disposeNativeCodexSessionStatus } = require('../out/services/codexNativeSessionStatus.js');
const { SqliteStateStore, configureSqliteStateStore } = require('../out/storage/sqliteState.js');
const { coordinateCodexSessions } = require('../out/services/sessionCoordination.js');
const vscode = require('vscode');
vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'Owner fixture', index: 0 }];
const store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
const directory = ownerBridgeDirectory(); await fs.mkdir(directory, { recursive: true });
let inferenceRequests = 0;
const inference = createServer((request, response) => {
  if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
  inferenceRequests++;
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"fixture-response","status":"in_progress"}}\n\n');
});
await new Promise(resolve => inference.listen(0, '127.0.0.1', resolve));
const port = inference.address().port;
await fs.writeFile(path.join(root, 'config.toml'), `model="gpt-5.1-codex"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.resolve('tools/codex-owner-bridge.cjs'))}).run(${JSON.stringify(path.resolve(cli))},['app-server'],${JSON.stringify(directory)})`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let sequence = 0, stderr = '';
const pending = new Map();
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr.slice(-1000)}`)); }, 15_000);
  pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
createInterface({ input: child.stdout }).on('line', line => {
  const value = JSON.parse(line), request = pending.get(value.id);
  if (value.method === 'error') console.log('fixture error', JSON.stringify(value.params));
  if (!request) return; pending.delete(value.id); clearTimeout(request.timer);
  if (value.error) request.reject(new Error(value.error.message)); else request.resolve(value.result);
});
child.stderr.on('data', data => { stderr += data.toString(); });
try {
  await rpc('initialize', { clientInfo: { name: 'codex-manager-test', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const { thread: source } = await rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' });
  const { thread: destination } = await rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' });
  let initialDestinationTurn;
  await startNativeCodexSessionTurn(root, destination.id, { threadId: destination.id, input: [{ type: 'text', text: 'Create isolated destination history.' }] }, undefined, id => { initialDestinationTurn = id; });
  await cancelNativeCodexSessionTurn(root, destination.id, initialDestinationTurn);
  const previousInferenceRequests = inferenceRequests;
  assert.equal(await readNativeCodexSessionRunning(root, source.id, undefined, true), false);
  let sourceTurn;
  assert.equal(await startNativeCodexSessionTurn(root, source.id, { threadId: source.id, input: [{ type: 'text', text: 'Wait for a handover.' }] }, undefined, id => { sourceTurn = id; }), true);
  for (let attempt = 0; attempt < 200 && inferenceRequests === previousInferenceRequests; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(inferenceRequests > previousInferenceRequests, `The isolated turn reached the local inference fixture: ${stderr.slice(-1500)}`);
  assert.equal(await readNativeCodexSessionRunning(root, source.id, undefined, true), true);
  assert.equal(await steerNativeCodexSessionTurn(root, source.id, sourceTurn, [{ type: 'text', text: 'Keep the same task context.' }], root), true);
  const handover = { operation: 'handover', operationId: 'verified-handover', toSessionId: source.id, expectedTurnId: sourceTurn, handoverToSessionId: destination.id, text: 'Continue the source task after its confirmed Stop.', start: true };
  assert.equal((await coordinateCodexSessions(root, destination.id, handover)).control.status, 'completed');
  assert.equal((await coordinateCodexSessions(root, destination.id, handover)).control.status, 'completed');
  assert.equal(await readNativeCodexSessionRunning(root, source.id, undefined, true), false);
  assert.equal(await readNativeCodexSessionRunning(root, destination.id, undefined, true), true);
  const destinationTurn = getNativeCodexSessionTurnId(root, destination.id);
  assert.equal(await cancelNativeCodexSessionTurn(root, destination.id, destinationTurn), true);
  console.log(JSON.stringify({ officialAppServer: true, sameOwnerSend: true, steer: true, confirmedStop: true, coordinatedHandover: true, duplicateStartPrevented: true, inferenceRequests, externalModelCalls: 0 }));
} finally {
  disposeNativeCodexSessionStatus();
  for (const request of pending.values()) clearTimeout(request.timer);
  child.stdin.end();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(() => { child.kill(); resolve(); }, 2000))]);
  inference.closeAllConnections(); await new Promise(resolve => inference.close(resolve));
  configureSqliteStateStore(undefined); store.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
}
