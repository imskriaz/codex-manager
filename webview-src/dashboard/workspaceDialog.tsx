import type { ComponentChildren } from "preact";
import { ModalShell } from "./primitives";

export function WorkspaceDialog(props: {
  title: string;
  subtitle?: string;
  className?: string;
  onClose: () => void;
  footer: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <ModalShell
      open
      title={props.title}
      closeLabel={`Close ${props.title}`}
      className={props.className ?? "workspace-action-modal"}
      onClose={props.onClose}
    >
      {props.subtitle ? <p class="workspace-dialog-description">{props.subtitle}</p> : null}
      <div class="workspace-dialog-fields">{props.children}</div>
      <footer class="workspace-dialog-footer">{props.footer}</footer>
    </ModalShell>
  );
}
