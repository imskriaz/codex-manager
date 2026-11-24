import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { requestLocalDictation } from './localDictationRequest';
import type { DictationNotice } from './voiceDictation';

export function encodeDictationWav(frames: Float32Array[], sampleRate: number): Uint8Array {
  const length = frames.reduce((size, frame) => size + frame.length, 0);
  const data = new Uint8Array(44 + length * 2);
  const view = new DataView(data.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    for (let index = 0; index < text.length; index++) data[offset + index] = text.charCodeAt(index);
  }
  view.setUint32(4, 36 + length * 2, true); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const frame of frames) for (const sample of frame) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true); offset += 2;
  }
  return data;
}

function base64(data: Uint8Array): string {
  let value = '';
  for (let offset = 0; offset < data.length; offset += 8192) value += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return btoa(value);
}

type Capture = {
  abort: AbortController; stopCapture?: () => void; timer?: ReturnType<typeof setTimeout>;
  frames: Float32Array[]; queue: Uint8Array[]; sampleRate: number; running: boolean; stopped: boolean; added: boolean;
};

export function LocalVoiceDictation(props: {
  disabled?: boolean; scope?: string; onText: (value: string) => boolean; onFeedback?: (notice: DictationNotice) => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'listening' | 'finishing'>('idle');
  const [notice, setNotice] = useState<DictationNotice>();
  const [recording, setRecording] = useState<string>();
  const recordingRef = useRef<string>();
  const current = useRef<Capture>();
  const callbacks = useRef(props); callbacks.current = props;
  const dispose = () => {
    const session = current.current; current.current = undefined;
    if (session) { clearTimeout(session.timer); session.abort.abort(); session.stopCapture?.(); }
  };
  useLayoutEffect(() => () => { dispose(); if (recordingRef.current) URL.revokeObjectURL(recordingRef.current); }, []);
  useLayoutEffect(() => {
    if (current.current) {
      finish(current.current, 'Dictation cancelled because the composer changed. Text already added is kept; save the recording to keep any remaining speech.', 'warning');
    }
  }, [props.scope, props.disabled]);

  const report = (message: string, level: DictationNotice['level'] = 'info', feedback = false) => {
    const result = { level, message }; setNotice(result);
    if (feedback || level === 'warning') callbacks.current.onFeedback?.(result);
  };
  const finish = (session: Capture, message: string, level: DictationNotice['level'] = 'info') => {
    if (current.current !== session) return;
    if (level === 'warning' && session.frames.length) {
      if (recordingRef.current) URL.revokeObjectURL(recordingRef.current);
      const data = encodeDictationWav(session.frames, session.sampleRate);
      recordingRef.current = URL.createObjectURL(new Blob([data as BlobPart], { type: 'audio/wav' }));
      setRecording(recordingRef.current);
    }
    dispose(); setPhase('idle'); report(message, level, true);
  };

  const start = () => {
    if (props.disabled || current.current) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      report('Microphone recording is unavailable here. Open the dashboard in a secure browser or use system dictation.', 'warning'); return;
    }
    if (recordingRef.current) { URL.revokeObjectURL(recordingRef.current); recordingRef.current = undefined; setRecording(undefined); }
    const session: Capture = { abort: new AbortController(), frames: [], queue: [], sampleRate: 16000, running: false, stopped: false, added: false };
    current.current = session; setPhase('starting'); report('Starting microphone. Allow access if prompted.');
    const { signal } = session.abort;
    session.timer = setTimeout(() => finish(session, 'The microphone did not start. Check access and retry.', 'warning'), 10_000);
    // Request permission during the click, independently of model preparation.
    const microphone = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
    const ready = (async () => {
      let result = await requestLocalDictation({ operation: 'prepare' }, signal);
      const deadline = Date.now() + 360_000;
      while (!result.ready) {
        if (Date.now() >= deadline) throw new Error('Local Whisper setup timed out. Check the host network and retry.');
        if (current.current === session) report(result.message ?? 'Preparing local Whisper. Your recording is kept while the model loads.');
        await new Promise<void>((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); reject(new Error('Dictation cancelled.')); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 1000);
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
        });
        result = await requestLocalDictation({ operation: 'status' }, signal);
      }
    })();
    void ready.catch(error => finish(session, error instanceof Error ? error.message : 'Local Whisper setup failed.', 'warning'));
    const drain = async () => {
      if (session.running || current.current !== session) return;
      session.running = true;
      try {
        await ready;
        while (session.queue.length && current.current === session) {
          report(session.stopped ? 'Finishing local dictation… Click the mic to cancel.' : 'Transcribing locally. Language is detected automatically.');
          const result = await requestLocalDictation({ operation: 'transcribe', audio: base64(session.queue[0]!) }, signal);
          if (current.current !== session) return;
          const text = result.text?.trim();
          if (text && !callbacks.current.onText(text)) throw new Error('The dictated text exceeds the message limit. Your draft is kept; save the recording for the remaining speech.');
          session.added ||= !!text; session.queue.shift();
        }
        if (current.current !== session) return;
        if (session.stopped) finish(session, session.added ? 'Dictation added to your draft. Review it before sending.' : 'No speech was detected. Your draft is unchanged.', session.added ? 'info' : 'warning');
        else report('Listening locally. Spoken language is detected automatically.');
      } catch (error) { finish(session, error instanceof Error ? error.message : 'Local dictation failed. Your draft is kept.', 'warning'); }
      finally { session.running = false; }
    };
    void microphone.then(stream => {
      if (current.current !== session || session.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      clearTimeout(session.timer);
      let context: AudioContext | undefined;
      try {
        context = new AudioContext({ sampleRate: 16000 }); session.sampleRate = context.sampleRate;
        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(4096, 1, 1);
        const silent = context.createGain(); silent.gain.value = 0;
        source.connect(processor); processor.connect(silent); silent.connect(context.destination);
        let frames: Float32Array[] = [], samples = 0, quiet = 0, speech = false;
        const flush = () => {
          if (speech && frames.length) {
            if (session.queue.length >= 12) { finish(session, 'Local transcription fell behind. Your draft is kept; save the recording to keep the remaining speech.', 'warning'); return; }
            session.queue.push(encodeDictationWav(frames, session.sampleRate)); void drain();
          }
          frames = []; samples = 0; quiet = 0; speech = false;
        };
        session.stopCapture = () => {
          processor.onaudioprocess = null;
          source.disconnect(); processor.disconnect(); silent.disconnect();
          stream.getTracks().forEach(track => track.stop()); void context!.close().catch(() => undefined);
          if (session.stopped) flush();
        };
        processor.onaudioprocess = event => {
          if (current.current !== session || session.stopped) return;
          const frame = new Float32Array(event.inputBuffer.getChannelData(0));
          let power = 0; for (const sample of frame) power += sample * sample;
          const voiced = Math.sqrt(power / frame.length) > 0.008;
          session.frames.push(frame); frames.push(frame); samples += frame.length;
          quiet = voiced ? 0 : quiet + frame.length; speech ||= voiced;
          if (samples >= session.sampleRate * 12 || speech && samples >= session.sampleRate && quiet >= session.sampleRate * 0.7) flush();
        };
        stream.getTracks().forEach(track => { track.onended = () => { if (current.current === session && !session.stopped) finish(session, 'The microphone disconnected. Your draft is kept.', 'warning'); }; });
        setPhase('listening'); report('Listening locally. Preparing Whisper if this is the first use.');
        session.timer = setTimeout(() => stop(), 90_000);
        void context.resume().catch(() => finish(session, 'Audio capture could not start. Check microphone access.', 'warning'));
      } catch {
        stream.getTracks().forEach(track => track.stop()); void context?.close().catch(() => undefined);
        finish(session, 'Audio capture could not start. Check microphone access.', 'warning');
      }
    }, (error: unknown) => finish(session, error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in the browser, then try again.' : 'No microphone is available. Check the selected input device.', 'warning'));
    const stop = () => {
      if (current.current !== session || session.stopped) return;
      session.stopped = true; clearTimeout(session.timer); session.stopCapture?.(); session.stopCapture = undefined;
      setPhase('finishing'); report('Finishing local dictation… Click the mic to cancel.'); void drain();
    };
    stopAction.current = stop;
  };
  const stopAction = useRef<() => void>();
  const active = phase !== 'idle';
  return <>
    <button type="button" class={`cli-attach-button voice-dictation-trigger${active ? ' is-active' : ''}`} disabled={props.disabled && !active}
      aria-label={active ? phase === 'finishing' ? 'Cancel dictation' : 'Stop dictation' : 'Dictate message'} aria-pressed={active}
      title={active ? 'Stop local dictation' : 'Dictate with local Whisper · automatic language detection'}
      onClick={() => active ? phase === 'finishing' && current.current ? finish(current.current, 'Dictation cancelled. Text already added is kept; save the recording to keep any remaining speech.', 'warning') : stopAction.current?.() : start()}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">{active ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /> : <><rect x="9" y="3" width="6" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3m-4 0h8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></>}</svg>
    </button>
    {notice ? <span class={`voice-dictation-inline is-${notice.level}`} role={notice.level === 'warning' ? 'alert' : 'status'}>{notice.message}{recording ? <> <a href={recording} download="dictation.wav">Save recording</a></> : null}</span> : null}
  </>;
}
