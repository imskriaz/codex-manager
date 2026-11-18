const fs = require('node:fs');
const path = require('node:path');

function readConfig(configPath) {
  const databasePath = path.join(path.dirname(configPath), 'manager.sqlite');
  if (fs.existsSync(databasePath)) {
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout = 1000');
      const record = database.prepare('SELECT value FROM state WHERE namespace = ? AND key = ?').get('files', path.basename(configPath));
      if (record) {
        const { text } = JSON.parse(record.value);
        return text === null ? undefined : JSON.parse(text);
      }
    } finally { database.close(); }
  }
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function createConfig(configPath, overrides = {}) {
  const existing = readConfig(configPath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = { mode: 'node', port: 39875, adminToken: require('node:crypto').randomBytes(32).toString('hex'), pidPath: path.join(path.dirname(configPath), 'always-online-relay.pid'), ...overrides };
  const databasePath = path.join(path.dirname(configPath), 'manager.sqlite');
  if (fs.existsSync(databasePath)) {
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec('PRAGMA busy_timeout = 1000');
      database.exec('BEGIN IMMEDIATE');
      const record = database.prepare('SELECT value FROM state WHERE namespace = ? AND key = ?').get('files', path.basename(configPath));
      const saved = record && JSON.parse(record.value).text;
      if (saved) return JSON.parse(saved);
      database.prepare('INSERT INTO state(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value')
        .run('files', path.basename(configPath), JSON.stringify({ text: JSON.stringify(config) }));
      database.exec('COMMIT');
    } finally { database.close(); }
  } else {
    try { fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') return readConfig(configPath); throw error; }
  }
  return config;
}

module.exports = { readConfig, createConfig };
