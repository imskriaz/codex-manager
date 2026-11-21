const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

function localMcpEndpoint(storageRoot = process.env.CODEX_MANAGER_STORAGE_ROOT || path.join(os.homedir(), '.codex')) {
  const root = path.resolve(storageRoot);
  const identity = `${os.homedir()}:${process.platform === 'win32' ? root.toLowerCase() : root}`;
  const id = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\codex-manager-${id}` : path.join(os.tmpdir(), `codex-manager-${id}`, 'mcp.sock');
}

module.exports = { localMcpEndpoint };
