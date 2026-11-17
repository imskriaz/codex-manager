import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useAnchoredPopover } from "./anchoredPopover";

type Choice = { id: string; label: string; detail?: string; group?: string };

export function ApiChoicePicker(props: {
  label: string;
  value: string;
  choices: Choice[];
  disabled?: boolean;
  placeholder?: string;
  onChange: (id: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const selected = props.choices.find((choice) => choice.id === props.value);
  const matches = props.choices.filter((choice) =>
    `${choice.label} ${choice.detail ?? ""} ${choice.group ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())
  );
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
  const close = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  const choose = (choice: Choice) => {
    if (props.disabled || !props.choices.some((item) => item.id === choice.id)) return;
    props.onChange(choice.id);
    close(true);
  };
  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);
  useAnchoredPopover(open, trigger, panel, "start");
  useLayoutEffect(() => {
    if (!open) return;
    const dropdown = panel.current;
    if (dropdown)
      dropdown.style.width = `${Math.max(300, trigger.current?.getBoundingClientRect().width ?? 0) / (Number(document.body.style.zoom) || 1)}px`;
    search.current?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (!dropdown?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (open) panel.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, query]);
  const show = () => {
    setQuery("");
    setActive(
      Math.max(
        0,
        props.choices.findIndex((choice) => choice.id === props.value)
      )
    );
    setOpen(true);
  };
  return (
    <div class="api-choice-field">
      <label for={id}>{props.label}</label>
      <button
        ref={trigger}
        id={id}
        type="button"
        class="api-choice-trigger"
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        disabled={props.disabled}
        title={selected ? [selected.label, selected.detail].filter(Boolean).join(" · ") : props.placeholder}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
          }
        }}
      >
        <span>
          <strong>{selected?.label ?? props.placeholder ?? "Choose an option"}</strong>
          {selected?.detail ? <small>{selected.detail}</small> : null}
        </span>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m5 8 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>
      {open ? (
        <div
          ref={panel}
          class="api-choice-popover"
          popover="manual"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(
                (current) =>
                  (Math.min(current, Math.max(0, matches.length - 1)) +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    Math.max(1, matches.length)) %
                  Math.max(1, matches.length)
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              const choice = matches[activeIndex];
              if (choice) choose(choice);
            } else if (event.key === "Tab") close();
          }}
        >
          <input
            ref={search}
            type="search"
            role="combobox"
            aria-label={`Search ${props.label.toLowerCase()}`}
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={matches.length ? `${id}-option-${activeIndex}` : undefined}
            value={query}
            placeholder={`Search ${props.label.toLowerCase()}…`}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
          />
          <div class="api-choice-options" id={`${id}-list`} role="listbox" aria-label={`${props.label} choices`}>
            {matches.map((choice, index) => (
              <div key={choice.id}>
                {choice.group && (index === 0 || matches[index - 1]?.group !== choice.group) ? (
                  <div class="api-choice-group">{choice.group}</div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  id={`${id}-option-${index}`}
                  aria-selected={choice.id === props.value}
                  data-active={index === activeIndex}
                  tabIndex={-1}
                  onMouseMove={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(choice)}
                >
                  <span>
                    <strong>{choice.label}</strong>
                    {choice.detail ? <small>{choice.detail}</small> : null}
                  </span>
                  {choice.id === props.value ? <span aria-hidden="true">✓</span> : null}
                </button>
              </div>
            ))}
            {!matches.length ? <p role="status">No matching {props.label.toLowerCase()}.</p> : null}
          </div>
          <small class="api-choice-count">
            {matches.length} of {props.choices.length} · ↑ ↓ to navigate · Enter to select
          </small>
        </div>
      ) : null}
    </div>
  );
}
