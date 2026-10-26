const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

async function inspect() {
  const home = await fs.realpath(workerData.home);
  const files = (await fs.readdir(home)).filter(name => /^[a-z][a-z0-9_]*_\d+\.sqlite$/i.test(name)).sort();
  const report = { databases: [], totalBytes: 0, allocatedBytes: 0, liveBytes: 0, reusableBytes: 0, walBytes: 0, sharedMemoryBytes: 0, complete: files.length <= 128 };
  for (const name of files.slice(0, 128)) {
    const row = { name, bytes: 0, allocatedBytes: 0, liveBytes: 0, reusableBytes: 0, walBytes: 0, sharedMemoryBytes: 0, status: 'Unavailable', error: undefined };
    let database;
    try {
      const file = path.join(home, name), info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Not a regular database; skipped.');
      row.bytes = info.size;
      for (const [suffix, key] of [['-wal', 'walBytes'], ['-shm', 'sharedMemoryBytes']]) {
        try {
          const sidecar = await fs.lstat(file + suffix);
          if (!sidecar.isFile() || sidecar.isSymbolicLink()) throw new Error('Linked or non-file database sidecar; skipped.');
          row[key] = sidecar.size;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      database = new DatabaseSync(file, { readOnly: true });
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100; PRAGMA cache_size=-1024; PRAGMA temp_store=FILE; BEGIN');
      const number = pragma => Number(Object.values(database.prepare('PRAGMA ' + pragma).get())[0]);
      const pageSize = number('page_size');
      row.allocatedBytes = number('page_count') * pageSize;
      row.reusableBytes = number('freelist_count') * pageSize;
      row.liveBytes = Math.max(0, row.allocatedBytes - row.reusableBytes);
      row.status = database.prepare('PRAGMA quick_check(1)').get().quick_check === 'ok' ? 'Healthy' : 'Needs recovery';
    } catch (error) { row.error = error.message; report.complete = false; }
    finally { database?.close(); }
    report.databases.push(row);
    report.totalBytes += row.bytes + row.walBytes + row.sharedMemoryBytes;
    for (const key of ['allocatedBytes', 'liveBytes', 'reusableBytes', 'walBytes', 'sharedMemoryBytes']) report[key] += row[key];
    parentPort.postMessage({ type: 'progress', report });
  }
  parentPort.postMessage({ type: 'completed', report });
}
inspect().catch(error => parentPort.postMessage({ type: 'failed', error: error.message }));
