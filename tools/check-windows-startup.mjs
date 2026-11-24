import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') {
  console.log('Windows startup smoke skipped on this platform.');
  process.exit(0);
}
// Exercise the generated login script in disposable folders; never register real tasks.
const fixture = await mkdtemp(path.join(tmpdir(), 'manager startup '));
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const originalExec = childProcess.execFile;
const savedAppData = process.env.APPDATA;
const startup = path.join(fixture, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const config = path.join(fixture, 'always-online-relay.json');
const marker = path.join(fixture, 'started.json');
const probe = path.join(fixture, 'probe.cjs');
try {
  await mkdir(startup, { recursive: true });
  await writeFile(config, '{}');
  await writeFile(probe, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({config:process.argv[2], electron:process.env.ELECTRON_RUN_AS_NODE}));`);
  process.env.APPDATA = fixture;
  childProcess.execFile = (command, args, options, callback) => {
    if (command === 'schtasks.exe') { callback(Object.assign(new Error('Fixture scheduler denied'), { code: 1 })); return; }
    if (command === 'reg.exe') { callback(Object.assign(new Error('Fixture registry empty'), { code: 1 })); return; }
    return originalExec(command, args, options, callback);
  };
  const { installRelayStartup, removeRelayStartup } = require('../out/utils/relayStartup.js');
  await installRelayStartup(config, probe, process.execPath);
  const launcher = path.join(startup, 'CodexManagerAlwaysOnline.vbs');
  assert.match(await readFile(launcher, 'utf8'), /, 0, False/);
  await assert.rejects(access(path.join(startup, 'CodexManagerAlwaysOnline.cmd')));
  await new Promise((resolve, reject) => originalExec('cscript.exe', ['//B', '//NoLogo', launcher], { windowsHide: true, timeout: 5000 }, error => error ? reject(error) : resolve()));
  const deadline = Date.now() + 5000;
  let started;
  while (Date.now() < deadline) {
    try { started = JSON.parse(await readFile(marker, 'utf8')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.deepEqual(started, { config, electron: '1' });
  await removeRelayStartup(config);
  await assert.rejects(access(launcher));
  await assert.rejects(access(path.join(fixture, 'always-online-relay-start.cmd')));
  console.log(JSON.stringify({ hiddenLoginLaunch: 'passed', customPathsWithSpaces: 'passed', cleanup: 'passed' }));
} finally {
  childProcess.execFile = originalExec;
  if (savedAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedAppData;
  await rm(fixture, { recursive: true, force: true });
}
