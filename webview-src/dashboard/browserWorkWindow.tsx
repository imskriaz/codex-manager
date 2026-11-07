import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardNotice } from '../../src/domain/dashboard/types';

type WorkWindowHost = Window & { documentPictureInPicture?: { requestWindow(options: { width: number; height: number }): Promise<Window> } };

/** A separate monitor keeps the main workspace and its drafts in their original document. */
export function BrowserWorkWindow(props: { path: string; buttonTarget: HTMLElement | null; onFeedback: (notice: DashboardNotice) => void }) {
  const [target, setTarget] = useState<HTMLElement>();
  const monitor = useRef<Window>();
  const [opening, setOpening] = useState(false);
  const openingNow = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; monitor.current?.close(); }; }, []);
  const open = async () => {
    if (monitor.current && !monitor.current.closed) { monitor.current.focus(); return; }
    if (openingNow.current) return;
    openingNow.current = true;
    setOpening(true);
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const api = (window as WorkWindowHost).documentPictureInPicture;
      const request = api ? api.requestWindow({ width: 390, height: 844 })
        : Promise.resolve(window.open('', '_blank', 'popup,width=390,height=844,resizable=yes,scrollbars=yes'));
      void request.then(child => { if (expired || !mounted.current) child?.close(); }, () => undefined);
      const child = await Promise.race([request, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('The work window did not open in time. Retry Keep on top.')); }, 10_000);
      })]);
      if (!child) throw new Error('The work window was blocked. Allow pop-ups for this dashboard and try Keep on top again.');
      if (!mounted.current) { child.close(); return; }
      monitor.current = child;
      child.document.title = 'Codex Manager · Mobile workspace';
      child.document.body.replaceChildren();
      for (const style of document.querySelectorAll('link[rel="stylesheet"], style')) {
        const clone = style.cloneNode(true);
        if (style instanceof HTMLLinkElement) (clone as HTMLLinkElement).href = style.href;
        child.document.head.appendChild(clone);
      }
      child.document.body.className = document.body.className;
      child.document.documentElement.dataset['theme'] = document.documentElement.dataset['theme'];
      child.document.body.style.margin = '0';
      const root = child.document.createElement('main');
      root.className = 'browser-work-monitor';
      Object.assign(root.style, { display: 'flex', flexDirection: 'column', minWidth: '0', maxWidth: '100%', height: '100dvh', margin: '0', boxSizing: 'border-box', background: 'var(--bg-base)', color: 'var(--text-primary)' });
      child.document.body.appendChild(root); setTarget(root);
      child.addEventListener('pagehide', () => { if (monitor.current === child) { monitor.current = undefined; setTarget(undefined); } }, { once: true });
      if (!api) props.onFeedback({ level: 'warning', message: 'Mobile workspace opened. This browser cannot keep it on top. Use desktop Chrome or Edge for Keep on top.' });
    } catch (error) { monitor.current?.close(); if (mounted.current) props.onFeedback({ level: 'warning', message: error instanceof Error ? error.message : 'The work monitor could not open. Retry Keep on top from the conversation header.' }); }
    finally { clearTimeout(timer); openingNow.current = false; if (mounted.current) setOpening(false); }
  };
  return <>{props.buttonTarget ? createPortal(<button type="button" class="cli-icon-button" aria-label="Keep on top" title="Keep on top · full mobile workspace" aria-pressed={Boolean(target)} disabled={opening} onClick={() => void open()}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M13 8h5v5m0-5-7 7"/></svg></button>, props.buttonTarget) : null}{target ? createPortal(<MobileWorkspace path={props.path} onFeedback={props.onFeedback} onBack={() => { window.focus(); monitor.current?.close(); }} />, target) : null}</>;
}

function MobileWorkspace(props: { path: string; onBack: () => void; onFeedback: (notice: DashboardNotice) => void }) {
  // Keep navigation independent when the original window changes conversations.
  const [path] = useState(props.path);
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const fail = (message: string) => { setLoading(false); setError(message); props.onFeedback({ level: 'warning', message }); };
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => fail('Mobile workspace is taking longer to load. Check the connection or retry loading.'), 15_000);
    return () => clearTimeout(timer);
  }, [attempt, loading]);
  const loaded = () => {
    try {
      if (!frame.current?.contentDocument?.querySelector('#app, form')) throw new Error('Workspace document unavailable');
      setLoading(false); setError('');
    } catch { fail('Mobile workspace could not load. Check the connection or retry loading.'); }
  };
  return <><header><strong>Mobile workspace</strong><button type="button" onClick={props.onBack}>Back to workspace</button></header>
    {loading ? <p role="status">Loading mobile workspace…</p> : null}
    {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => {
      setError(''); setLoading(true); setAttempt(value => value + 1);
      try { frame.current?.contentWindow?.location.reload(); } catch { fail('Mobile workspace could not reload. Close this window and retry Keep on top.'); }
    }}>Retry loading</button></div> : null}
    <iframe ref={frame} src={path} title="Codex Manager mobile workspace" onLoad={loaded} style={{ display: 'block', flex: '1 1 auto', width: '100%', minHeight: '0', border: '0' }} />
  </>;
}
