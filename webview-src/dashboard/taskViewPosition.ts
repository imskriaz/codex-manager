import { useLayoutEffect, useRef } from 'preact/hooks';
import { readBrowserCache, writeBrowserCache } from './cliSessionCache';

/** Restore only before interaction; a late cache read must not move the reader. */
export function useTaskViewPosition(key: string | undefined, parent = false) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = parent ? ref.current?.closest<HTMLElement>('.task-detail-panel-body') : ref.current;
    if (!key || !element) return;
    let disposed = false, touched = false;
    let offset = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    element.scrollTop = 0;
    const scroll = () => { offset = element.scrollTop; if (touched) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); } };
    element.addEventListener('scroll', scroll, { passive: true });
    let observer: ResizeObserver | undefined;
    let expired = false;
    const deadline = setTimeout(() => { expired = true; observer?.disconnect(); }, 2000);
    const touch = () => { touched = true; observer?.disconnect(); };
    const save = () => { if (touched) void writeBrowserCache(key, offset); };
    element.addEventListener('wheel', touch, { passive: true });
    element.addEventListener('touchstart', touch, { passive: true });
    element.addEventListener('keydown', touch);
    element.addEventListener('pointerdown', touch);
    const visibility = () => { if (document.hidden) save(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', save);
    void readBrowserCache<number>(key).then(value => {
      if (!disposed && !touched && !expired && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        const restore = () => { if (!disposed && !touched) element.scrollTop = value; };
        restore();
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(restore);
          for (const child of element.children) observer.observe(child);
        }
      }
    });
    return () => {
      disposed = true; clearTimeout(saveTimer); element.removeEventListener('scroll', scroll); clearTimeout(deadline); observer?.disconnect(); save();
      element.removeEventListener('wheel', touch); element.removeEventListener('touchstart', touch);
      element.removeEventListener('keydown', touch); element.removeEventListener('pointerdown', touch);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', save);
    };
  }, [key, parent]);
  return ref;
}
