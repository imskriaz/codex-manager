import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

const MODAL_FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

export function useModalAccessibility(open: boolean, onClose: () => void) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }

    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      const modal = modalRef.current;
      const firstFocusable = modal?.querySelector<HTMLElement>(MODAL_FOCUSABLE);
      (firstFocusable ?? modal)?.focus();
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      const previouslyFocused = previouslyFocusedRef.current;
      if (previouslyFocused?.isConnected) {
        window.requestAnimationFrame(() => previouslyFocused.focus());
      }
    };
  }, [open]);

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>): void => {
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

  return { modalRef, onKeyDown };
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

export function ModalShell(props: {
  open: boolean;
  title: string;
  closeLabel: string;
  className?: string;
  closeOnBackdrop?: boolean;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const accessibility = useModalAccessibility(props.open, props.onClose);

  return (
    <div
      class={`overlay ${props.open ? "open" : ""}`}
      aria-hidden={!props.open}
      onClick={props.closeOnBackdrop === false ? undefined : props.onClose}
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
          <button class="settings-close" type="button" aria-label={props.closeLabel} onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="settings-modal-body dashboard-modal-body">{props.children}</div>
      </div>
    </div>
  );
}
