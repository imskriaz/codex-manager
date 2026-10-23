import { useAnchoredPopover } from './anchoredPopover';
import type { ComponentChildren } from "preact";
import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";

export function WorkspaceMenu(props: { label: string; icon: ComponentChildren; children: ComponentChildren }) {
  const anchor = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const id = useId(),
    [open, setOpen] = useState(false);
  useAnchoredPopover(open, anchor, panel);
  useLayoutEffect(() => {
    if (!open || !panel.current) {
      return;
    }
    panel.current.querySelector<HTMLElement>("button:not(:disabled),select")?.focus();
  }, [open]);
  return (
    <span class="workspace-tool-menu">
      <button
        type="button"
        ref={anchor}
        aria-label={props.label}
        title={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => panel.current?.togglePopover()}
      >
        {props.icon}
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        role="menu"
        aria-label={props.label}
        class="workspace-menu-popover"
        onToggle={(event) => setOpen((event as ToggleEvent).newState === "open")}
        onClick={(event) => {
          if ((event.target as Element).closest("button")) {
            panel.current?.hidePopover();
            anchor.current?.focus();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            panel.current?.hidePopover();
            anchor.current?.focus();
          } else if (
            !(event.target instanceof HTMLSelectElement) &&
            ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
          ) {
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),select")];
            const index = items.indexOf(document.activeElement as HTMLElement);
            items[
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length
            ]?.focus();
          }
        }}
      >
        {props.children}
      </div>
    </span>
  );
}
