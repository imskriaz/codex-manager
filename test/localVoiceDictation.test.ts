import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0 }));
vi.mock('preact/hooks', () => ({
  useRef(value: unknown) { const id = hooks.cursor++; return hooks.slots[id] ??= { current: value }; },
  useState(value: unknown) { const id = hooks.cursor++; hooks.slots[id] ??= value; return [hooks.slots[id], (next: unknown) => { hooks.slots[id] = next; }]; },
  useEffect() {}, useLayoutEffect() {}
}));
const request = vi.hoisted(() => vi.fn());
vi.mock('../webview-src/dashboard/localDictationRequest', () => ({ requestLocalDictation: request }));
import { encodeDictationWav, LocalVoiceDictation } from '../webview-src/dashboard/localVoiceDictation';
import { VoiceDictation, BrowserVoiceDictation } from '../webview-src/dashboard/voiceDictation';
import { validateDictationAudio } from '../src/services/localDictation';

function nodes(value: unknown): VNode<any>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as VNode<any>; return [node, ...nodes(node.props.children)];
}
let processor: { onaudioprocess?: (event: any) => void; connect: () => void; disconnect: () => void };
let stopped: ReturnType<typeof vi.fn>;
let props: Parameters<typeof LocalVoiceDictation>[0];
function render() { hooks.cursor = 0; return nodes(LocalVoiceDictation(props)); }
function click() { render().find(node => node.type === 'button')!.props.onClick(); }
function frame() { processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(16000).fill(0.1) } }); }
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; vi.useFakeTimers();
  stopped = vi.fn();
  props = { onText: vi.fn(() => true), onFeedback: vi.fn() };
  processor = { connect() {}, disconnect() {} };
  vi.stubGlobal('window', { isSecureContext: true, AudioContext: true });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopped }] })) } });
  vi.stubGlobal('AudioContext', class {
    sampleRate = 16000; destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return processor; }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    close() { return Promise.resolve(); } resume() { return Promise.resolve(); }
  });
  request.mockReset().mockImplementation(async ({ operation }) => operation === 'transcribe' ? { ready: true, text: 'বাংলা 日本語 مرحبا', language: 'bn' } : { ready: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('optional local dictation', () => {
  it('keeps the existing browser modal as the default and opts into local capture explicitly', () => {
    expect(VoiceDictation({ onText: () => true }).type).toBe(BrowserVoiceDictation);
    expect(VoiceDictation({ onText: () => true, localWhisperEnabled: true }).type).toBe(LocalVoiceDictation);
  });
  it('starts microphone access on the first click and appends multilingual speech without a modal', async () => {
    click(); expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    await flush(); frame(); click(); await flush();
    expect(stopped).toHaveBeenCalled();
    expect(props.onText).toHaveBeenCalledExactlyOnceWith('বাংলা 日本語 مرحبا');
    expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('added to your draft') }));
    expect(render().some(node => node.props.role === 'dialog')).toBe(false);
  });
  it('ignores late transcripts after cancellation and keeps a recoverable recording', async () => {
    let resolve!: (result: unknown) => void;
    request.mockImplementation(async ({ operation }) => operation === 'transcribe' ? new Promise(done => { resolve = done; }) : { ready: true });
    click(); await flush(); frame(); click(); await flush(); click();
    resolve({ ready: true, text: 'Late words' }); await flush();
    expect(props.onText).not.toHaveBeenCalled();
    expect(render().some(node => node.type === 'a' && node.props.download === 'dictation.wav')).toBe(true);
    expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('cancelled') }));
  });
  it('times out microphone permission and releases a late stream', async () => {
    let resolve!: (stream: unknown) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => new Promise(done => { resolve = done; }) as any);
    click(); await vi.advanceTimersByTimeAsync(10_000);
    resolve({ getTracks: () => [{ stop: stopped }] }); await flush();
    expect(stopped).toHaveBeenCalled();
    expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('did not start') }));
  });
  it('surfaces denied microphone access and leaves the draft alone', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue({ name: 'NotAllowedError' });
    click(); await flush();
    expect(props.onText).not.toHaveBeenCalled();
    expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('denied') }));
  });
  it('reports transcription failure without reporting completion and preserves the recording', async () => {
    request.mockImplementation(async ({ operation }) => { if (operation === 'transcribe') throw new Error('Transcription timed out. Your draft is kept.'); return { ready: true }; });
    click(); await flush(); frame(); click(); await flush();
    expect(props.onText).not.toHaveBeenCalled();
    expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('timed out') }));
    expect(render().some(node => node.type === 'a')).toBe(true);
  });
});

it('encodes bounded mono PCM audio and rejects malformed host input', () => {
  const data = encodeDictationWav([new Float32Array([-2, 0, 2])], 16000);
  expect(Buffer.from(data).toString('ascii', 0, 4)).toBe('RIFF');
  const view = new DataView(data.buffer); expect(view.getInt16(44, true)).toBe(-32768); expect(view.getInt16(48, true)).toBe(32767);
  const audio = Buffer.from(data).toString('base64'); expect(validateDictationAudio(audio)).toBe(audio);
  for (const invalid of [undefined, '!!', 'AAAA', Buffer.alloc(64).toString('base64'), 'A'.repeat(6_000_000)]) expect(() => validateDictationAudio(invalid)).toThrow();
});
