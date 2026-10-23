import { useLayoutEffect } from 'preact/hooks';

type Anchor = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;
export function anchoredPopoverPosition(anchor: Anchor, menu: { width: number; height: number }, viewport: { left: number; top: number; width: number; height: number }, align: 'start' | 'end' = 'end') {
  const { left: x, top: y, width, height } = viewport;
  const below = y + height - anchor.bottom - 6, above = anchor.top - y - 6;
  const opensAbove = menu.height > below && above > below;
  return {
    left: Math.max(x + 8, Math.min(align === 'start' ? anchor.left : anchor.right - menu.width, x + width - menu.width - 8)),
    top: Math.max(y + 8, Math.min(opensAbove ? anchor.top - menu.height - 6 : anchor.bottom + 6, y + height - menu.height - 8)),
    opensAbove
  };
}

/** Keep flyouts beside their trigger as content, scroll and the mobile keyboard change. */
export function useAnchoredPopover(open: boolean, anchor: { current?: Pick<HTMLElement, 'isConnected' | 'getBoundingClientRect'> | null }, panel: { current?: HTMLElement | null }, align: 'start' | 'end' = 'end') {
  useLayoutEffect(() => {
    const menu = panel.current;
    if (!open || !menu) return;
    if (menu.popover === 'manual' && !menu.matches(':popover-open')) menu.showPopover?.();
    const place = () => {
      const trigger = anchor.current;
      if (!trigger?.isConnected) { menu.style.visibility = 'hidden'; return; }
      const viewport = window.visualViewport;
      const bounds = { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight };
      Object.assign(menu.style, { boxSizing: 'border-box', position: 'fixed', margin: '0', right: 'auto', bottom: 'auto', minWidth: '0', maxWidth: `${Math.max(0, bounds.width - 16)}px`, maxHeight: `${Math.max(0, bounds.height - 16)}px`, overflowY: 'auto' });
      const rect = trigger.getBoundingClientRect(), size = menu.getBoundingClientRect();
      const position = anchoredPopoverPosition(rect, size, bounds, align);
      Object.assign(menu.style, { left: `${position.left}px`, top: `${position.top}px`, visibility: 'visible' });
      menu.dataset['placement'] = position.opensAbove ? 'above' : 'below';
      menu.style.setProperty('--popover-arrow-left', `${Math.max(14, Math.min(size.width - 14, (rect.left + rect.right) / 2 - position.left))}px`);
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(menu); if (anchor.current instanceof Element) observer.observe(anchor.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place); };
  }, [open, align]);
}
