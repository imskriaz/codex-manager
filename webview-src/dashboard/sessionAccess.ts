import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardCliSandboxMode, DashboardCliSessionSummary, DashboardHostMessage, DashboardNotice } from '../../src/domain/dashboard/types';
import { isCodexSessionAccess, type CodexSessionAccess } from '../../src/domain/codexSessionAccess';

export function useSessionAccess(props: { session?: DashboardCliSessionSummary; connected: boolean; send?: (mode: DashboardCliSandboxMode) => string | undefined; feedback: (notice: DashboardNotice) => void }) {
  const scope = JSON.stringify([props.session?.deviceId, props.session?.id]);
  const [reported, setReported] = useState<{ scope: string; access: CodexSessionAccess }>();
  const [pending, setPending] = useState(false), [status, setStatus] = useState<string>();
  const request = useRef<{ id: string; scope: string; timer: ReturnType<typeof setTimeout> }>();
  const options = useRef(props); options.current = props;
  const source = props.session?.access;
  const access = reported?.scope === scope && reported.access.updatedAt >= (source?.updatedAt ?? 0) ? reported.access : source;
  useEffect(() => {
    setPending(false); setStatus(undefined);
    return () => { if (request.current) clearTimeout(request.current.timer); request.current = undefined; };
  }, [scope]);
  useEffect(() => {
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data, session = options.current.session;
      if (!session) return;
      if (message?.type === 'dashboard:codex-session-access' && message.sessionId === session.id && message.deviceId === session.deviceId && isCodexSessionAccess(message.access)) {
        setReported(previous => previous?.scope === scope && previous.access.updatedAt > message.access.updatedAt ? previous : { scope, access: message.access });
      }
      if (message?.type !== 'dashboard:action-result' || message.action !== 'setCodexSessionAccess' || message.requestId !== request.current?.id || request.current.scope !== scope) return;
      clearTimeout(request.current.timer); request.current = undefined; setPending(false);
      const confirmed = message.payload?.cliSession;
      if (message.status === 'completed' && confirmed?.id === session.id && confirmed.deviceId === session.deviceId && isCodexSessionAccess(confirmed.access)) {
        setReported(previous => previous?.scope === scope && previous.access.updatedAt > confirmed.access!.updatedAt ? previous : { scope, access: confirmed.access! });
        setStatus(message.payload?.notice?.message ?? 'Access synced with Codex.');
      } else {
        const text = message.error ?? 'Access was not confirmed. Refresh Codex settings before retrying.';
        setStatus(text); options.current.feedback({ level: 'warning', message: text });
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [scope]);
  return { mode: access ? access.mode : props.session?.sandboxMode, profile: access?.profile, pending, status,
    change: (mode: DashboardCliSandboxMode) => {
      if (!props.session || !props.connected || request.current || !props.send) return;
      let id: string | undefined;
      try { id = props.send(mode); }
      catch (error) { const message = (error as Error).message || 'Access was not sent.'; setStatus(message); props.feedback({ level: 'error', message }); return; }
      if (!id) { setStatus('Access was not sent. Reconnect and retry.'); return; }
      setPending(true); setStatus('Syncing access with Codex…');
      const timer = setTimeout(() => {
        if (request.current?.id !== id) return;
        request.current = undefined; setPending(false);
        const text = 'The access change is unconfirmed. Refresh Codex settings before retrying.';
        setStatus(text); options.current.feedback({ level: 'warning', message: text });
      }, 80_000);
      request.current = { id, scope, timer };
    }
  };
}
