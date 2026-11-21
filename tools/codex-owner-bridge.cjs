// Keep VS Code's stdio connection intact and route dashboard controls to that same owner.
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { createInterface } = require('node:readline');

function run(cli, args, directory) {
  const home = fs.realpathSync(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const token = randomUUID(), prefix = `manager-${randomUUID()}-`;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\codex-manager-owner-${randomUUID()}` : path.join(directory, `${process.pid}.sock`);
  const record = path.join(directory, `${process.pid}.json`);
  const child = spawn(cli, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const requests = new Map();
  const turns = new Map();
  const startedTurns = new Map();
  const ideStarts = new Map();
  let nextId = 0, initialized = false;
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (requests.size >= 32) { reject(new Error('Codex owner is busy.')); return; }
    const id = prefix + ++nextId;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('Codex owner confirmation timed out.')); }, 10_000);
    requests.set(id, { resolve, reject, timer, method, params });
    send({ id, method, params });
  });
  const status = async id => {
    const loaded = await rpc('thread/loaded/list', {});
    if (!Array.isArray(loaded.data) || !loaded.data.includes(id)) return undefined;
    // Current paginated-history servers reject includeTurns; live events carry the active turn.
    const { thread } = await rpc('thread/read', { threadId: id, includeTurns: false });
    const relative = typeof thread?.path === 'string' ? path.relative(home, path.resolve(thread.path)) : '..';
    if (thread?.id !== id || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('The Codex conversation belongs to another home.');
    const turn = turns.get(id);
    return { ...thread, ...(turn ? { status: { type: turn.status === 'inProgress' ? 'active' : 'idle' }, turns: [turn] } : {}) };
  };
  const server = net.createServer(socket => {
    let buffer = '', handled = false;
    socket.setEncoding('utf8');
    socket.setTimeout(25_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { socket.destroy(); return; }
      if (!buffer.includes('\n') || handled) return;
      handled = true;
      void (async () => {
        const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        const supplied = Buffer.from(typeof request.token === 'string' ? request.token : '');
        if (supplied.length !== Buffer.byteLength(token) || !timingSafeEqual(supplied, Buffer.from(token))) throw new Error('Codex owner authorization failed.');
        if (!initialized || !/^[0-9a-f-]{36}$/i.test(request.threadId)) throw new Error('Codex owner is not ready.');
        const thread = await status(request.threadId);
        if (!thread) return { owned: false };
        if (request.method === 'status') return { owned: true, thread };
        if (!['turn/start', 'turn/steer', 'turn/interrupt', 'thread/goal/set'].includes(request.method)) throw new Error('Unsupported Codex owner operation.');
        const params = request.params;
        if (!params || params.threadId !== request.threadId) throw new Error('Codex owner thread mismatch.');
        const turn = thread.turns?.at(-1);
        if (request.method === 'turn/start' && (thread.status?.type === 'active' || turn?.status === 'inProgress')) throw new Error('This Codex conversation is already running.');
        if (['turn/steer', 'turn/interrupt'].includes(request.method) && (turn?.status !== 'inProgress' || turn.id !== (params.expectedTurnId ?? params.turnId))) throw new Error('The active Codex turn changed.');
        if (request.method === 'thread/goal/set' && params.status !== 'paused') throw new Error('Only goal pause is permitted through this control.');
        // turn/start can acknowledge while Codex is still preparing execution. Interrupt it once ready.
        if (request.method === 'turn/interrupt') {
          const deadline = Date.now() + 8000;
          while (turns.get(request.threadId)?.id === params.turnId && startedTurns.get(request.threadId) !== params.turnId && turns.get(request.threadId)?.status === 'inProgress' && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 20));
          if (turns.get(request.threadId)?.id === params.turnId && turns.get(request.threadId)?.status !== 'inProgress') return { owned: true, result: {} };
          if (turns.get(request.threadId)?.id !== params.turnId) throw new Error('The active Codex turn changed.');
          if (startedTurns.get(request.threadId) !== params.turnId) throw new Error('Codex has not finished preparing this turn. Stop was not dispatched.');
        }
        return { owned: true, result: await rpc(request.method, params) };
      })().then(result => socket.end(JSON.stringify(result) + '\n'), error => socket.end(JSON.stringify({ error: error.message }) + '\n'));
    });
  });
  const cleanup = () => {
    try { fs.unlinkSync(record); } catch { /* An exited owner has no discoverable endpoint. */ }
    for (const item of requests.values()) { clearTimeout(item.timer); item.reject(new Error('Codex owner disconnected; the outcome is unconfirmed.')); }
    requests.clear(); server.close();
  };
  server.on('error', error => { process.stderr.write(`Codex Manager owner bridge: ${error.message}\n`); });
  server.listen(endpoint, () => {
    if (process.platform !== 'win32') fs.chmodSync(endpoint, 0o600);
    fs.writeFileSync(record, JSON.stringify({ endpoint, token, home, pid: process.pid }), { mode: 0o600 });
  });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    let value;
    try { value = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
    if (['turn/started', 'turn/completed'].includes(value.method) && value.params?.threadId && value.params?.turn?.id) {
      turns.set(value.params.threadId, value.params.turn);
      if (value.method === 'turn/started') startedTurns.set(value.params.threadId, value.params.turn.id);
    }
    if (value.method === 'thread/unloaded') { turns.delete(value.params?.threadId); startedTurns.delete(value.params?.threadId); }
    const pending = requests.get(value.id);
    if (pending) {
      if (pending.method === 'turn/start' && value.result?.turn?.id && turns.get(pending.params.threadId)?.id !== value.result.turn.id) turns.set(pending.params.threadId, { ...value.result.turn, status: 'inProgress' });
      requests.delete(value.id); clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error(value.error.message || 'Codex owner rejected the request.'));
      else pending.resolve(value.result);
      return;
    }
    const starting = ideStarts.get(value.id);
    if (starting) {
      ideStarts.delete(value.id);
      if (value.result?.turn?.id && turns.get(starting)?.id !== value.result.turn.id) turns.set(starting, { ...value.result.turn, status: 'inProgress' });
    }
    // Never leak bridge RPC replies into the IDE, including replies arriving after timeout.
    if (typeof value.id === 'string' && value.id.startsWith(prefix)) return;
    if (value.method === 'initialized') initialized = true;
    process.stdout.write(line + '\n');
  });
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    try {
      const value = JSON.parse(line);
      if (value.method === 'initialized') initialized = true;
      if (value.method === 'turn/start' && value.id !== undefined && value.params?.threadId) ideStarts.set(value.id, value.params.threadId);
    } catch { /* Forward the original protocol. */ }
    child.stdin.write(line + '\n');
  }).on('close', () => { cleanup(); child.stdin.end(); });
  child.on('error', error => { process.stderr.write(error.message + '\n'); cleanup(); process.exitCode = 1; });
  child.on('exit', code => { cleanup(); process.exit(code ?? 1); });
}

module.exports = { run };
if (require.main === module) {
  const [configPath, ...args] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  run(config.cli, args, path.dirname(configPath));
}
