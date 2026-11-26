import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';

// Load the actual archive outside the checkout so local dependencies cannot hide omissions.
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] ?? `${manifest.name}-${manifest.version}.vsix`);
const temporaryRoot = await realpath(os.tmpdir());
const fixture = await mkdtemp(path.join(temporaryRoot, 'manager-package-'));
try {
  const archive = await JSZip.loadAsync(await readFile(vsix));
  const entries = Object.values(archive.files).filter(entry => !entry.dir);
  for (let offset = 0; offset < entries.length; offset += 32) {
    await Promise.all(entries.slice(offset, offset + 32).map(async entry => {
      const target = path.resolve(fixture, entry.name);
      assert.ok(target.startsWith(fixture + path.sep), 'Archive path escapes the test directory');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await entry.async('nodebuffer'), { mode: typeof entry.unixPermissions === 'number' ? entry.unixPermissions & 0o777 : 0o644 });
    }));
  }
  const root = path.join(fixture, 'extension');
  await writeFile(path.join(root, 'packaged-smoke.cjs'), smoke());
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(root, 'packaged-smoke.cjs')], {
    cwd: root, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, NODE_PATH: '', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: path.join(fixture, 'claude') }
  });
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  console.log(`Packaged runtime check passed: ${path.basename(vsix)}`);
} finally {
  assert.equal(path.dirname(fixture), temporaryRoot);
  assert.ok(path.basename(fixture).startsWith('manager-package-'));
  await rm(fixture, { recursive: true, force: true });
}

function smoke() { return String.raw`
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const root = __dirname;
const resolve = Module._resolveFilename;
Module._resolveFilename = function (...args) {
  const resolved = resolve.apply(this, args);
  if (path.isAbsolute(resolved)) assert.ok(resolved.startsWith(root + path.sep), 'Dependency escaped the VSIX: ' + resolved);
  return resolved;
};
(async () => {
  const manifest = require('./package.json');
  const { createOfficeDocument, extractOfficeDocument } = require('./out/services/officeDocuments');
  const text = 'Packaged runtime check';
  for (const extension of ['docx', 'xlsx', 'pptx', 'pdf']) {
    const input = { path: 'check.' + extension, text: text + '\nনমুনা অনুমোদন প্রয়োজন',
      sheets: [{ name: 'Costing', rows: [[text, 'Value'], ['Quantity', 2], ['Total', { formula: 'B2*3' }]] }],
      slides: [{ title: text, layout: 'chart', chart: { labels: ['One', 'Two'], values: [2, 3] } }] };
    let bytes = await createOfficeDocument(input);
    if (extension === 'pdf') {
      const { PDFDocument } = require('pdf-lib');
      const document = await PDFDocument.load(bytes);
      const image = await document.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGJcAAAAASUVORK5CYII=', 'base64'));
      document.getPages()[0].drawImage(image, { x: 10, y: 10, width: 20, height: 20 });
      bytes = Buffer.from(await document.save());
    }
    assert.ok((await extractOfficeDocument(input.path, bytes)).includes(text), extension + ' text round trip');
    if (extension === 'pdf') {
      const preview = JSON.parse(await extractOfficeDocument(input.path, bytes, 'images'));
      assert.equal(preview.total, 1);
      assert.match(preview.pages[0].image, /^data:image\/png;base64,/);
      assert.ok(Buffer.from(preview.pages[0].image.split(',')[1], 'base64').length > 1000);
    } else assert.match(await extractOfficeDocument(input.path, bytes, 'html'), /<(?:h1|h2|p|table)/);
  }
  for (const dependency of Object.keys(manifest.dependencies)) require(dependency);
  const sdk = require('@anthropic-ai/claude-agent-sdk');
  for (const name of ['query', 'listSessions', 'getSessionMessages', 'renameSession', 'archiveSession', 'deleteSession', 'forkSession']) assert.equal(typeof sdk[name], 'function', name);
  assert.deepEqual(await sdk.listSessions({ dir: process.env.CLAUDE_CONFIG_DIR }), []);
  const mail = require('nodemailer').createTransport({ jsonTransport: true });
  const sent = await mail.sendMail({ from: 'test@example.invalid', to: 'test@example.invalid', subject: text, text });
  assert.ok(JSON.parse(sent.message).text.includes(text));
  assert.ok(require('web-push').generateVAPIDKeys().publicKey);
  const { Terminal } = require('@xterm/headless');
  const { SerializeAddon } = require('@xterm/addon-serialize');
  const screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const serializer = new SerializeAddon(); screen.loadAddon(serializer);
  await new Promise(resolve => screen.write(text, resolve)); assert.ok(serializer.serialize().includes(text)); screen.dispose();
  const pty = require('node-pty').spawn(process.execPath, ['-e', 'console.log("PACKAGED_PTY_OK")'], { cols: 80, rows: 24, cwd: root, env: process.env });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pty.kill(); reject(new Error('Packaged terminal timed out')); }, 10_000);
    pty.onData(chunk => output += chunk);
    pty.onExit(() => { clearTimeout(timer); resolve(); });
  });
  assert.ok(output.includes('PACKAGED_PTY_OK'));
  const agent = pty._agent;
  agent?.inSocket?.destroy(); agent?.outSocket?.destroy(); agent?._conoutSocketWorker?.dispose();
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true, timeout: 20_000 });
  try { const page = await browser.newPage(); await page.setContent('<h1>' + text + '</h1>'); assert.equal(await page.locator('h1').textContent(), text); }
  finally { await browser.close(); }
  console.log(JSON.stringify({ version: manifest.version, checks: 'isolated dependencies, Word/Excel/PowerPoint/PDF round trips, PDF page rendering, Claude SDK, mail, push keys, terminal screen, native PTY, browser' }));
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
`; }
