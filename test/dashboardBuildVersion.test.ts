import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { removeTestDirectory } from './testFilesystem';

it('rejects a stale dashboard version before packaging and accepts the matching build', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'manager-build-version-'));
  const verify = path.resolve('tools/verify-dashboard-modules.mjs');
  const assets = path.join(root, 'media/webview/dashboard');
  try {
    await mkdir(path.join(assets, 'chunks'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.7.9' }));
    await writeFile(path.join(assets, 'dashboard-manifest.json'), JSON.stringify({
      entry: { isEntry: true, file: 'dashboard.js', imports: ['core'] },
      core: { file: 'chunks/core.js' },
      editor: { file: 'chunks/workspaceCodeEditor-test.js' },
      terminal: { file: 'chunks/workspaceTerminal-test.js' }
    }));
    for (const file of ['dashboard.js', 'chunks/workspaceCodeEditor-test.js', 'chunks/workspaceTerminal-test.js'])
      await writeFile(path.join(assets, file), 'void 0;');
    const run = () => execFileSync(process.execPath, [verify], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: 'pipe' });
    await writeFile(path.join(assets, 'chunks/core.js'), 'const version = "1.7.9-pre.1";');
    expect(run).toThrow('Dashboard bundle does not contain package version 1.7.9');
    await writeFile(path.join(assets, 'chunks/core.js'), 'const version = "1.7.9";');
    expect(run()).toContain('Dashboard version verified: 1.7.9');
  } finally { await removeTestDirectory(root); }
});
