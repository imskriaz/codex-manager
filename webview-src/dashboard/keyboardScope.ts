/** Capture-phase dashboard handlers must leave terminal controls to the terminal. */
export function isWorkspaceTerminalKeyboardEvent(event: Event): boolean {
  return event.target instanceof Element && Boolean(event.target.closest(".workspace-terminal-screen"));
}
