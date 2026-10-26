import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('media/webview/dashboard');
const manifest = JSON.parse(readFileSync(path.join(root, 'dashboard-manifest.json'), 'utf8'));
const entries = Object.entries(manifest).filter(([, module]) => module.isEntry);
assert.equal(entries.length, 1, 'Dashboard requires one bootstrap entry');
const [entryKey, entry] = entries[0];
assert.equal(entry.file, 'dashboard.js');
const core = new Set();
function visit(key) {
  if (core.has(key)) return;
  const module = manifest[key]; assert.ok(module, `Missing core module ${key}`);
  core.add(key);
  for (const dependency of module.imports || []) visit(dependency);
}
visit(entryKey);
for (const [key, module] of Object.entries(manifest)) {
  assert.ok(module.file === 'dashboard.js' || /^chunks\/[A-Za-z0-9_-]+\.js$/.test(module.file), 'Module path must remain in the dashboard asset directory');
  assert.ok(existsSync(path.join(root, module.file)), `Missing dashboard module ${module.file}`);
  if (!module.isEntry) assert.ok(!(module.imports || []).includes(entryKey), 'A lazy module must never load a second version of the bootstrap entry');
  if (/workspaceCodeEditor|workspaceTerminal|editor-vendor|terminal-vendor/.test(module.file)) assert.ok(!core.has(key), `Optional module loaded eagerly: ${module.file}`);
}
assert.ok(Object.values(manifest).some(module => module.file.includes('workspaceCodeEditor-')), 'Missing lazy editor');
assert.ok(Object.values(manifest).some(module => module.file.includes('workspaceTerminal-')), 'Missing lazy terminal');
console.log(`Dashboard modules verified: ${core.size} core, ${Object.keys(manifest).length - core.size} deferred; no duplicate bootstrap imports.`);
