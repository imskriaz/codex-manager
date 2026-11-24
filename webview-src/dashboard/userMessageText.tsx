import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

export function UserMessageText({ text }: { text: string }) {
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * 8 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return <div class="cli-session-message-text">
    <div id={id} class={`cli-user-message-preview${expanded ? ' is-expanded' : ''}`}>
      <div ref={content}>{text}</div>
    </div>
    {overflowing ? <button type="button" class="cli-user-message-toggle" aria-controls={id} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show more'}</button> : null}
  </div>;
}
