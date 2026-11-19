// Exercise the installed Claude CLI against Manager's proxy with a fixture Codex upstream.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const runner = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const child = spawn(process.execPath, [runner, 'run', 'test/aiProxy.test.ts', '-t', 'installed Claude CLI'], {
  cwd: root, env: { ...process.env, CODEX_MANAGER_TEST_CLAUDE: '1' }, stdio: 'inherit'
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
