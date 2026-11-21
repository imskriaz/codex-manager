import type { SqliteStateStore } from './sqliteState';
import type { CoordinationMessage, SessionCoordinationRequest, SessionCoordinationResult } from '../domain/sessionCoordination';

const participants = 'session-coordination-participants', messages = 'session-coordination-messages';
type Scope = { home: string; project: string };
type Participant = Scope & { sessionId: string; activity: string; note: string; updatedAt: number };
type SavedMessage = CoordinationMessage & Scope;
const day = 24 * 60 * 60_000;

export function pruneSessionCoordination(store: SqliteStateStore, now = Date.now()): void {
  store.prepare("DELETE FROM state WHERE namespace=? AND (NOT json_valid(value) OR CASE WHEN json_valid(value) THEN COALESCE(json_extract(value,'$.updatedAt'),0)<? END)").run(participants, now - day);
  store.prepare("DELETE FROM state WHERE namespace=? AND (NOT json_valid(value) OR CASE WHEN json_valid(value) THEN COALESCE(json_extract(value,'$.createdAt'),0)<? OR json_extract(value,'$.acknowledgedAt')<? END)").run(messages, now - 7 * day, now - day);
}

export function removeSessionCoordination(store: SqliteStateStore, home: string, sessionId: string): void {
  store.prepare("DELETE FROM state WHERE namespace IN (?,?) AND json_valid(value) AND json_extract(value,'$.home')=? AND (json_extract(value,'$.sessionId')=? OR json_extract(value,'$.fromSessionId')=? OR json_extract(value,'$.toSessionId')=?)")
    .run(participants, messages, home, sessionId, sessionId, sessionId);
  store.prepare("DELETE FROM state WHERE namespace='session-coordination-controls' AND json_valid(value) AND json_extract(value,'$.home')=? AND (json_extract(value,'$.sessionId')=? OR json_extract(value,'$.control.targetSessionId')=?)").run(home, sessionId, sessionId);
}

/** These are peer mailboxes, never native prompts or authorization to run commands. */
export function coordinateStoredSessions(store: SqliteStateStore, scope: Scope, sessionId: string | undefined, request: SessionCoordinationRequest, now = Date.now()): SessionCoordinationResult {
  return store.transaction(() => {
    pruneSessionCoordination(store, now);
    if (sessionId && store.get('deleted-codex-sessions', `${scope.home}:${sessionId}`) !== undefined || request.toSessionId && store.get('deleted-codex-sessions', `${scope.home}:${request.toSessionId}`) !== undefined)
      throw new Error('This session was deleted. Refresh session discovery.');
    const scoped = <T>(namespace: string): T[] => store.prepare("SELECT value FROM state WHERE namespace=? AND json_extract(value,'$.home')=? AND json_extract(value,'$.project')=? ORDER BY json_extract(value,'$.createdAt'),key")
      .all(namespace, scope.home, scope.project).map(row => JSON.parse(String(row['value'])) as T);
    if (request.operation === 'list') return { peers: scoped<Participant>(participants).map(row => ({ sessionId: row.sessionId, activity: now - row.updatedAt <= 5 * 60_000 ? row.activity : 'unknown', note: row.note, updatedAt: row.updatedAt })) };
    if (!sessionId) throw new Error('Provide your current sessionId for mailbox operations.');
    if (request.operation === 'status') {
      if (!['working', 'blocked', 'idle'].includes(request.activity ?? '') || typeof request.note !== 'string' || request.note.length > 2000)
        throw new Error('Provide activity working/blocked/idle and a note of at most 2,000 characters.');
      const key = JSON.stringify([scope.home, scope.project, sessionId]);
      if (!store.get(participants, key) && Number(store.prepare('SELECT count(*) AS n FROM state WHERE namespace=?').get(participants)?.['n']) >= 2000)
        throw new Error('Coordination participant storage is full. Retry after expired entries are cleaned.');
      store.set(participants, key, { ...scope, sessionId, activity: request.activity, note: request.note, updatedAt: now });
      return {};
    }
    if (request.operation === 'send') {
      if (!request.toSessionId || request.toSessionId === sessionId || !/^[a-zA-Z0-9_.-]{1,100}$/.test(request.messageId ?? '') || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 4000)
        throw new Error('Provide another session, a stable messageId (1–100 letters, digits, _, ., -), and text of at most 4,000 characters.');
      const key = JSON.stringify([scope.home, request.messageId]);
      const existing = store.get<SavedMessage>(messages, key);
      if (existing) {
        if (existing.project !== scope.project || existing.fromSessionId !== sessionId || existing.toSessionId !== request.toSessionId || existing.text !== request.text)
          throw new Error('This messageId already belongs to different content. Use a new messageId.');
        const { home: _home, project: _project, ...message } = existing;
        return { message };
      }
      if (Number(store.prepare('SELECT count(*) AS n FROM state WHERE namespace=?').get(messages)?.['n']) >= 2000 ||
        Number(store.prepare("SELECT count(*) AS n FROM state WHERE namespace=? AND json_extract(value,'$.home')=? AND json_extract(value,'$.toSessionId')=? AND json_extract(value,'$.acknowledgedAt') IS NULL").get(messages, scope.home, request.toSessionId)?.['n']) >= 200)
        throw new Error('Coordination inbox is full. Have the recipient read and acknowledge messages, then retry.');
      const message: CoordinationMessage = { id: request.messageId!, fromSessionId: sessionId, toSessionId: request.toSessionId, text: request.text, createdAt: now };
      store.set(messages, key, { ...scope, ...message });
      return { message };
    }
    const inbox = scoped<SavedMessage>(messages).filter(row => row.toSessionId === sessionId && row.acknowledgedAt === undefined);
    if (request.operation === 'read') return { messages: inbox.slice(0, 50).map(({ home: _home, project: _project, ...message }) => message), more: inbox.length > 50 };
    if (request.operation === 'acknowledge') {
      if (!Array.isArray(request.messageIds) || request.messageIds.length > 100 || request.messageIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(id)))
        throw new Error('Provide at most 100 messageIds to acknowledge.');
      for (const id of request.messageIds) {
        const message = store.get<SavedMessage>(messages, JSON.stringify([scope.home, id]));
        if (!message || message.project !== scope.project || message.toSessionId !== sessionId) throw new Error('A message is missing or outside your inbox. No acknowledgements were saved.');
      }
      let acknowledged = 0;
      for (const message of inbox.filter(row => request.messageIds!.includes(row.id))) {
        store.set(messages, JSON.stringify([scope.home, message.id]), { ...message, acknowledgedAt: now }); acknowledged++;
      }
      return { acknowledged };
    }
    throw new Error('Unknown coordination operation.');
  });
}
