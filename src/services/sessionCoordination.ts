import type { SessionCoordinationRequest, SessionCoordinationResult } from '../domain/sessionCoordination';
import { getCodexHomeStateKey } from '../codex/authFile';
import { getSqliteStateStore } from '../storage/sqliteState';
import { coordinateStoredSessions } from '../storage/sqliteCoordination';
import { isConfirmedSessionDeleted } from '../storage/sqliteSessions';
import { readCodexCliSessionSummary, readCodexCliSessions, resolveCodexHome } from './codexSessionResume';
import { projectTaskKey } from './projectTasks';
import { resolveWorkspaceProjectPathAsync } from './workspaceTools';
import { waitWithin } from '../utils/concurrency';

export async function coordinateCodexSessions(projectPath: string | undefined, sessionId: string | undefined, request: SessionCoordinationRequest | undefined): Promise<SessionCoordinationResult> {
  if (!request || !['list', 'status', 'send', 'read', 'acknowledge'].includes(request.operation)) throw new Error('Choose a coordination operation.');
  if (request.operation !== 'list' && !sessionId) throw new Error('Provide your current sessionId.');
  const store = getSqliteStateStore(), home = resolveCodexHome();
  if (!store) throw new Error('Coordination storage is unavailable. Reconnect and retry.');
  const project = await resolveWorkspaceProjectPathAsync(projectPath), projectKey = projectTaskKey(project);
  const ids = [...new Set([sessionId, ...(request.operation === 'send' ? [request.toSessionId] : [])].filter((id): id is string => id !== undefined).map(id => typeof id === 'string' ? id.toLowerCase() : ''))];
  await Promise.all(ids.map(async id => {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error('Provide a valid native session UUID.');
    const summary = await waitWithin(readCodexCliSessionSummary(id, home, 'display'), 5000, 'Session ownership could not be verified. Retry when connected.');
    if (!summary?.projectPath || projectTaskKey(summary.projectPath) !== projectKey || isConfirmedSessionDeleted(store, home, id))
      throw new Error('The session is missing or belongs to another project. No coordination operation was started.');
  }));
  let nativePeers: SessionCoordinationResult['peers'] = [], warning: string | undefined;
  if (request.operation === 'list') {
    try {
      const sessions = await waitWithin(readCodexCliSessions(home), 750, 'Native session discovery is still loading. Registered peers are shown; retry for the complete list.');
      nativePeers = sessions.filter(row => row.projectPath && projectTaskKey(row.projectPath) === projectKey && !row.archived && !isConfirmedSessionDeleted(store, home, row.id))
        .slice(0, 200).map(row => ({ sessionId: row.id, title: row.title, runtimeStatus: row.status }));
      if (sessions.filter(row => row.projectPath && projectTaskKey(row.projectPath) === projectKey && !row.archived).length > 200) warning = 'Showing the first 200 native sessions. Registered peers are included separately.';
    } catch (error) { warning = error instanceof Error ? error.message : String(error); }
  }
  if (home !== resolveCodexHome() || getSqliteStateStore() !== store) throw new Error('The active storage changed. Retry coordination.');
  const result = coordinateStoredSessions(store, { home: getCodexHomeStateKey(home), project: projectKey }, sessionId?.toLowerCase(), { ...request, toSessionId: request.toSessionId?.toLowerCase() });
  if (request.operation === 'list') {
    const peers = new Map(nativePeers.map(row => [row.sessionId, row]));
    for (const row of result.peers ?? []) peers.set(row.sessionId, { ...peers.get(row.sessionId), ...row });
    result.peers = [...peers.values()];
  }
  return { ...result, ...(warning ? { warning } : {}) };
}
