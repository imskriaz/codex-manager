import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Exercise restart interruption on a disposable host, never the user's dashboard.
const fixture = await mkdtemp(path.join(os.tmpdir(), 'manager-update-'));
const storage = path.join(fixture, 'data with spaces');
const require = createRequire(import.meta.url);
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith('CODEX_MANAGER_')) delete environment[key];
const pending = new Set();
let port;
let token;

function launch(script, args = [], env = {}) {
  const child = spawn(process.execPath, [path.join(fixture, 'tools', script), ...args], {
    env: { ...environment, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  pending.add(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { pending.delete(child); resolve({ code, output }); });
  });
  return { child, done };
}

async function until(check) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = await check().catch(() => false);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Disposable host did not reach the expected state.');
}
async function state() {
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
  return response.json();
}
async function stop() {
  await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { 'X-Codex-Admin': token }, signal: AbortSignal.timeout(500) });
  await until(async () => { try { await state(); return false; } catch { return true; } });
}

try {
  await mkdir(path.join(fixture, 'tools'), { recursive: true });
  await mkdir(path.join(fixture, 'out'));
  await mkdir(storage);
  for (const file of ['update-standalone.cjs', 'start-node.cjs', 'standalone-config.cjs'])
    await copyFile(new URL(file, import.meta.url), path.join(fixture, 'tools', file));
  await writeFile(path.join(fixture, 'out', 'node.js'), `
    const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
    exports.startNodeHost = () => new Promise((resolve, reject) => {
      if (fs.existsSync(path.join(process.env.CODEX_MANAGER_STORAGE_ROOT, 'fail-start'))) { reject(new Error('Fixture startup failure')); return; }
      const server = http.createServer((request, response) => {
        if (request.url === '/shutdown') {
          if (request.headers['x-codex-admin'] !== process.env.CODEX_MANAGER_ADMIN_TOKEN) { response.statusCode = 403; response.end(); return; }
          response.end('Stopping');
          fs.writeFileSync(path.join(process.env.CODEX_MANAGER_STORAGE_ROOT, 'stopping'), '1');
          setTimeout(() => server.close(() => process.exit(0)), 400);
        } else response.end(JSON.stringify({ pid: process.pid }));
      });
      server.once('error', reject);
      server.listen(Number(process.env.CODEX_MANAGER_PORT), '127.0.0.1', () => {
        process.send?.({ type: 'codex-manager-ready', url: 'http://127.0.0.1:' + process.env.CODEX_MANAGER_PORT });
        resolve();
      });
    });
  `);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const configPath = path.join(storage, 'always-online-relay.json');
  const db = new DatabaseSync(path.join(storage, 'manager.sqlite'));
  db.exec('CREATE TABLE state(namespace TEXT,key TEXT,value TEXT,PRIMARY KEY(namespace,key))');
  const configModule = require(path.join(fixture, 'tools', 'standalone-config.cjs'));
  const initial = await launch('start-node.cjs', ['--background', '--data-dir', storage, '--port', String(port)]).done;
  assert.equal(initial.code, 0, initial.output);
  token = configModule.readConfig(configPath).adminToken;
  assert.ok(token.length >= 43, 'Fresh standalone launch saves restart credentials even with an existing database');
  const firstPid = (await state()).pid;

  await writeFile(configPath, JSON.stringify({ mode: 'node', port: 1, adminToken: 'stale' }));
  assert.equal(configModule.readConfig(configPath).port, port, 'SQLite configuration takes priority over a stale disk file');
  const restarted = await launch('update-standalone.cjs', ['--restart-only', '--data-dir', storage]).done;
  assert.equal(restarted.code, 0, restarted.output);
  const secondPid = (await state()).pid;
  assert.notEqual(secondPid, firstPid, 'Restart selects the saved custom port and starts a new process');

  await rm(path.join(storage, 'stopping'));
  const interrupted = launch('update-standalone.cjs', ['--restart-only', '--data-dir', storage]);
  await until(async () => (await readFile(path.join(storage, 'stopping'), 'utf8')) === '1');
  interrupted.child.kill();
  await interrupted.done;
  const thirdPid = await until(async () => { const current = await state(); return current.pid !== secondPid && current.pid; });
  assert.notEqual(thirdPid, secondPid, 'Detached restart survives losing the initiating process after shutdown');

  const npmFixture = path.join(fixture, 'npm-cli.cjs');
  await writeFile(npmFixture, `require('node:fs').appendFileSync(${JSON.stringify(path.join(fixture, 'npm-trace'))},process.argv.slice(2).join(' ')+String.fromCharCode(10)); process.exit(process.argv.includes('compile')?7:0);`);
  const failedBuild = await launch('update-standalone.cjs', ['--data-dir', storage], { npm_execpath: npmFixture }).done;
  assert.equal(failedBuild.code, 1, failedBuild.output);
  assert.match(await readFile(path.join(fixture, 'npm-trace'), 'utf8'), /install\nrun compile\n/);
  assert.equal((await state()).pid, thirdPid, 'Install/build failures leave the old host running');

  const saved = configModule.readConfig(configPath);
  db.prepare('UPDATE state SET value=? WHERE namespace=? AND key=?')
    .run(JSON.stringify({ text: JSON.stringify({ ...saved, adminToken: 'wrong' }) }), 'files', path.basename(configPath));
  const refused = await launch('update-standalone.cjs', ['--restart-only', '--data-dir', storage]).done;
  assert.equal(refused.code, 1, refused.output);
  assert.match(refused.output, /Shutdown refused \(HTTP 403\)/);
  assert.equal((await state()).pid, thirdPid, 'Authorization failure never stops the owner');
  assert.match(await readFile(path.join(storage, 'standalone-update.log'), 'utf8'), /Shutdown refused/);
  db.prepare('UPDATE state SET value=? WHERE namespace=? AND key=?')
    .run(JSON.stringify({ text: JSON.stringify(saved) }), 'files', path.basename(configPath));
  await writeFile(path.join(storage, 'fail-start'), '1');
  const startupFailure = await launch('update-standalone.cjs', ['--restart-only', '--data-dir', storage]).done;
  assert.equal(startupFailure.code, 1, startupFailure.output);
  assert.match(await readFile(path.join(storage, 'standalone-update.log'), 'utf8'), /Fixture startup failure/, 'Background startup preserves its original error');
  await rm(path.join(storage, 'fail-start'));
  const recovered = await launch('update-standalone.cjs', ['--restart-only', '--data-dir', storage]).done;
  assert.equal(recovered.code, 0, recovered.output);
  await state();
  db.prepare('UPDATE state SET value=? WHERE namespace=? AND key=?')
    .run(JSON.stringify({ text: null }), 'files', path.basename(configPath));
  assert.equal(configModule.readConfig(configPath), undefined, 'Deleted SQLite config never falls back to stale disk credentials');
  db.close();
  console.log('PASS: direct launch, SQLite priority, custom port, detached restart after parent loss, Windows npm invocation, build failure, authorization failure, startup error details, retry after failed startup, persistent failure log.');
} finally {
  try { await stop(); } catch { /* Fixture may not have started. */ }
  for (const child of pending) child.kill();
  assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(fixture, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
}
