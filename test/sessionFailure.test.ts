import { expect, it } from 'vitest';
import { isSessionConnectionFailure, sessionFailureMessage } from '../src/domain/sessionFailure';

it('describes a connection problem with the initiating page and recovery action', () => {
  expect(sessionFailureMessage('Codex app-server connection closed.', 'Task management')).toContain('Connection Interrupted in Task management');
  expect(sessionFailureMessage('Codex Manager could not stop its private app-server process tree.')).toBe('Stop could not be confirmed. In Workspace, refresh the conversation and check whether it is still running before sending again.');
  expect(isSessionConnectionFailure('The turn status could not be verified')).toBe(true);
  expect(sessionFailureMessage('Connection closed.', 'Shared conversation')).toContain('Open the original conversation in Workspace');
  expect(sessionFailureMessage('Quota exhausted. Choose another account.')).toBe('Quota exhausted. Choose another account.');
});

it.each(['', 'The first response failed: '])('shows the provider reason and model recovery action for structured failures: %s', prefix => {
  const reason = "The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account.";
  const raw = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: reason, code: 'model_not_found', subreason: 'model_not_in_accessible_catalog' } });
  const message = prefix + raw + (prefix ? '. Retry your message.' : '');
  expect(sessionFailureMessage(message)).toBe(reason + ' Choose another model in the composer, then retry.');
});

it('preserves structured provider reasons without misclassifying all HTTP 400 errors as model failures', () => {
  const reason = 'Unsupported parameter: temperature.';
  expect(sessionFailureMessage(JSON.stringify({ error: { message: reason, code: 'invalid_request_error' } }))).toBe(reason);
  expect(sessionFailureMessage(JSON.stringify({ error: { message: 'Connection closed.' } }), 'Task management')).toContain('Connection Interrupted in Task management');
});

it.each(['{"error":', '{"error":{"message":""}}', '{"error":{"message":400}}', '{"message":"Keep the original details"}', '{"error":null}', 'The first response failed: {invalid}. Retry your message.'])('keeps unreadable or unsupported error details intact: %s', message => {
  expect(sessionFailureMessage(message)).toBe(message);
});

it('keeps oversized error details intact', () => {
  const message = JSON.stringify({ error: { message: 'x'.repeat(64_000) } });
  expect(sessionFailureMessage(message)).toBe(message);
});
