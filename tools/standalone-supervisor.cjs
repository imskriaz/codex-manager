const { spawn } = require('node:child_process');
const path = require('node:path');

// Keep crash recovery alive after VS Code and the launching terminal close.
exports.supervise = function supervise(args, log) {
  let child, retry, deadline, stopping = false, wasReady = false, failures = 0;
  const stop = () => {
    stopping = true;
    clearTimeout(retry);
    clearTimeout(deadline);
    if (child) child.kill('SIGTERM');
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const send = message => {
    if (process.connected) process.send(message, error => { if (error) log('Supervisor notification failed', error); });
  };
  const launch = () => {
    let readyAt, intentional = false, startupError;
    child = spawn(process.execPath, [path.join(__dirname, 'start-node.cjs'), ...args, '--host-worker'], {
      windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: process.env
    });
    log(`Standalone worker process started (PID ${child.pid ?? 'unavailable'}).`);
    deadline = setTimeout(() => {
      startupError = 'Standalone startup timed out after 15 seconds.';
      log(startupError);
      child.kill();
    }, 15_000);
    child.on('message', message => {
      if (message?.type === 'codex-manager-ready') {
        clearTimeout(deadline);
        readyAt = Date.now();
        wasReady = true;
        send({ ...message, pid: child.pid });
      } else if (message?.type === 'codex-manager-stopping') {
        intentional = true;
        clearTimeout(deadline);
      } else if (message?.type === 'codex-manager-startup-error') {
        startupError = message.error;
        send(message);
      }
    });
    child.once('error', error => { startupError = error.message; log('Standalone worker launch failed', error); });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      child = undefined;
      if (stopping || intentional) { log('Standalone supervisor stopped after requested shutdown'); return; }
      // Startup failures and competing owners must remain visible to the caller.
      if (!wasReady || /already owned by another host/.test(startupError ?? '')) {
        const error = startupError ?? `Standalone exited before ready (${code ?? signal}).`;
        console.error(error);
        send({ type: 'codex-manager-startup-error', error });
        process.exitCode = 1;
        return;
      }
      if (readyAt && Date.now() - readyAt >= 30_000) failures = 0;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
      log(`Standalone worker exited unexpectedly (${code ?? signal}); restarting in ${delay}ms`, startupError);
      retry = setTimeout(launch, delay);
    });
  };
  launch();
};
