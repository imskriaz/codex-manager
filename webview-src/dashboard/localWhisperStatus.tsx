import { useEffect, useState } from 'preact/hooks';
import { requestLocalDictation } from './localDictationRequest';

export function LocalWhisperStatus(props: { enabled: boolean; targetDeviceId?: string }) {
  const [status, setStatus] = useState<{ warning: boolean; message: string }>();
  useEffect(() => {
    setStatus(undefined);
    if (!props.enabled || props.targetDeviceId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    let initial = true;
    const check = async () => {
      try {
        const result = await requestLocalDictation({ operation: initial ? 'prepare' : 'status' }, controller.signal);
        initial = false;
        if (controller.signal.aborted) return;
        setStatus({ warning: false, message: result.message ?? 'Local Whisper is ready.' });
        if (!result.ready) {
          if (Date.now() - started >= 360_000) { setStatus({ warning: true, message: 'Local Whisper setup is taking too long. Disable and enable it to retry; browser dictation is available when disabled.' }); return; }
          timer = setTimeout(() => void check(), 2000);
        }
      } catch (error) {
        if (!controller.signal.aborted) setStatus({ warning: true, message: error instanceof Error ? error.message : 'Local Whisper setup failed.' });
      }
    };
    void check();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [props.enabled, props.targetDeviceId]);
  return status ? <div class="settings-note" role={status.warning ? 'alert' : 'status'}>{status.message}</div> : null;
}
