import type { SessionCoordinationRequest, SessionCoordinationResult } from '../domain/sessionCoordination';
import type { SqliteStateStore } from '../storage/sqliteState';
import { coordinateStoredSessions } from '../storage/sqliteCoordination';
import { cancelCodexCliSessionTurn, CodexCliTurnCancelledError, readCodexCliSessionSummary, resolveCodexHome, sendCodexCliSessionMessage } from './codexSessionResume';
import { markCodexSessionManualStop } from './codexSessionPreferences';
import { publishDashboardRealtime } from './dashboardRealtime';
import { waitWithin } from '../utils/concurrency';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';
import { projectTaskKey } from './projectTasks';
import { getSqliteStateStore } from '../storage/sqliteState';
import { createHash } from 'node:crypto';

const namespace = 'session-coordination-controls';
type Control = NonNullable<SessionCoordinationResult['control']>;
type Record = { home: string; project: string; sessionId: string; fingerprint: string; control: Control; updatedAt: number };

/** Launch claims survive disconnects: an uncertain handover must never start a second turn. */
export function controlCoordinatedSession(store: SqliteStateStore, scope: { home: string; project: string }, nativeHome: string,
  projectPath: string, sessionId: string, request: SessionCoordinationRequest): Promise<SessionCoordinationResult> {
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(request.operationId ?? '')) throw new Error('Provide a stable operationId of 1–80 letters, digits, _, ., or -.');
  const operationId = request.operationId!;
  const key = JSON.stringify([scope.home, scope.project, sessionId, operationId]);
  return runCrossWindowExclusive(`coordination:${key}`, 'Coordinate session control', async () => {
    const previous = store.get<Record>(namespace, key);
    if (request.operation === 'controlStatus') {
      if (!previous) throw new Error('This coordination operation was not found.');
      return result(previous.control);
    }
    if (!request.toSessionId || request.toSessionId === sessionId) throw new Error('Choose another session to control.');
    if (request.expectedTurnId !== undefined && (!request.expectedTurnId.trim() || request.expectedTurnId.length > 256)) throw new Error('Provide a valid expectedTurnId.');
    if (request.text !== undefined && (!request.text.trim() || request.text.length > 3500)) throw new Error('Use a task summary of 1–3,500 characters.');
    if (request.operation === 'handover' && (!request.handoverToSessionId || request.handoverToSessionId === request.toSessionId || !request.text?.trim())) throw new Error('Handover needs a different destination session and a task summary in text.');
    if (request.start !== undefined && typeof request.start !== 'boolean') throw new Error('Use true or false for start.');
    const fingerprint = JSON.stringify({ ...request, operationId: undefined });
    if (previous && previous.fingerprint !== fingerprint) throw new Error('This operationId belongs to different content. Use a new operationId.');
    if (previous && previous.control.status !== 'pending') return result(previous.control);
    const targetSessionId = request.toSessionId;
    const save = (status: Control['status'], message: string) => {
      const control: Control = { operationId, status, message, targetSessionId };
      store.set(namespace, key, { ...scope, sessionId, fingerprint, control, updatedAt: Date.now() } satisfies Record);
      return result(control);
    };
    // Expire only old completed records, never uncertain launch claims.
    store.prepare("DELETE FROM state WHERE namespace=? AND json_extract(value,'$.control.status')='completed' AND json_extract(value,'$.updatedAt')<?").run(namespace, Date.now() - 7 * 86_400_000);
    if (!previous && store.keys(namespace).length >= 2000) throw new Error('Session control storage is full. Inspect unresolved operations before retrying.');
    const read = async (id: string) => {
      const summary = await waitWithin(readCodexCliSessionSummary(id, nativeHome, false), 5000, 'Session control state could not be verified.');
      if (nativeHome !== resolveCodexHome() || getSqliteStateStore() !== store || !summary || summary.archived || summary.subAgent || !summary.projectPath || projectTaskKey(summary.projectPath) !== scope.project) throw new Error('The session, project, or Codex home changed. No new turn was started.');
      return summary;
    };
    const source = await read(targetSessionId);
    if (request.operation !== 'resume') {
      if (request.expectedTurnId && source.status === 'running' && source.steerTurnId && source.steerTurnId !== request.expectedTurnId) throw new Error('The active turn changed. Refresh before stopping or handing over.');
      markCodexSessionManualStop(nativeHome, targetSessionId, source.steerTurnId);
      if (source.status !== 'idle') {
        if (!previous && source.canStop && source.steerTurnId) {
          // Persist uncertainty before the external side effect; never replay after a timeout.
          save('unknown', 'Stop was requested; its outcome has not been confirmed. Inspect the source session before retrying.');
          const stopped = await cancelCodexCliSessionTurn(targetSessionId, request.expectedTurnId ?? source.steerTurnId);
          if (!stopped) return save('unknown', 'The owner did not confirm stopping. Inspect the source session; no handover was started.');
          const current = await read(targetSessionId);
          if (current.status !== 'idle') return save('unknown', 'The owner accepted Stop but the session is still settling. No destination was started.');
        } else {
          coordinateStoredSessions(store, scope, sessionId, { operation: 'send', toSessionId: targetSessionId, messageId: `control-${createHash('sha256').update(key).digest('hex')}`,
            text: `Coordination request: ${request.operation}. Reach a safe checkpoint, save your progress, then end this turn. Automatic recovery has been held. ${request.text ?? ''}` });
          return save('pending', 'The owner is not reachable. A cooperative stop request is queued; the peer must read it and end its turn. Stop is not confirmed and no destination was started.');
        }
      }
      if (request.operation !== 'handover') return save('completed', `${request.operation === 'pause' ? 'Paused' : 'Stopped'}; the session is idle and automatic recovery is held.`);
    }
    const destinationId = request.operation === 'handover' ? request.handoverToSessionId! : targetSessionId;
    const destination = await read(destinationId);
    const text = request.operation === 'handover' ? `Task handover from ${targetSessionId}:\n${request.text}` : request.text ?? 'Continue if not completed';
    if (request.operation === 'handover') {
      if (destinationId !== sessionId) coordinateStoredSessions(store, scope, sessionId, { operation: 'send', toSessionId: destinationId, messageId: `handover-${createHash('sha256').update(key).digest('hex')}`, text });
      if (request.start !== true) return save('completed', destinationId === sessionId ? `Source stopped. Handover to this session:\n${text}` : 'Source stopped. Task handover queued in the destination inbox; delivery has not been acknowledged and no turn was started.');
    }
    if (destination.status !== 'idle' || destination.locked) throw new Error('The destination still has a writer or its state is unknown. No turn was started.');
    if (request.operation === 'handover' && (await read(targetSessionId)).status !== 'idle') throw new Error('The source started another turn. No destination was started.');
    save('unknown', 'Starting the destination was attempted. Inspect its current state; do not replay this operation with a new ID.');
    const controller = new AbortController();
    let started = false;
    let accept!: () => void;
    const accepted = new Promise<void>(resolve => { accept = resolve; });
    const turn = sendCodexCliSessionMessage({ sessionId: destinationId, projectPath, text, clearManualStop: true, preferPrivate: true,
      signal: controller.signal, onStarted: () => { started = true; accept(); } });
    void turn.catch(error => {
      if (!(error instanceof CodexCliTurnCancelledError)) publishDashboardRealtime({ type: 'dashboard:notice', level: 'error', message: `Coordinated session failed: ${error instanceof Error ? error.message : String(error)}` });
    });
    try {
      await waitWithin(Promise.race([accepted, turn]), 15_000, 'Destination start was not confirmed. Inspect the session before retrying.');
      if (!started) throw new Error('Codex did not confirm starting the destination. Inspect its conversation before retrying.');
    } catch (error) { controller.abort(); throw error; }
    return save('completed', request.operation === 'handover' ? 'Source stopped and destination accepted the handover turn.' : 'The destination accepted the resume turn.');
  }, { waitMs: 500 });
}

function result(control: Control): SessionCoordinationResult {
  return { control, ...(control.status !== 'completed' ? { warning: control.message } : {}) };
}
