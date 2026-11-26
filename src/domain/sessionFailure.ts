export function isSessionConnectionFailure(message: string): boolean {
  return /private app-server process|did not finish the turn within|connection (?:closed|interrupted|failed|stopped responding)|app-server .*?(?:closed|disconnected|exited)|turn status could not be verified|turn outcome is unconfirmed/i.test(message);
}

export function sessionFailureMessage(message: string, page = 'Workspace'): string {
  const structured = message.trim().replace(/^The first response failed:\s*/, '').replace(/\. Retry your message\.$/, '');
  if (structured.startsWith('{') && structured.length <= 64_000) {
    try {
      const envelope: unknown = JSON.parse(structured);
      if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) && 'error' in envelope) {
        const error = envelope.error;
        if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.trim()) {
          message = error.message.trim();
          if ('code' in error && error.code === 'model_not_found') message += ' Choose another model in the composer, then retry.';
        }
      }
    } catch {}
  }
  if (page === 'Shared conversation' && isSessionConnectionFailure(message)) return 'Connection Interrupted in Shared conversation. Open the original conversation in Workspace to check its current status.';
  if (/private app-server process/i.test(message)) return `Stop could not be confirmed. In ${page}, refresh the conversation and check whether it is still running before sending again.`;
  if (isSessionConnectionFailure(message)) return `Connection Interrupted in ${page}. Checking the conversation automatically. If this continues, use Refresh conversation in ${page}.`;
  return message;
}
