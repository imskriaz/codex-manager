import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { DashboardNotice } from '../../src/domain/dashboard/types';

type WorkWindowHost = Window & { documentPictureInPicture?: { requestWindow(options: { width: number; height: number }): Promise<Window> } };

/** A separate monitor keeps the main workspace and its drafts in their original document. */
export function BrowserWorkWindow(props: { title: string; children: ComponentChildren; onFeedback: (notice: DashboardNotice) => void }) {
  const [target, setTarget] = useState<HTMLElement>();
  const monitor = useRef<Window>();
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; monitor.current?.close(); }; }, []);
  const open = async () => {
    if (monitor.current && !monitor.current.closed) { monitor.current.focus(); return; }
    setOpening(true);
    try {
      const api = (window as WorkWindowHost).documentPictureInPicture;
      const child = api ? await api.requestWindow({ width: 360, height: 540 })
        : window.open('', 'codex-work-monitor', 'popup,width=360,height=540,resizable=yes,scrollbars=yes');
      if (!child) throw new Error('The work window was blocked. Allow pop-ups for this dashboard and try Keep on top again.');
      if (!mounted.current) { child.close(); return; }
      monitor.current = child;
      child.document.title = 'Codex Manager · Work monitor';
      child.document.body.replaceChildren();
      for (const style of document.querySelectorAll('link[rel="stylesheet"], style')) child.document.head.appendChild(style.cloneNode(true));
      child.document.body.className = document.body.className;
      child.document.documentElement.dataset['theme'] = document.documentElement.dataset['theme'];
      const root = child.document.createElement('main'); root.className = 'browser-work-monitor';
      child.document.body.appendChild(root); setTarget(root);
      child.addEventListener('pagehide', () => { if (monitor.current === child) { monitor.current = undefined; setTarget(undefined); } }, { once: true });
      if (!api) props.onFeedback({ level: 'warning', message: 'Work monitor opened. This browser cannot keep it on top. Use desktop Chrome or Edge for Keep on top.' });
    } catch (error) { if (mounted.current) props.onFeedback({ level: 'warning', message: error instanceof Error ? error.message : 'The work monitor could not open. Retry Keep on top from the conversation header.' }); }
    finally { if (mounted.current) setOpening(false); }
  };
  return <><button type="button" class="cli-icon-button" aria-label="Keep on top" title="Keep on top · live work monitor" disabled={opening} onClick={() => void open()}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M13 8h5v5m0-5-7 7"/></svg></button>{target ? createPortal(<><header><strong>{props.title}</strong><button type="button" onClick={() => { window.focus(); monitor.current?.close(); }}>Back to workspace</button></header>{props.children}</>, target) : null}</>;
}
