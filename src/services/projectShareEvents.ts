import type { ServerResponse } from 'node:http';
import { getSqliteStateStore } from '../storage/sqliteState';
import { getProjectShare, projectTaskKey, type ProjectShare } from './projectTasks';
import { subscribeDashboardRealtime } from './dashboardRealtime';
import { resolveCodexHome } from './codexSessionResume';

/** Public streams carry invalidations only; content still passes the scoped HTTP reads. */
export class ProjectShareEvents {
  private readonly clients = new Map<ServerResponse, { key: string; close: () => void; heartbeat: () => void }>();

  openConversation(response: ServerResponse, token: string, expiresAt: number, sessionId: string | undefined, address: string, valid: () => Promise<unknown>): boolean {
    const key = `${token}:${address}`;
    if (this.clients.size >= 32 || [...this.clients.values()].filter(client => client.key === key).length >= 2) return false;
    let stopped = false, checking = false, notifyAfterCheck = false, lastSent = 0;
    let pending: NodeJS.Timeout | undefined, expiry: NodeJS.Timeout | undefined;
    let unsubscribe = () => {}, unwatch = () => {};
    const close = () => {
      if (stopped) return;
      stopped = true; clearTimeout(pending); clearTimeout(expiry); unsubscribe(); unwatch();
      this.clients.delete(response); response.off('close', close); response.off('error', close);
      if (!response.writableEnded && !response.destroyed) response.end();
    };
    const send = (event: string) => {
      if (stopped) return;
      if (response.destroyed || response.writableEnded) { close(); return; }
      if (response.writableLength > 16 * 1024) { response.destroy(); close(); return; }
      try { response.write(`event: ${event}\ndata: {}\n\n`); } catch { response.destroy(); close(); }
    };
    const check = async (changed: boolean) => {
      if (stopped) return;
      notifyAfterCheck ||= changed;
      if (checking) return;
      checking = true;
      try {
        const current = await valid();
        if (stopped) return;
        if (!current || Date.now() >= expiresAt) { send('revoked'); close(); return; }
        if (notifyAfterCheck) { notifyAfterCheck = false; lastSent = Date.now(); send('change'); }
        else send('keepalive');
      } catch { send('unavailable'); close(); }
      finally { checking = false; }
    };
    const notify = () => {
      if (stopped || pending) return;
      pending = setTimeout(() => { pending = undefined; void check(true); }, Math.max(0, 1500 - (Date.now() - lastSent)));
      pending.unref?.();
    };
    const expire = () => {
      if (stopped) return;
      if (Date.now() >= expiresAt) { send('revoked'); close(); return; }
      expiry = setTimeout(expire, Math.min(expiresAt - Date.now(), 2_147_483_647)); expiry.unref?.();
    };
    try {
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Accel-Buffering', 'no');
      response.on('close', close); response.on('error', close);
      this.clients.set(response, { key, close, heartbeat: () => { void check(false); } });
      if (sessionId) {
        unsubscribe = subscribeDashboardRealtime(message => {
          if (message.type === 'dashboard:codex-session-live' && !message.state.deviceId && message.state.sessionId === sessionId) notify();
        });
        unwatch = getSqliteStateStore()?.subscribe(['sessions','session-status'], notify) ?? (() => {});
      }
      send('ready'); expire(); return true;
    } catch { send('unavailable'); close(); return true; }
  }

  open(response: ServerResponse, token: string, share: ProjectShare, address: string): boolean {
    const key = `${token}:${address}`;
    if (this.clients.size >= 32 || [...this.clients.values()].filter(client => client.key === key).length >= 2) return false;
    const store = getSqliteStateStore();
    if (!store) throw new Error('Project storage is unavailable.');
    let stopped = false, lastSent = 0;
    let pending: NodeJS.Timeout | undefined, expiry: NodeJS.Timeout | undefined;
    let unsubscribe = () => {}, unwatch = () => {};
    const close = () => {
      if (stopped) return;
      stopped = true; clearTimeout(pending); clearTimeout(expiry); unsubscribe(); unwatch();
      this.clients.delete(response); response.off('close', close); response.off('error', close);
      if (!response.writableEnded && !response.destroyed) response.end();
    };
    const send = (event: string): boolean => {
      if (stopped) return false;
      if (response.writableLength > 16 * 1024) { response.destroy(); close(); return false; }
      if (response.destroyed || response.writableEnded) { close(); return false; }
      try { response.write(`event: ${event}\ndata: {}\n\n`); return true; }
      catch { response.destroy(); close(); return false; }
    };
    const valid = (): boolean => {
      if (stopped) return false;
      try {
        if (getProjectShare(token)) return true;
        send('revoked'); close(); return false;
      } catch { send('unavailable'); close(); return false; }
    };
    const notify = () => {
      if (stopped || pending || !valid()) return;
      // Coalesce native event bursts without polling or unbounded HTTP reads.
      pending = setTimeout(() => {
        pending = undefined;
        if (valid() && send('change')) lastSent = Date.now();
      }, Math.max(0, 1500 - (Date.now() - lastSent)));
      pending.unref?.();
    };
    const expire = () => {
      if (!valid() || share.expiresAt === 0) return;
      // Node timers cannot represent the full lifetime of a 30-day link.
      expiry = setTimeout(expire, Math.min(share.expiresAt - Date.now(), 2_147_483_647));
      expiry.unref?.();
    };
    try {
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Accel-Buffering', 'no');
      response.on('close', close); response.on('error', close);
      this.clients.set(response, { key, close, heartbeat: () => { if (valid()) send('keepalive'); } });
      const projectKey = projectTaskKey(share.projectPath);
      unsubscribe = subscribeDashboardRealtime(message => {
        if (message.type === 'dashboard:project-changed' && projectTaskKey(message.projectPath) === projectKey) notify();
        if (message.type === 'dashboard:codex-session-live' && !message.state.deviceId) {
          try {
            const source = `${projectTaskKey(resolveCodexHome())}:${message.state.sessionId.toLowerCase()}`;
            if (store.prepare('SELECT 1 FROM project_tasks WHERE project=? AND source=? LIMIT 1').get(projectKey, source)) notify();
          } catch { send('unavailable'); close(); }
        }
      });
      const projectRevision = () => Number(store.prepare('SELECT revision FROM manager_revisions WHERE topic=?').get(`project:${projectKey}`)?.['revision'] ?? 0);
      let revision = projectRevision();
      unwatch = store.subscribe(['state','sessions','session-status'], topics => {
        if (!valid()) return;
        try {
          const next = projectRevision();
          if (next !== revision || topics.has('sessions') || topics.has('session-status')) { revision = next; notify(); }
        } catch { send('unavailable'); close(); }
      });
      send('ready'); expire();
      return true;
    } catch { send('unavailable'); close(); return true; }
  }

  close(): void { for (const client of [...this.clients.values()]) client.close(); }
  heartbeat(): void { for (const client of [...this.clients.values()]) client.heartbeat(); }
}
