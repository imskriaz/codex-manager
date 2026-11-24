import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { getCodexHome } from '../codex/authFile';

export type LocalDictationRequest = { operation: 'prepare' | 'status' | 'transcribe'; audio?: string };
export type LocalDictationResult = { ready: boolean; message?: string; text?: string; language?: string };
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
let preparing: Promise<void> | undefined;
let setupController: AbortController | undefined;
let worker: ReturnType<typeof spawn> | undefined;
let ready = false;
let failure: string | undefined;
let stage = 'Preparing local Whisper. The first use downloads its runtime and multilingual model.';
let nextId = 0;
const pending = new Map<number, { resolve: (result: LocalDictationResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

export function validateDictationAudio(value: unknown): string {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4) throw new Error('Send a valid short dictation recording.');
  const data = Buffer.from(value, 'base64');
  if (data.length < 44 || data.length > MAX_AUDIO_BYTES || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Send a valid WAV dictation recording.');
  return value;
}

function run(command: string, args: string[], timeout = 180_000, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout, signal, maxBuffer: 1024 * 1024 }, error => error ? reject(new Error(error.message)) : resolve());
  });
}

function fail(message: string) {
  failure = message;
  ready = false;
  worker?.kill();
  worker = undefined;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
  pending.clear();
}

export function disposeLocalDictation(): void {
  setupController?.abort(); setupController = undefined; preparing = undefined;
  fail('Local dictation stopped. Your draft is kept.');
}

async function prepare(extensionPath: string, signal: AbortSignal) {
  const root = path.join(getCodexHome(), 'manager', 'dictation');
  const python = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await fs.mkdir(root, { recursive: true });
  try { await fs.access(python); }
  catch {
    const choices: Array<[string, string[]]> = process.platform === 'win32'
      ? [['py', ['-3.13']], ['py', ['-3.12']], ['py', ['-3.11']], ['python', []]]
      : [['python3', []], ['python', []]];
    let created = false;
    for (const [command, args] of choices) {
      try {
        signal.throwIfAborted();
        await run(command, [...args, '-c', 'import sys; assert (3, 11) <= sys.version_info[:2] <= (3, 13)'], 10_000, signal);
        await run(command, [...args, '-m', 'venv', path.join(root, 'venv')], 60_000, signal);
        created = true;
        break;
      } catch { signal.throwIfAborted(); }
    }
    if (!created) throw new Error('Local Whisper needs Python 3.11-3.13 on this host. Install Python 3.12, then choose Local Whisper again. Browser dictation is also available.');
  }
  stage = 'Installing local Whisper. Your recording stays on this host.';
  // faster-whisper 1.2.1 uses decoder options removed in PyAV 19.
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', 'faster-whisper==1.2.1', 'av==18.1.0'], 180_000, signal);
  signal.throwIfAborted();
  stage = 'Loading local Whisper. Its multilingual model downloads once on first use.';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, ['-u', path.join(extensionPath, 'tools', 'local-whisper.py'), path.join(root, 'models')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1' }
    });
    worker = child;
    let stderr = '';
    const timer = setTimeout(() => { fail('Local Whisper model loading timed out. Check the host network and retry.'); reject(new Error(failure)); }, 180_000);
    const stopped = () => {
      clearTimeout(timer);
      if (worker !== child) { reject(new Error('Local Whisper setup was cancelled.')); return; }
      const message = /download|connection|network|resolve/i.test(stderr)
        ? 'Local Whisper could not download its model. Check the host network and retry.'
        : 'Local Whisper stopped. Choose it again to restart; your draft is kept.';
      fail(message);
      reject(new Error(message));
    };
    child.on('error', stopped);
    child.on('exit', stopped);
    child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-2048); });
    createInterface({ input: child.stdout! }).on('line', line => {
      if (worker !== child) return;
      try {
        const result = JSON.parse(line) as LocalDictationResult & { id?: number; error?: string };
        if (result.ready && result.id === undefined) { clearTimeout(timer); ready = true; resolve(); return; }
        const item = result.id === undefined ? undefined : pending.get(result.id);
        if (!item) return;
        pending.delete(result.id!);
        clearTimeout(item.timer);
        if (result.error) item.reject(new Error('Local Whisper could not transcribe this recording. Your draft is kept.'));
        else if (typeof result.text === 'string' && result.text.length <= 64_000) item.resolve({ ready: true, text: result.text, language: result.language });
        else item.reject(new Error('Local Whisper returned an invalid transcript. Your draft is kept.'));
      } catch { fail('Local Whisper returned an invalid response. Your draft is kept.'); reject(new Error(failure)); }
    });
    child.unref();
  });
}

export async function localDictation(request: LocalDictationRequest | undefined, extensionPath = path.resolve(__dirname, '../..')): Promise<LocalDictationResult> {
  if (!request || !['prepare', 'status', 'transcribe'].includes(request.operation)) throw new Error('Choose a valid dictation action.');
  if (request.operation === 'prepare' && !ready && !preparing) {
    failure = undefined;
    const controller = new AbortController(); setupController = controller;
    stage = 'Preparing local Whisper. The first use downloads its runtime and multilingual model.';
    preparing = prepare(extensionPath, controller.signal).catch(error => {
      if (!controller.signal.aborted) fail(error instanceof Error ? error.message : 'Local Whisper setup failed.');
    }).finally(() => { if (setupController === controller) { preparing = undefined; setupController = undefined; } });
  }
  if (failure) throw new Error(failure);
  if (request.operation !== 'transcribe') return { ready, message: ready ? 'Local Whisper is ready. Spoken language is detected automatically.' : stage };
  const audio = validateDictationAudio(request.audio);
  if (!ready || !worker?.stdin?.writable) throw new Error('Local Whisper is not ready. Choose it again to prepare the model.');
  if (pending.size >= 4) throw new Error('Local Whisper is busy. Stop dictation and retry after the current recordings finish.');
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { fail('Local Whisper transcription timed out. Your draft is kept.'); }, 45_000);
    pending.set(id, { resolve, reject, timer });
    worker!.stdin!.write(JSON.stringify({ id, audio }) + '\n', error => { if (error) fail('Local Whisper could not receive the recording. Your draft is kept.'); });
  });
}
