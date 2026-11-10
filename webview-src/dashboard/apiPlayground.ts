import { PROJECT_API_ACTIONS } from '../../src/domain/dashboard/apiActions';

export const API_ENDPOINTS = [
  { id: 'action', method: 'POST', path: '/api/message', label: 'Dashboard operation', description: 'Run an allowed operation. Write operations keep their normal confirmation and ownership checks.', permission: 'action', group: 'Manager' },
  { id: 'state', method: 'GET', path: '/api/state', label: 'Dashboard state', description: 'Read current state within the token’s project scope.', permission: 'state', group: 'Manager' },
  { id: 'schema', method: 'GET', path: '/api/schema', label: 'Token permissions', description: 'Inspect the operations, project folders and permissions granted to this token.', permission: 'schema', group: 'Manager' },
  { id: 'models', method: 'GET', path: '/v1/models', label: 'Available models', description: 'Discover model IDs through the saved-account proxy. No local conversation is created.', permission: 'aiProxy', group: 'AI proxy' },
  { id: 'chat', method: 'POST', path: '/v1/chat/completions', label: 'Chat Completions', description: 'OpenAI-compatible messages, images and function tools through the active saved account.', permission: 'aiProxy', group: 'AI proxy' },
  { id: 'responses', method: 'POST', path: '/v1/responses', label: 'Responses', description: 'OpenAI-compatible input and output. Set stream to true to inspect server-sent events.', permission: 'aiProxy', group: 'AI proxy' },
  { id: 'messages', method: 'POST', path: '/v1/messages', label: 'Messages', description: 'Claude-compatible message format using the Codex model IDs returned by /v1/models.', permission: 'aiProxy', group: 'AI proxy' }
] as const;
export type ApiEndpointId = typeof API_ENDPOINTS[number]['id'];
export type ApiInspection = { actions: string[]; projects: string[]; permissions: string[] };
export function canTestApiEndpoint(endpoint: ApiEndpointId, access: ApiInspection | undefined, operation: string): boolean {
  if (!access) return false;
  const permission = API_ENDPOINTS.find(item => item.id === endpoint)!.permission;
  if (permission === 'schema') return true;
  if (permission === 'action') return access.actions.includes(operation);
  if (permission === 'aiProxy' && access.projects.length) return false;
  return access.permissions.includes('*') || access.permissions.includes(permission);
}
export function apiPayloadExample(endpoint: ApiEndpointId, model = 'YOUR_MODEL_ID'): string {
  if (endpoint === 'chat') return JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false }, null, 2);
  if (endpoint === 'responses') return JSON.stringify({ model, input: 'Reply with OK.', stream: false }, null, 2);
  if (endpoint === 'messages') return JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false }, null, 2);
  return '{}';
}
export function buildApiTestRequest(endpoint: ApiEndpointId, input: string, operation: string, project: string, requestId: string): { path: string; method: string; body?: string } {
  const item = API_ENDPOINTS.find(item => item.id === endpoint)!;
  if (item.method === 'GET') return { path: item.path, method: 'GET' };
  const parsed: unknown = JSON.parse(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Payload must be a JSON object.');
  const payload = parsed as Record<string, unknown>;
  if (item.permission === 'aiProxy' && (typeof payload['model'] !== 'string' || !payload['model'].trim() || payload['model'] === 'YOUR_MODEL_ID')) throw new Error('Choose a model from /v1/models or enter its ID in the payload.');
  return { path: item.path, method: 'POST', body: JSON.stringify(endpoint === 'action' ? { type: 'dashboard:action', requestId, action: operation, payload: { ...(project && PROJECT_API_ACTIONS.has(operation as never) ? { projectPath: project } : {}), ...payload } } : payload) };
}
