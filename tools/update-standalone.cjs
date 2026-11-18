#!/usr/bin/env node
/* Restart work runs detached so losing the initiating dashboard cannot cancel it. */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { readConfig, createConfig } = require('./standalone-config.cjs');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
let dataDir = path.resolve(process.env.CODEX_MANAGER_STORAGE_ROOT || path.join(os.homedir(), '.codex'));
let configPath;
let selectedPort = process.env.CODEX_MANAGER_PORT;
for (let index = 0; index < args.length; index++) {
  const value = args[index];
  if (['--data-dir', '--config', '--port'].includes(value)) {
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${value}.`);
    const next = args[++index];
    if (value === '--data-dir') dataDir = path.resolve(next);
    else if (value === '--config') configPath = path.resolve(next);
    else selectedPort = next;
  } else if (!['--restart-only', '--worker', '--help'].includes(value)) throw new Error(`Unknown option: ${value}`);
}
configPath ??= path.join(dataDir, 'always-online-relay.json');
dataDir = path.dirname(configPath);
const logPath = path.join(dataDir, 'standalone-update.log');

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed with exit code ${result.status ?? 'unknown'}: ${path.basename(command)}`);
}

function runNpm(commandArgs) {
  // Invoke npm's JavaScript entry directly; spawnSync cannot execute npm.cmd on Windows.
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(npmCli)) run(process.execPath, [npmCli, ...commandArgs]);
  else if (process.platform !== 'win32') run('npm', commandArgs);
  else throw new Error('Run this command with npm run standalone:update so the npm CLI path is available.');
}

function portIsOpen(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
    socket.setTimeout(500, () => { socket.destroy(); resolve(true); });
  });
}

async function restart() {
  fs.accessSync(path.join(root, 'out', 'node.js'));
  let config = readConfig(configPath);
  const port = Number(selectedPort ?? config?.port ?? 39875);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port between 1 and 65535.');
  if (await portIsOpen(port)) {
    if (!config?.adminToken || config.mode !== 'node') throw new Error(`Port ${port} has an unmanaged host. It was left running; stop it manually once, then use npm start -- --background.`);
    const response = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST', headers: { 'X-Codex-Admin': config.adminToken }, signal: AbortSignal.timeout(2_000)
    });
    await response.text();
    if (!response.ok) throw new Error(`Shutdown refused (HTTP ${response.status}); the existing host was left running.`);
    const deadline = Date.now() + 15_000;
    while (await portIsOpen(port)) {
      if (Date.now() >= deadline) throw new Error(`Host still owns port ${port}; no process was forcibly stopped.`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  config ??= createConfig(configPath, { port });
  // Replace inherited host credentials with this storage directory's configuration.
  process.env.CODEX_MANAGER_STORAGE_ROOT = dataDir;
  process.env.CODEX_MANAGER_PORT = String(port);
  process.env.CODEX_MANAGER_ADMIN_TOKEN = config.adminToken;
  process.env.CODEX_MANAGER_PID_FILE = config.pidPath || path.join(dataDir, 'always-online-relay.pid');
  run(process.execPath, [path.join(root, 'tools', 'start-node.cjs'), '--background', '--config', configPath]);
  return `Standalone Codex Manager is running at http://127.0.0.1:${port}.`;
}

function launchRestartWorker() {
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [__filename, '--worker', '--restart-only', '--config', configPath, ...(selectedPort ? ['--port', String(selectedPort)] : [])], {
      detached: true, windowsHide: true, stdio: ['ignore', log, log, 'ipc'], env: process.env
    });
  } finally { fs.closeSync(log); }
  console.log(`Restart worker started independently (PID ${child.pid}); log: ${logPath}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.connected) child.disconnect();
      child.unref();
      reject(new Error(`Restart confirmation timed out; the independent worker is still running. Check ${logPath}.`));
    }, 40_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Restart worker exited without confirmation (${code}). Check ${logPath}.`)); });
    child.once('message', result => {
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      child.unref();
      if (result.error) reject(new Error(result.error)); else resolve(result.message);
    });
  });
}

async function main() {
  if (args.includes('--help')) {
    console.log('Usage: npm run standalone:update -- [--data-dir <path>] [--config <path>] [--port <port>]');
    console.log('Install and compile, then restart independently. npm run standalone:restart skips install/build.');
    return;
  }
  if (args.includes('--worker')) {
    const result = await restart().then(message => ({ message }), error => ({ error: error.message }));
    console.log(`${new Date().toISOString()} ${result.message || result.error}`);
    if (process.connected) process.send(result, () => { if (process.connected) process.disconnect(); });
    if (result.error) process.exitCode = 1;
    return;
  }
  if (!args.includes('--restart-only')) {
    runNpm(['install']);
    runNpm(['run', 'compile']);
  }
  console.log(await launchRestartWorker());
}

main().catch(error => { console.error(`Standalone update failed: ${error.message}`); process.exitCode = 1; });
