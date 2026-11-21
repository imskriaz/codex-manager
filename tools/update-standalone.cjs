#!/usr/bin/env node
/* Restart work runs detached so losing the initiating dashboard cannot cancel it. */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readConfig, createConfig } = require('./standalone-config.cjs');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
let dataDir = path.resolve(process.env.CODEX_MANAGER_STORAGE_ROOT || path.join(os.homedir(), '.codex'));
let configPath;
let restartId;
let selectedPort = process.env.CODEX_MANAGER_PORT;
for (let index = 0; index < args.length; index++) {
  const value = args[index];
  if (['--data-dir', '--config', '--port', '--restart-id'].includes(value)) {
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${value}.`);
    const next = args[++index];
    if (value === '--data-dir') dataDir = path.resolve(next);
    else if (value === '--config') configPath = path.resolve(next);
    else if (value === '--restart-id') restartId = next;
    else selectedPort = next;
  } else if (!['--restart-only', '--worker', '--help'].includes(value)) throw new Error(`Unknown option: ${value}`);
}
configPath ??= path.join(dataDir, 'always-online-relay.json');
dataDir = path.dirname(configPath);
const logPath = path.join(dataDir, 'standalone-update.log');
if (restartId && (!args.includes('--worker') || !/^[a-f0-9-]{36}$/.test(restartId))) throw new Error('Invalid restart worker ID.');
const resultPath = restartId && path.join(dataDir, `standalone-restart-${restartId}.json`);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: resultPath ? 'pipe' : 'inherit', encoding: 'utf8', windowsHide: true });
  if (resultPath) fs.appendFileSync(logPath, (result.stdout || '') + (result.stderr || ''));
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
      method: 'POST', headers: { 'X-Codex-Admin': config.adminToken, 'X-Codex-Shutdown-Reason': 'standalone-restart' }, signal: AbortSignal.timeout(2_000)
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

async function launchWindowsRestartWorker() {
  fs.mkdirSync(dataDir, { recursive: true });
  const id = randomUUID();
  const file = path.join(dataDir, `standalone-restart-${id}.json`);
  const commandArgs = [process.execPath, __filename, '--worker', '--restart-only', '--config', configPath,
    '--restart-id', id, ...(selectedPort ? ['--port', selectedPort] : [])];
  if (commandArgs.some(value => value.includes('"'))) throw new Error('Restart paths cannot contain quotes.');
  // WMI owns the worker so Windows terminal tree cleanup cannot kill the replacement.
  const launch = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `
    $ErrorActionPreference = 'Stop'
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
      ShowWindow = [uint16]0; EnvironmentVariables = [string[]]$request.environment
    }
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine = $request.commandLine; CurrentDirectory = $request.directory; ProcessStartupInformation = $startup
    }
    if ($result.ReturnValue -ne 0) { throw "Independent restart launch failed ($($result.ReturnValue))." }
    Write-Output $result.ProcessId
  `], {
    input: JSON.stringify({ commandLine: commandArgs.map(value => `"${value}"`).join(' '), directory: root,
      environment: Object.entries(process.env).map(([key, value]) => `${key}=${value}`) }),
    encoding: 'utf8', windowsHide: true, timeout: 10_000
  });
  if (launch.error || launch.status !== 0) throw new Error(`Independent restart launch failed or was not confirmed. Check ${logPath}. ${launch.error?.message || launch.stderr.trim()}`);
  console.log(`Independent restart worker started (PID ${launch.stdout.trim()}); log: ${logPath}`);
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    let result;
    try { result = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (result) {
      fs.unlinkSync(file);
      if (result.error) throw new Error(result.error);
      return result.message;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Restart confirmation timed out; check ${logPath} and ${file}.`);
}

async function main() {
  if (args.includes('--help')) {
    console.log('Usage: npm run standalone:update -- [--data-dir <path>] [--config <path>] [--port <port>]');
    console.log('Install and compile, then restart independently. npm run standalone:restart skips install/build.');
    return;
  }
  if (args.includes('--worker')) {
    const result = await restart().then(message => ({ message }), error => ({ error: error.message }));
    const message = `${new Date().toISOString()} ${result.message || result.error}`;
    if (resultPath) {
      fs.appendFileSync(logPath, message + '\n');
      fs.writeFileSync(resultPath + '.tmp', JSON.stringify(result), { mode: 0o600 });
      fs.renameSync(resultPath + '.tmp', resultPath);
    } else console.log(message);
    if (process.connected) process.send(result, () => { if (process.connected) process.disconnect(); });
    if (result.error) process.exitCode = 1;
    return;
  }
  if (!args.includes('--restart-only')) {
    runNpm(['install']);
    runNpm(['run', 'compile']);
  }
  console.log(await (process.platform === 'win32' ? launchWindowsRestartWorker() : launchRestartWorker()));
}

main().catch(error => { console.error(`Standalone update failed: ${error.message}`); process.exitCode = 1; });
