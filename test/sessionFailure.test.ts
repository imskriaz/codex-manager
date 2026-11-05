import { expect, it } from 'vitest';
import { isSessionConnectionFailure, sessionFailureMessage } from '../src/domain/sessionFailure';

it('describes a connection problem with the initiating page and recovery action', () => {
  expect(sessionFailureMessage('Codex app-server connection closed.', 'Task management')).toContain('Connection Interrupted in Task management');
  expect(sessionFailureMessage('Codex Manager could not stop its private app-server process tree.')).toBe('Stop could not be confirmed. In Workspace, refresh the conversation and check whether it is still running before sending again.');
  expect(isSessionConnectionFailure('The turn status could not be verified')).toBe(true);
  expect(sessionFailureMessage('Connection closed.', 'Shared conversation')).toContain('Open the original conversation in Workspace');
  expect(sessionFailureMessage('Quota exhausted. Choose another account.')).toBe('Quota exhausted. Choose another account.');
});
