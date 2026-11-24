import { useEffect, useState } from 'preact/hooks';
import { request } from './teamSettingsRequest';
import { ModalShell } from './primitives';
import { SettingsRecordDetails, SettingsRecordList } from './settingsRecordList';
import type { DashboardCliSessionMessage, DashboardCliSessionSummary } from '../../src/domain/dashboard/types';

export function UserSessions({ id }: { id: string }) {
  const [sessions, setSessions] = useState<DashboardCliSessionSummary[]>([]), [selected, setSelected] = useState<string>();
  const [messages, setMessages] = useState<DashboardCliSessionMessage[]>([]), [detail, setDetail] = useState<DashboardCliSessionSummary>();
  const [status, setStatus] = useState('Loading sessions...'), [failed, setFailed] = useState(false), [tick, setTick] = useState(0), [busy, setBusy] = useState(false);
  const [detailError, setDetailError] = useState(''), [detailBusy, setDetailBusy] = useState(false);
  const url = '/api/office/sessions/' + encodeURIComponent(id);
  useEffect(() => {
    let active = true, loading = false;
    const load = async () => {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true; setBusy(true);
      try { const value = await request<{ sessions: DashboardCliSessionSummary[] }>(url); if (active) { setSessions(value.sessions); setStatus(current => current === 'Refreshing sessions...' ? 'Sessions refreshed.' : ''); setFailed(false); } }
      catch (error) { if (active) { setStatus(error instanceof Error ? error.message : 'Sessions could not be refreshed. Showing the last available list.'); setFailed(true); } }
      finally { loading = false; if (active) setBusy(false); }
    };
    void load(); const timer = window.setInterval(() => void load(), 10000); const refresh = () => void load();
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [url, tick]);
  useEffect(() => {
    if (!selected) return;
    let active = true, loading = false;
    const load = async () => {
      if (loading) return;
      loading = true; setDetailBusy(true);
      try { const value = await request<{ session: DashboardCliSessionSummary; messages: DashboardCliSessionMessage[] }>(url + '/' + encodeURIComponent(selected)); if (active) { setDetail(value.session); setMessages(value.messages); setDetailError(''); } }
      catch (error) { if (active) setDetailError(error instanceof Error ? error.message : 'Session details could not be loaded.'); }
      finally { loading = false; if (active) setDetailBusy(false); }
    };
    setDetail(undefined); setMessages([]); setDetailError(''); void load();
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [url, selected, tick]);
  const label = (session: DashboardCliSessionSummary) => session.queueEnabled ? 'Queued' : session.status === 'running' ? 'Running' : session.status === 'unknown' ? 'Unknown' : 'Ready';
  return <section aria-label="User sessions"><div class="user-memory-heading"><h3 class="settings-block-title">Sessions</h3><button type="button" disabled={busy} onClick={() => { setStatus('Refreshing sessions...'); setTick(value => value + 1); }}>Refresh sessions</button></div>{status ? <p role={failed ? 'alert' : 'status'}>{status}</p> : null}{!sessions.length && !busy && !failed ? <p>No sessions yet.</p> : null}{sessions.length ? <SettingsRecordList label="User sessions" columns={['Chat', 'Status', 'Last activity']} onSelect={setSelected} rows={sessions.map(session => ({ id: session.id, label: `View ${session.title}`, cells: [session.title, label(session), session.updatedAt ? new Date(session.updatedAt).toLocaleString() : 'Unknown'], details: null }))} /> : null}<ModalShell open={!!selected} title={detail?.title ?? 'Session details'} closeLabel="Close session details" className="settings-record-modal" onClose={() => setSelected(undefined)}>{detail ? <SettingsRecordDetails fields={[[ 'Status', label(detail)], ['Last activity', detail.updatedAt ? new Date(detail.updatedAt).toLocaleString() : 'Unknown']]} /> : null}{detailBusy && !detail ? <p role="status">Loading session details...</p> : null}{detailError ? <><p role="alert">{detailError}</p><button type="button" disabled={detailBusy} onClick={() => setTick(value => value + 1)}>Retry session details</button></> : null}<ol class="user-session-messages">{messages.map(message => <li key={message.id}><strong>{message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.title || message.kind || 'Activity'}</strong>{message.text ? <p>{message.text}</p> : null}</li>)}</ol>{detail && !detailBusy && !messages.length ? <p>No messages yet.</p> : null}</ModalShell></section>;
}
