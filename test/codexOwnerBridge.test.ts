import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { clearOwnerBridgeState, getOwnerBridgeState, ownerBridgeDirectory, readOwnerBridgeState, requestOwnerBridge } from '../src/services/codexOwnerBridge';
vi.unmock('../src/services/codexNativeSessionStatus');
import { cancelNativeCodexSessionTurn, getNativeCodexSessionTurnId, readNativeCodexSessionRunning, startNativeCodexSessionTurn, steerNativeCodexSessionTurn, waitForNativeCodexSessionReady } from '../src/services/codexNativeSessionStatus';

const id = '01a04882-d037-7a42-ad24-9afb61901188';
let root: string, directory: string, child: ChildProcessWithoutNullStreams;
let messages: any[], stderr: string;
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 300; i++) { if (await check()) return; await pause(); } throw new Error(`Bridge check timed out: ${stderr}`); }
const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-owner-'));
  vi.stubEnv('CODEX_MANAGER_STORAGE_ROOT', root);
  directory = ownerBridgeDirectory(); await fs.mkdir(directory, { recursive: true });
  const fixture = path.join(root, 'fake-codex.cjs');
  await fs.writeFile(fixture, `
const {createInterface}=require('node:readline');
let turn, running=false, starts=0;
const thread=()=>({id:'${id}',path:require('node:path').join(process.env.CODEX_HOME,'sessions','rollout.jsonl'),cwd:process.env.CODEX_HOME,status:{type:running?'active':'idle'},turns:turn?[{id:turn,status:running?'inProgress':'interrupted'}]:[]});
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);let result={};
if(q.method==='thread/loaded/list')result={data:['${id}']};
else if(q.method==='thread/read')result={thread:thread()};
else if(q.method==='turn/start'){starts++;require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'starts.txt'),String(starts));if(q.params.input?.[0]?.text==='Disconnect after dispatch')process.exit(0);turn='turn-'+starts;running=true;result={turn:{id:turn}};setTimeout(()=>process.stdout.write(JSON.stringify({method:'turn/started',params:{threadId:'${id}',turn:{id:turn,status:'inProgress'}}})+'\\n'),100);}
else if(q.method==='turn/steer')result={turnId:turn};
else if(q.method==='turn/interrupt'){setTimeout(()=>{running=false;process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'${id}',turn:{id:turn,status:'interrupted'}}})+'\\n');},60);}
else if(q.method==='fixture/stats')result={starts,running};
if(q.id!==undefined)process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
});
`);
  messages = []; stderr = '';
  child = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.resolve('tools/codex-owner-bridge.cjs'))}).run(process.execPath,[${JSON.stringify(fixture)}],${JSON.stringify(directory)})`], {
    env: { ...process.env, CODEX_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  createInterface({ input: child.stdout }).on('line', line => messages.push(JSON.parse(line)));
  child.stderr.on('data', data => { stderr += data.toString(); });
  send({ id: 1, method: 'initialize', params: {} }); send({ method: 'initialized', params: {} });
  await until(async () => (await fs.readdir(directory)).some(name => name.endsWith('.json')) && messages.some(message => message.id === 1));
});
afterEach(async () => {
  clearOwnerBridgeState(); child.stdin.end();
  await until(() => child.exitCode !== null);
  vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true });
});

it('sends, steers and confirms Stop on the same owner while preserving the official stdio stream', async () => {
  expect(await readNativeCodexSessionRunning(root, id, undefined, true)).toBe(false);
  expect(await waitForNativeCodexSessionReady(root, id, undefined, 500)).toBe(true);
  const started = vi.fn(), stopped = vi.fn();
  expect(await startNativeCodexSessionTurn(root, id, { threadId: id, input: [{ type: 'text', text: 'Continue বাংলা' }] }, undefined, started)).toBe(true);
  expect(started).toHaveBeenCalledWith('turn-1');
  expect(await readNativeCodexSessionRunning(root, id, undefined, true)).toBe(true);
  expect(getNativeCodexSessionTurnId(root, id)).toBe('turn-1');
  await readNativeCodexSessionRunning(root, '01a04882-d037-7a42-ad24-9afb61901199');
  expect(getNativeCodexSessionTurnId(root, id)).toBe('turn-1');
  expect(await steerNativeCodexSessionTurn(root, id, 'turn-1', [{ type: 'text', text: 'Guidance' }], root)).toBe(true);
  expect(await cancelNativeCodexSessionTurn(root, id, 'turn-1', stopped)).toBe(true);
  expect(stopped).toHaveBeenCalledOnce();
  expect(await readNativeCodexSessionRunning(root, id, undefined, true)).toBe(false);
  send({ id: 2, method: 'fixture/stats' }); await until(() => messages.some(message => message.id === 2));
  expect(messages.find(message => message.id === 2).result).toEqual({ starts: 1, running: false });
  expect(messages.filter(message => message.id !== undefined)).toHaveLength(2);
});

it('refuses changed turns, duplicate starts, unknown methods and a different home', async () => {
  await requestOwnerBridge(root, id, 'turn/start', { threadId: id, input: [] });
  await expect(requestOwnerBridge(root, id, 'turn/start', { threadId: id, input: [] })).rejects.toThrow('already running');
  await expect(requestOwnerBridge(root, id, 'turn/interrupt', { threadId: id, turnId: 'newer' })).rejects.toThrow('changed');
  await expect(requestOwnerBridge(root, id, 'thread/delete', { threadId: id })).rejects.toThrow('Unsupported');
  const otherHome = path.join(root, 'other'); await fs.mkdir(otherHome);
  expect(await readOwnerBridgeState(otherHome, id)).toBeUndefined();
  expect(await readOwnerBridgeState(root, '01a04882-d037-7a42-ad24-9afb61901199')).toBeUndefined();
});

it('requires its private capability before exposing a conversation', async () => {
  await readOwnerBridgeState(root, id);
  const entry = getOwnerBridgeState(root, id)!;
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(entry.owner.endpoint); let buffer = '';
    socket.on('error', reject); socket.on('data', data => { buffer += data.toString(); }); socket.on('end', () => resolve(buffer));
    socket.on('connect', () => socket.write(JSON.stringify({ token: 'wrong', threadId: id, method: 'status' }) + '\n'));
  });
  expect(JSON.parse(reply)).toEqual({ error: 'Codex owner authorization failed.' });
});

it('leaves no discovery record after the official client disconnects', async () => {
  child.stdin.end(); await until(() => child.exitCode !== null);
  expect(await fs.readdir(directory)).toEqual([]);
  expect(await readOwnerBridgeState(root, id)).toBeUndefined();
});

it('preserves an uncertain start without replaying after its owner disconnects', async () => {
  await expect(startNativeCodexSessionTurn(root, id, { threadId: id, input: [{ type: 'text', text: 'Disconnect after dispatch' }] })).rejects.toThrow(/unconfirmed|disconnected/i);
  expect(await fs.readFile(path.join(root, 'starts.txt'), 'utf8')).toBe('1');
  await until(() => child.exitCode !== null);
  expect(messages).toHaveLength(1);
});

it('cancels before dispatch without starting any turn', async () => {
  const controller = new AbortController(); controller.abort(new Error('Cancelled before send'));
  await expect(startNativeCodexSessionTurn(root, id, { threadId: id, input: [] }, controller.signal)).rejects.toThrow('Cancelled');
  expect(await fs.stat(path.join(root, 'starts.txt')).then(() => true, () => false)).toBe(false);
});
