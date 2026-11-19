import { useLayoutEffect, useRef } from 'preact/hooks';
import type { DashboardHostMessage } from '../../src/domain/dashboard/types';
import type { WorkspaceSurfaceRequest, WorkspaceSurfaceState } from '../../src/domain/workspaceSurface';
import { postMessageToHost } from './host';

export function useWorkspaceSurface(
  state: Omit<WorkspaceSurfaceState, 'surfaceId' | 'visible' | 'viewport' | 'host'> | undefined,
  connected: boolean,
  command: (request: WorkspaceSurfaceRequest, assertCurrent: () => void) => Promise<unknown>
): void {
  const id = useRef(crypto.randomUUID());
  const running = useRef(false);
  const latest = useRef({ state, command }); latest.current = { state, command };
  const snapshot = (): WorkspaceSurfaceState | undefined => latest.current.state && ({
    ...latest.current.state, surfaceId: id.current,
    visible: document.visibilityState === 'visible', viewport: { width: innerWidth, height: innerHeight },
    host: document.documentElement.dataset['dashboardHost'] === 'browser' ? 'browser' : 'webview'
  });
  const encoded = JSON.stringify(state);
  useLayoutEffect(() => {
    if (!connected) return;
    const publish = () => postMessageToHost({ type: 'dashboard:workspace-surface', state: snapshot() });
    const timer = setInterval(publish, 10000);
    document.addEventListener('visibilitychange', publish);
    window.addEventListener('resize', publish);
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== 'dashboard:workspace-command' || message.request.surfaceId !== id.current) return;
      const before = snapshot();
      void (async () => {
        let error: string | undefined, content: unknown, started = false;
        const assertCurrent = () => {
          const current = snapshot();
          if (!current || !current.visible || current.projectPath !== message.projectPath || current.sessionId !== message.sessionId || current.targetDeviceId !== message.targetDeviceId) throw new Error('The workspace changed or is in the background. No other workspace was controlled.');
        };
        try {
          assertCurrent();
          if (running.current) throw new Error('A workspace command is already running.');
          running.current = true; started = true;
          content = await latest.current.command(message.request, assertCurrent);
          // Reads do not change the UI; only mutations need to reach the next rendered frame.
          if (message.request.operation !== 'read') await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          assertCurrent();
          const after = snapshot();
          if (!before || !after || after.projectPath !== before.projectPath || after.sessionId !== before.sessionId || after.targetDeviceId !== before.targetDeviceId) throw new Error('The selected workspace changed. Check the previous command outcome before retrying.');
          if (message.request.operation === 'read' && (after.activeTab !== before.activeTab || after.panelOpen !== before.panelOpen)) throw new Error('The visible panel changed while reading. Read the current panel again.');
          if (message.request.operation === 'hide' && after.panelOpen || ['open', 'select'].includes(message.request.operation) && !after.panelOpen) throw new Error('The panel did not reach the requested visibility. Inspect before retrying.');
          if (message.request.operation === 'select' && after.activeTab !== message.request.tab) throw new Error('The requested tab was not selected. Inspect before retrying.');
        } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
        finally { if (started) running.current = false; }
        postMessageToHost({ type: 'dashboard:workspace-command-result', requestId: message.requestId, state: snapshot(), ...(error ? { error } : { content }) });
      })();
    };
    window.addEventListener('message', receive);
    return () => {
      clearInterval(timer); document.removeEventListener('visibilitychange', publish); window.removeEventListener('resize', publish); window.removeEventListener('message', receive);
      postMessageToHost({ type: 'dashboard:workspace-surface' });
    };
  }, [connected]);
  // Publish committed tab/session changes immediately, without reinstalling the command listener.
  useLayoutEffect(() => {
    if (connected) postMessageToHost({ type: 'dashboard:workspace-surface', state: snapshot() });
  }, [connected, encoded]);
}
