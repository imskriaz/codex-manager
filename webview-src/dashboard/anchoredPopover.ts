import { useLayoutEffect } from 'preact/hooks';

type Anchor = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;
export function anchoredPopoverPosition(anchor: Anchor, menu: { width: number; height: number }, viewport: { left: number; top: number; width: number; height: number }, align: 'start' | 'center' | 'end' = 'end', attached = false) {
  const { left: x, top: y, width, height } = viewport;
  const gap = attached ? 0 : 6, margin = attached ? 0 : 8;
  const below = y + height - anchor.bottom - gap, above = anchor.top - y - gap;
  const opensAbove = menu.height > below && above > below;
  return {
    left: Math.max(x + margin, Math.min(align === 'start' ? anchor.left : align === 'center' ? (anchor.left + anchor.right - menu.width) / 2 : anchor.right - menu.width, x + width - menu.width - margin)),
    top: Math.max(y + 8, Math.min(opensAbove ? anchor.top - menu.height - gap : anchor.bottom + gap, y + height - menu.height - 8)),
    opensAbove
  };
}

/** Keep flyouts beside their trigger as content, scroll and the mobile keyboard change. */
export function useAnchoredPopover(open: boolean, anchor: { current?: Pick<HTMLElement, 'isConnected' | 'getBoundingClientRect'> | null }, panel: { current?: HTMLElement | null }, align: 'start' | 'center' | 'end' = 'end', attached = false) {
  useLayoutEffect(() => {
    const menu = panel.current;
    if (!open || !menu) return;
    if (menu.popover === 'manual' && !menu.matches(':popover-open')) menu.showPopover?.();
    const place = () => {
      const trigger = anchor.current;
      if (!trigger?.isConnected) { menu.style.visibility = 'hidden'; return; }
      const viewport = window.visualViewport;
      const zoom = Number(document.body.style.zoom) || 1;
      const bounds = { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight };
      Object.assign(menu.style, { boxSizing: 'border-box', position: 'fixed', margin: '0', right: 'auto', bottom: 'auto', minWidth: '0', maxWidth: `${Math.max(0, bounds.width - 16) / zoom}px`, maxHeight: `${Math.max(0, bounds.height - 16) / zoom}px`, overflowY: 'auto' });
      const rect = trigger.getBoundingClientRect();
      if (attached) menu.style.width = `${rect.width / zoom}px`;
      const size = menu.getBoundingClientRect();
      const position = anchoredPopoverPosition(rect, size, bounds, align, attached);
      Object.assign(menu.style, { left: `${position.left / zoom}px`, top: `${position.top / zoom}px`, visibility: 'visible' });
      menu.dataset['placement'] = position.opensAbove ? 'above' : 'below';
      menu.style.setProperty('--popover-arrow-left', `${Math.max(14, Math.min(size.width - 14, (rect.left + rect.right) / 2 - position.left)) / zoom}px`);
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(menu); if (anchor.current instanceof Element) observer.observe(anchor.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place); };
  }, [open, align, attached]);
}
