import { render } from 'preact';
import type { DashboardCliSessionMessage } from '../../src/domain/dashboard/types';
import { SessionMessage } from './cliSessionsModal';

declare global {
  interface Window {
    renderCodexSharedMessages?: (target: HTMLElement, messages: DashboardCliSessionMessage[]) => void;
    clearCodexSharedMessages?: (target: HTMLElement) => void;
  }
}

/** Public pages reuse the workspace renderer without starting authenticated dashboard polling. */
export function initializePublicMessages(): void {
  window.clearCodexSharedMessages = target => render(null, target);
  window.renderCodexSharedMessages = (target, messages) => {
    render(<div class="cli-workspace cli-message-surface"><div class="cli-session-messages">{messages.slice(-2000).map((message, index) => <SessionMessage key={message.id ?? String(index)} message={{ ...message, id: message.id ?? String(index) }} />)}</div></div>, target);
  };
}
