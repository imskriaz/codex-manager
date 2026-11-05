export function isSessionConnectionFailure(message: string): boolean {
  return /private app-server process|did not finish the turn within|connection (?:closed|interrupted|failed|stopped responding)|app-server .*?(?:closed|disconnected|exited)|turn status could not be verified|turn outcome is unconfirmed/i.test(message);
}

export function sessionFailureMessage(message: string, page = 'Workspace'): string {
  if (page === 'Shared conversation' && isSessionConnectionFailure(message)) return 'Connection Interrupted in Shared conversation. Open the original conversation in Workspace to check its current status.';
  if (/private app-server process/i.test(message)) return `Stop could not be confirmed. In ${page}, refresh the conversation and check whether it is still running before sending again.`;
  if (isSessionConnectionFailure(message)) return `Connection Interrupted in ${page}. Checking the conversation automatically. If this continues, use Refresh conversation in ${page}.`;
  return message;
}
