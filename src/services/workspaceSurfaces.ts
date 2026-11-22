import { randomUUID } from 'node:crypto';
import { isWorkspaceSurfaceRequest, isWorkspaceSurfaceState, type WorkspaceSurfaceRequest, type WorkspaceSurfaceResult, type WorkspaceSurfaceState } from '../domain/workspaceSurface';
import type { DashboardHostMessage } from '../domain/dashboard/types';
import { projectTaskKey } from './projectTasks';

type Connection = { state: WorkspaceSurfaceState; seenAt: number; send: (message: DashboardHostMessage) => void };
const connections = new Map<object, Connection>();
const pending = new Map<string, { owner: object; context: WorkspaceSurfaceState; resolve: (value: WorkspaceSurfaceResult) => void; reject: (error: Error) => void }>();

export function updateWorkspaceSurface(owner: object, state: unknown, send: Connection['send']): void {
  if (!isWorkspaceSurfaceState(state)) throw new Error('Invalid workspace surface state.');
  if ([...connections.entries()].some(([other, value]) => other !== owner && value.state.surfaceId === state.surfaceId)) throw new Error('This workspace surface is already connected. Refresh this dashboard.');
  connections.set(owner, { state, seenAt: Date.now(), send });
  for (const item of pending.values()) if (item.owner === owner && (!sameContext(item.context, state) || !state.visible)) {
    item.reject(new Error('The dashboard workspace changed or moved to the background. The panel command outcome is unknown; inspect before retrying.'));
  }
}

export function removeWorkspaceSurface(owner: object): void {
  connections.delete(owner);
  for (const item of pending.values()) if (item.owner === owner) item.reject(new Error('The dashboard disconnected. The panel command outcome is unknown; inspect before retrying.'));
}

function sameContext(left: WorkspaceSurfaceState, right: WorkspaceSurfaceState): boolean {
  return left.surfaceId === right.surfaceId && projectTaskKey(left.projectPath) === projectTaskKey(right.projectPath) && left.sessionId === right.sessionId && left.targetDeviceId === right.targetDeviceId;
}

export function acknowledgeWorkspaceSurface(owner: object, requestId: string, state: unknown, error?: string, content?: unknown): void {
  const item = pending.get(requestId);
  if (!item || item.owner !== owner) return;
  if (error) { item.reject(new Error(error)); return; }
  if (!isWorkspaceSurfaceState(state) || !sameContext(item.context, state)) { item.reject(new Error('The user changed the workspace. No other workspace was controlled.')); return; }
  const connection = connections.get(owner);
  if (connection) { connection.state = state; connection.seenAt = Date.now(); }
  item.resolve({ surfaces: [state], ...(content === undefined ? {} : { content }) });
}

export async function workspaceSurface(projectPath: string | undefined, request: unknown, localOnly = false, ownerAllowed: (owner: object) => boolean = () => true, timeoutMs=25000): Promise<WorkspaceSurfaceResult> {
  if (!projectPath?.trim() || !isWorkspaceSurfaceRequest(request)) throw new Error('Provide a projectPath and a valid workspace surface request.');
  const matches = [...connections.entries()].filter(([owner, value]) => ownerAllowed(owner) && (!localOnly || !value.state.targetDeviceId) && Date.now() - value.seenAt < 45000 && projectTaskKey(value.state.projectPath) === projectTaskKey(projectPath) &&
    (!request.surfaceId || value.state.surfaceId === request.surfaceId) &&
    (request.operation === 'list' && !request.sessionId || value.state.sessionId === request.sessionId));
  if (request.operation === 'list') return { surfaces: matches.map(([, value]) => value.state) };
  if (!request.surfaceId || matches.length !== 1) throw new Error('Choose the connected surfaceId and sessionId from workspace list. No panel was changed.');
  const [owner, connection] = matches[0]!;
  if (!connection.state.visible) throw new Error('That dashboard is in the background. Bring it to the foreground before controlling its panel.');
  if ([...pending.values()].some(item => item.owner === owner)) throw new Error('A panel command is pending for this dashboard. Read its outcome before retrying.');
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, value?: WorkspaceSurfaceResult) => { clearTimeout(timer); pending.delete(requestId); if (error) reject(error); else resolve(value!); };
    const timer = setTimeout(() => finish(new Error('The dashboard did not acknowledge the panel command. Its outcome is unknown; inspect before retrying.')), timeoutMs);
    pending.set(requestId, { owner, context: connection.state, resolve: value => finish(undefined, value), reject: error => finish(error) });
    try { connection.send({ type: 'dashboard:workspace-command', requestId, projectPath: connection.state.projectPath, sessionId: connection.state.sessionId, targetDeviceId: connection.state.targetDeviceId, request: request as WorkspaceSurfaceRequest }); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
