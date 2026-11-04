import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardCliSessionSummary, DashboardHostMessage, DashboardNotice } from '../../src/domain/dashboard/types';
import { canResumeCodexSession } from '../../src/domain/codexSessionState';

export function useSessionResume(props: { session?: DashboardCliSessionSummary; connected: boolean; blocked: boolean; send: () => string | undefined; feedback: (notice: DashboardNotice) => void }) {
  const scope = JSON.stringify([props.session?.deviceId, props.session?.id]);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<DashboardNotice>();
  const request = useRef<{ id: string; timer: ReturnType<typeof setTimeout> }>();
  const options = useRef(props); options.current = props;
  const report = (notice: DashboardNotice) => { setStatus(notice); options.current.feedback(notice); };
  useEffect(() => {
    setPending(false); setStatus(undefined);
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const result = event.data;
      if (result?.type !== 'dashboard:action-result' || result.action !== 'resumeCodexSessions' || result.requestId !== request.current?.id) return;
      clearTimeout(request.current.timer); request.current = undefined; setPending(false);
      report(result.status === 'completed' ? result.payload?.notice ?? { level: 'info', message: 'Session resume confirmed.' }
        : { level: result.status === 'cancelled' ? 'warning' : 'error', message: result.error || 'Resume was not confirmed. Refresh the session before retrying.' });
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); if (request.current) clearTimeout(request.current.timer); request.current = undefined; };
  }, [scope]);
  return { available: canResumeCodexSession(props.session), pending, status,
    resume: () => {
      const current = options.current;
      if (request.current || !current.connected || current.blocked || !canResumeCodexSession(current.session)) return;
      try {
        const id = current.send();
        if (!id) { report({ level: 'warning', message: 'Resume was not sent. Reconnect before retrying.' }); return; }
        setStatus(undefined); setPending(true);
        const timer = setTimeout(() => {
          if (request.current?.id !== id) return;
          request.current = undefined; setPending(false);
          report({ level: 'warning', message: 'Resume is unconfirmed. Refresh the session before retrying.' });
        }, 80_000);
        request.current = { id, timer };
      } catch (error) { report({ level: 'error', message: error instanceof Error ? error.message : 'Resume could not be sent.' }); }
    }
  };
}
