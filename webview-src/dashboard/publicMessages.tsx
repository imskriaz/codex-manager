import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { DashboardCliSessionMessage, DashboardCliSessionSummary, DashboardNotice } from '../../src/domain/dashboard/types';
import { TaskBoard } from './taskBoard';
import { scheduleDashboardToastDismiss, DASHBOARD_INFO_TOAST_DURATION_MS, DASHBOARD_TOAST_DURATION_MS } from './toast';
import { ConversationHeader, SessionTranscript } from './cliSessionsModal';

declare global {
  interface Window {
    renderCodexSharedMessages?: (target: HTMLElement, messages: DashboardCliSessionMessage[]) => void;
    renderCodexSharedBoard?: (target: HTMLElement, props: Parameters<typeof TaskBoard>[0]) => void;
    renderCodexSharedHeader?: (target: HTMLElement, session: DashboardCliSessionSummary, onRefresh: () => void) => void;
    clearCodexSharedMessages?: (target: HTMLElement) => void;
  }
}

/** Public pages reuse the workspace renderer without starting authenticated dashboard polling. */
export function initializePublicMessages(): void {
  window.renderCodexSharedBoard = (target, props) => render(<TaskBoard {...props}/>, target);
  window.renderCodexSharedHeader = (target, session, onRefresh) => render(<ConversationHeader session={session} readOnly onRefresh={onRefresh}/>, target);
  window.clearCodexSharedMessages = target => render(null, target);
  window.renderCodexSharedMessages = (target, messages) => {
    render(<SharedTranscript messages={messages}/>, target);
  };
}

function SharedTranscript({ messages }: { messages: DashboardCliSessionMessage[] }) {
  const [notice, setNotice] = useState<DashboardNotice>();
  useEffect(() => notice ? scheduleDashboardToastDismiss(() => setNotice(undefined), notice.level === 'info' ? DASHBOARD_INFO_TOAST_DURATION_MS : DASHBOARD_TOAST_DURATION_MS) : undefined, [notice]);
  return <><div class="cli-workspace cli-message-surface"><div class="cli-session-messages"><SessionTranscript messages={messages.slice(-2000).map((message, index) => ({ ...message, id: message.id ?? String(index) }))} running={messages.some(message => message.status === 'inProgress')} onActionFeedback={setNotice}/></div></div>{notice ? createPortal(<div class="dashboard-notice-stack" aria-live="polite"><div class={`dashboard-notice is-${notice.level}`} role={notice.level === 'error' ? 'alert' : 'status'}><span>{notice.message}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice(undefined)}>×</button></div></div>, document.body) : null}</>;
}
