import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { createPortal } from "preact/compat";

const MODAL_FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

export function handleTabKeyDown(event: JSX.TargetedKeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
  const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); tabs[next]?.focus(); tabs[next]?.click();
}

export function useModalAccessibility(open: boolean, onClose: () => void) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const backdropPressedRef = useRef(false);
  const restoreFrameRef = useRef<number | undefined>(undefined);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    if (restoreFrameRef.current !== undefined) window.cancelAnimationFrame(restoreFrameRef.current);

    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = modalRef.current;
    const firstFocusable = modal?.querySelector<HTMLElement>('[autofocus]:not(:disabled)') ?? modal?.querySelector<HTMLElement>(MODAL_FOCUSABLE);
    (firstFocusable ?? modal)?.focus();

    return () => {
      const previouslyFocused = previouslyFocusedRef.current;
      if (previouslyFocused?.isConnected) {
        restoreFrameRef.current = window.requestAnimationFrame(() => {
          restoreFrameRef.current = undefined;
          if (document.activeElement === document.body || modal?.contains(document.activeElement)) previouslyFocused.focus({ preventScroll: true });
        });
      }
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const modal = modalRef.current;
    const focusable = modal
      ? Array.from(modal.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE)).filter(
          (element) => element.getClientRects().length > 0
        )
      : [];
    if (focusable.length === 0) {
      event.preventDefault();
      modal?.focus();
      return;
    }

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    // Removed or disabled controls can leave focus on body. Route keys to the
    // top dialog without refocusing it on every background render.
    const route = (event: KeyboardEvent) => {
      const modal = modalRef.current;
      if (!modal || modal.contains(event.target as Node)) return;
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).filter(dialog => dialog.getClientRects().length > 0);
      if (dialogs.at(-1) === modal) onKeyDown(event);
    };
    document.addEventListener("keydown", route, true);
    return () => document.removeEventListener("keydown", route, true);
  }, [open]);

  const onBackdropPointerDown = (event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    backdropPressedRef.current = event.target === event.currentTarget;
    event.stopPropagation();
  };
  const onBackdropClick = (event: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    event.stopPropagation();
    if (event.target === event.currentTarget && (event.detail === 0 || backdropPressedRef.current)) onCloseRef.current();
    backdropPressedRef.current = false;
  };
  const onBackdropMouseDown = (event: JSX.TargetedMouseEvent<HTMLDivElement>): void => event.stopPropagation();

  return { modalRef, onKeyDown, onBackdropPointerDown, onBackdropClick, onBackdropMouseDown };
}

export function ActionButton(props: {
  class?: string;
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon?: ComponentChildren;
  iconOnly?: boolean;
  label?: string;
  "aria-haspopup"?: "dialog" | "menu";
  "aria-expanded"?: boolean;
  children?: ComponentChildren;
}) {
  const className = [props.class, "action-btn", props.pending ? "is-pending" : "", props.iconOnly ? "icon-only" : ""]
    .filter(Boolean)
    .join(" ");
  const accessibleLabel =
    props.label ??
    (typeof props.children === "string"
      ? props.children
      : typeof props.children === "number"
        ? String(props.children)
        : undefined);

  return (
    <button
      class={className}
      type="button"
      disabled={props.disabled}
      aria-busy={props.pending}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      aria-haspopup={props["aria-haspopup"]}
      aria-expanded={props["aria-expanded"]}
      onClick={props.onClick}
    >
      <span class="button-face">
        {props.pending ? <span class="button-spinner" aria-hidden="true"></span> : null}
        {!props.pending && props.icon ? <span class="button-icon" aria-hidden="true">{props.icon}</span> : null}
        {!props.iconOnly ? <span class="button-label">{props.children}</span> : null}
      </span>
    </button>
  );
}

export function TaskDetailPanel(props: { open: boolean; title: string; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(props.onClose); closeRef.current = props.onClose;
  useLayoutEffect(() => {
    if (!props.open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    ref.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected && (document.activeElement === document.body || ref.current?.contains(document.activeElement))) previous.focus({ preventScroll: true }); };
  }, [props.open]);
  if (!props.open) return null;
  return createPortal(<aside ref={ref} class="task-detail-panel task-detail-modal" aria-label={props.title} tabIndex={-1} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); } }}>
    <header class="settings-modal-head"><strong class="settings-modal-title">{props.title}</strong><button type="button" class="settings-close" aria-label="Close task details" onClick={props.onClose}>×</button></header>
    <div class="task-detail-panel-body">{props.children}</div>
  </aside>, document.body);
}

export function ModalShell(props: {
  open: boolean;
  title: string;
  closeLabel: string;
  className?: string;
  closeDisabled?: boolean;
  closeOnBackdrop?: boolean;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const accessibility = useModalAccessibility(props.open, () => { if (!props.closeDisabled) props.onClose(); });
  if (!props.open) return null;

  return createPortal(
    <div
      class={`overlay ${props.open ? "open" : ""}`}
      aria-hidden={!props.open}
      onPointerDown={accessibility.onBackdropPointerDown}
      onMouseDown={accessibility.onBackdropMouseDown}
      onClick={(event) => { if (props.closeOnBackdrop === false) event.stopPropagation(); else accessibility.onBackdropClick(event); }}
    >
      <div
        ref={accessibility.modalRef}
        class={`settings-modal dashboard-modal ${props.className ?? ""}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        onKeyDown={accessibility.onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div class="settings-modal-head">
          <div class="settings-modal-title">{props.title}</div>
          <button class="settings-close" type="button" aria-label={props.closeLabel} disabled={props.closeDisabled} onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="settings-modal-body dashboard-modal-body">{props.children}</div>
      </div>
    </div>, document.body
  );
}
