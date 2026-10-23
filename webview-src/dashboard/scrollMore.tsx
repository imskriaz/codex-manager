import { useEffect, useRef } from 'preact/hooks';

/** Observe the clipped list edge; each rendered batch can advance only once. */
export function ScrollMore(props: { remaining: number; onMore: () => void; label?: string }) {
  const element = useRef<HTMLDivElement>(null), more = useRef(props.onMore), advanced = useRef(false);
  more.current = props.onMore;
  useEffect(() => {
    advanced.current = false;
    if (!element.current || props.remaining <= 0 || typeof IntersectionObserver === 'undefined') return;
    let stopped = false;
    const observer = new IntersectionObserver(entries => {
      if (!stopped && !advanced.current && !element.current?.contains(document.activeElement) && entries.some(entry => entry.isIntersecting)) {
        advanced.current = true;
        more.current();
      }
    }, { rootMargin: '0px 0px 120px 0px' });
    observer.observe(element.current);
    return () => { stopped=true; observer.disconnect(); };
  }, [props.remaining]);
  return props.remaining > 0 ? <div ref={element} class="scroll-more" role="status"><button type="button" onClick={() => { if (!advanced.current) { advanced.current=true; more.current(); } }}>{props.label ?? 'Load more'} <small>({props.remaining})</small></button></div> : null;
}
